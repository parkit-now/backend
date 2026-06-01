import { HttpStatus, Injectable } from '@nestjs/common';
import type { Company, Prisma, User } from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CompanyProfileDto } from '../onboarding/dto/company-profile.dto';
import { toCompanyProfileDto } from '../onboarding/onboarding.mappers';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { AuditEventDto } from '../audit/dto/audit-event.dto';
import { toPaymentMethodDto, toBranchDto } from './companies.mappers';
import { CompanyAuditQueryDto } from './dto/company-audit-query.dto';
import { PaymentMethodSummaryDto, BranchDto } from './dto/company-config.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { TogglePaymentMethodDto } from './dto/toggle-payment-method.dto';
import { UpdateCompanyProfileDto } from './dto/update-company-profile.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Profile of the authenticated owner's company (no status gate). */
  async getMyProfile(user: User): Promise<CompanyProfileDto> {
    const company = await this.prisma.company.findFirst({
      where: { ownerUserId: user.id },
    });
    if (!company) {
      throw this.notFound();
    }
    return toCompanyProfileDto(company);
  }

  async updateProfile(
    company: Company,
    user: User,
    dto: UpdateCompanyProfileDto,
  ): Promise<CompanyProfileDto> {
    this.assertActive(company);

    const data: Prisma.CompanyUpdateInput = {};
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;

    const updated = await this.prisma.company.update({
      where: { id: company.id },
      data,
    });
    await this.audit.record({
      action: AuditActions.COMPANY_PROFILE_UPDATED,
      entityType: 'company',
      entityId: company.id,
      actorUserId: user.id,
      companyId: company.id,
    });
    return toCompanyProfileDto(updated);
  }

  async listBranches(company: Company): Promise<BranchDto[]> {
    this.assertActive(company);
    const tenants = await this.prisma.tenant.findMany({
      where: { companyId: company.id },
      include: { zones: true },
      orderBy: { createdAt: 'asc' },
    });
    return tenants.map(toBranchDto);
  }

  async createBranch(
    company: Company,
    user: User,
    dto: CreateBranchDto,
  ): Promise<BranchDto> {
    this.assertActive(company);

    const tenant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: {
          name: dto.name,
          address: dto.address ?? null,
          status: 'active',
          companyId: company.id,
        },
      });
      // The owner gains access to the branch via UserMembership (existing infra).
      await tx.userMembership.create({
        data: { userId: company.ownerUserId, tenantId: created.id },
      });
      await tx.auditLog.create({
        data: {
          action: AuditActions.BRANCH_CREATED,
          entityType: 'tenant',
          entityId: created.id,
          actorUserId: user.id,
          companyId: company.id,
        },
      });
      return created;
    });

    return toBranchDto({ ...tenant, zones: [] });
  }

  async updateBranch(
    company: Company,
    user: User,
    tenantId: string,
    dto: UpdateBranchDto,
  ): Promise<BranchDto> {
    this.assertActive(company);

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, companyId: company.id },
    });
    if (!tenant) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Branch ${tenantId} not found in this company`,
        '/companies/branches',
        ErrorCodes.BRANCH_NOT_FOUND,
      );
    }

    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.status !== undefined) data.status = dto.status;

    await this.prisma.tenant.update({ where: { id: tenantId }, data });
    await this.audit.record({
      action: AuditActions.BRANCH_UPDATED,
      entityType: 'tenant',
      entityId: tenantId,
      actorUserId: user.id,
      companyId: company.id,
    });

    const withZones = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { zones: true },
    });
    return toBranchDto(withZones);
  }

  async listPaymentMethods(
    company: Company,
  ): Promise<PaymentMethodSummaryDto[]> {
    this.assertActive(company);
    const methods = await this.prisma.paymentMethod.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: 'asc' },
    });
    return methods.map(toPaymentMethodDto);
  }

  async togglePaymentMethod(
    company: Company,
    user: User,
    paymentMethodId: string,
    dto: TogglePaymentMethodDto,
  ): Promise<PaymentMethodSummaryDto> {
    this.assertActive(company);

    const method = await this.prisma.paymentMethod.findFirst({
      where: { id: paymentMethodId, companyId: company.id },
    });
    if (!method) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Payment method ${paymentMethodId} not found in this company`,
        '/companies/payment-methods',
        ErrorCodes.PAYMENT_METHOD_NOT_FOUND,
      );
    }

    const updated = await this.prisma.paymentMethod.update({
      where: { id: paymentMethodId },
      data: { enabled: dto.enabled },
    });
    await this.audit.record({
      action: AuditActions.PAYMENT_METHOD_TOGGLED,
      entityType: 'payment_method',
      entityId: paymentMethodId,
      actorUserId: user.id,
      companyId: company.id,
      metadata: { enabled: dto.enabled },
    });
    return toPaymentMethodDto(updated);
  }

  async listAudit(
    company: Company,
    query: CompanyAuditQueryDto,
  ): Promise<AuditEventDto[]> {
    this.assertActive(company);
    return this.audit.listForCompany(company.id, {
      limit: query.limit,
      severity: query.severity,
    });
  }

  private assertActive(company: Company): void {
    if (company.status === 'suspended') {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Company is suspended',
        '/companies',
        ErrorCodes.COMPANY_SUSPENDED,
      );
    }
    if (company.status !== 'active') {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'Company is not active yet',
        '/companies',
        ErrorCodes.COMPANY_NOT_ACTIVE,
      );
    }
  }

  private notFound(): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      'Company not found for this user',
      '/companies/me',
      ErrorCodes.COMPANY_NOT_FOUND,
    );
  }
}
