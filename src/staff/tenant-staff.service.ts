import { HttpStatus, Injectable } from '@nestjs/common';
import {
  MembershipRole,
  Prisma,
  Tenant,
  User,
  UserMembership,
} from '@prisma/client';
import { AuditActions, AuditService } from '../audit/audit.service';
import { PermissionsService } from '../auth/permissions.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { FormattedException } from '../utils/exceptions/http-exception/formatted-exeption';
import { normalizeEmail } from '../utils/text/normalize-email';
import { CreateStaffMemberDto } from './dto/create-staff-member.dto';
import { StaffMembershipResultDto } from './dto/staff-membership-result.dto';
import { UpdateStaffMemberDto } from './dto/update-staff-member.dto';

const INSTANCE = '/tenants/:tenantId/staff';

type MembershipWithTenant = UserMembership & { tenant: Tenant };

function toResultDto(
  person: User,
  membership: MembershipWithTenant,
): StaffMembershipResultDto {
  return {
    userId: person.id,
    name: person.name,
    email: person.email,
    globalRole: person.role,
    tenantId: membership.tenantId,
    tenantName: membership.tenant.name,
    role: membership.role,
    createdAt: membership.createdAt,
  };
}

/**
 * ABM de empleados hecho por el dueño de un estacionamiento.
 *
 * Complemento de escritura de `StaffService`, que es la lectura. Viven en
 * archivos separados a propósito: aquél documenta como invariante que no está
 * detrás de `TenantMembershipGuard` y que su autorización entera vive en
 * `resolveScope`. Acá pasa lo contrario — el guard ya validó que el caller es
 * `owner` del `:tenantId` de la URL antes de que se ejecute una sola línea de
 * este archivo.
 *
 * Lo que el guard NO cubre, y este service sí:
 *   - el lote DESTINO de una mudanza, que no está en la URL (`assertCanManage`);
 *   - que nadie se modifique a sí mismo (self-guard);
 *   - que un lote nunca quede sin owner (last-owner-guard).
 *
 * `UserMembership` está deliberadamente fuera de `TENANT_MODELS` (ver la nota en
 * `prisma-tenant.ts`), así que `getTenantClient()` no lo filtraría: se usa el
 * cliente plano y el scoping por tenant es responsabilidad explícita de cada
 * query de acá. Por eso todas van por la PK compuesta `userId_tenantId` y no
 * hay un solo `updateMany`/`deleteMany` en el archivo.
 */
@Injectable()
export class TenantStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Suma a una persona ya registrada al lote de la URL.
   *
   * Sin transacción a propósito: el alta sólo agrega, no puede romper el
   * invariante de last-owner, y son dos writes independientes (mismo criterio
   * que `AdminUsersService.addMembership`).
   */
  async addStaff(
    caller: User,
    tenantId: string,
    dto: CreateStaffMemberDto,
  ): Promise<StaffMembershipResultDto> {
    // El `@Transform` del DTO ya normalizó, pero el service es llamable sin
    // pasar por el pipe (los specs lo hacen): misma regla, un solo lugar.
    const email = normalizeEmail(dto.email);

    // `findFirst` + `insensitive` y no `findUnique`: `public.users.email` se
    // copia verbatim de `auth.users.email` en el trigger de provisioning.
    // GoTrue normaliza a minúsculas, pero eso no es una garantía nuestra y el
    // índice único de Postgres SÍ distingue mayúsculas — una cuenta guardada
    // como `Ana@Example.com` daría un 404 imposible de explicarle al dueño.
    // El `orderBy` sólo hace determinístico el desempate si alguna vez
    // existieran dos filas que difieren nada más que en mayúsculas.
    const person = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    });

    if (!person) {
      // Se acepta que esto sea un oráculo de existencia de cuentas para
      // cualquier owner autenticado: es la contracara de dar de alta por mail
      // en vez de exponer un listado del padrón, que sería bastante peor.
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `No account is registered with email ${email}`,
        INSTANCE,
        ErrorCodes.USER_NOT_FOUND,
      );
    }

    // Un `person.role === 'admin'` se acepta sin caso especial: rechazarlo
    // convertiría el endpoint en un oráculo para enumerar admins de plataforma.
    // La membresía queda inerte (el admin ya bypassea todo) pero visible en
    // `GET /me/staff`, que es informativo y correcto.

    const existing = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId: person.id, tenantId } },
    });
    if (existing) {
      throw this.alreadyExists(person.id, tenantId);
    }

    let membership: MembershipWithTenant;
    try {
      membership = await this.prisma.userMembership.create({
        data: { userId: person.id, tenantId, role: dto.role },
        include: { tenant: true },
      });
    } catch (error) {
      // Dos owners dando de alta a la misma persona a la vez: el chequeo de
      // arriba pasó en ambos y la PK compuesta frena al segundo.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.alreadyExists(person.id, tenantId);
      }
      throw error;
    }

    await this.audit.record({
      action: AuditActions.MEMBERSHIP_CREATED,
      entityType: 'user_membership',
      entityId: person.id,
      actorUserId: caller.id,
      tenantId,
      metadata: { role: dto.role, email },
    });

    return toResultDto(person, membership);
  }

  /**
   * Cambia el rol de un empleado y/o lo muda a otro lote del mismo dueño.
   *
   * El orden de las validaciones importa: las que no tocan la DB van primero, y
   * la ownership del destino se chequea antes que su existencia para no filtrar
   * qué tenants existen.
   */
  async updateStaff(
    caller: User,
    tenantId: string,
    userId: string,
    dto: UpdateStaffMemberDto,
  ): Promise<StaffMembershipResultDto> {
    this.assertNotSelf(caller, userId);

    const current = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: { tenant: true, user: true },
    });
    if (!current) {
      throw this.membershipNotFound(userId, tenantId);
    }

    const targetTenantId = dto.tenantId ?? tenantId;
    const isMove = targetTenantId !== tenantId;
    const nextRole = dto.role ?? current.role;

    // Nada que hacer: se devuelve el estado actual sin escribir ni auditar, en
    // vez de un 400. Un PATCH idempotente le ahorra al front tener que
    // comparar antes de mandar.
    if (!isMove && nextRole === current.role) {
      return toResultDto(current.user, current);
    }

    if (isMove) {
      await this.assertCanManage(caller, targetTenantId);

      const occupied = await this.prisma.userMembership.findUnique({
        where: { userId_tenantId: { userId, tenantId: targetTenantId } },
      });
      if (occupied) {
        // Ya trabaja en el destino. Sumar un lote conservando el actual se hace
        // con `POST /tenants/<destino>/staff`, no mudando.
        throw this.alreadyExists(userId, targetTenantId);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Degradar o mudar al último owner deja el lote de origen sin dueño.
      if (
        current.role === MembershipRole.owner &&
        (nextRole !== MembershipRole.owner || isMove)
      ) {
        await this.assertNotLastOwner(tx, tenantId);
      }

      // UN solo UPDATE, no delete + create: `tenantId` es escribible en
      // `UserMembershipUncheckedUpdateInput`, así que mudar es un
      // `UPDATE SET tenant_id = …` que conserva `createdAt` —la antigüedad de
      // la persona— sin esfuerzo y sin re-insertar la PK.
      const row = await tx.userMembership.update({
        where: { userId_tenantId: { userId, tenantId } },
        data: {
          ...(isMove ? { tenantId: targetTenantId } : {}),
          ...(dto.role ? { role: dto.role } : {}),
        },
        include: { tenant: true, user: true },
      });

      if (isMove) {
        // DOS registros, no uno: `audit_log.tenant_id` es el filtro de
        // `AuditService.listForTenant`, así que con una sola fila uno de los
        // dos dueños nunca se enteraría del movimiento. Desde cada lote el
        // evento ES una baja y un alta; el metadata los correlaciona.
        await tx.auditLog.create({
          data: {
            action: AuditActions.MEMBERSHIP_DELETED,
            entityType: 'user_membership',
            entityId: userId,
            actorUserId: caller.id,
            tenantId,
            metadata: { movedTo: targetTenantId, role: current.role },
          },
        });
        await tx.auditLog.create({
          data: {
            action: AuditActions.MEMBERSHIP_CREATED,
            entityType: 'user_membership',
            entityId: userId,
            actorUserId: caller.id,
            tenantId: targetTenantId,
            metadata: {
              movedFrom: tenantId,
              role: nextRole,
              previousRole: current.role,
            },
          },
        });
      } else {
        await tx.auditLog.create({
          data: {
            action: AuditActions.MEMBERSHIP_UPDATED,
            entityType: 'user_membership',
            entityId: userId,
            actorUserId: caller.id,
            tenantId,
            metadata: { role: nextRole, previousRole: current.role },
          },
        });
      }

      return row;
    });

    return toResultDto(updated.user, updated);
  }

  /** Saca a una persona del lote de la URL. Su cuenta no se toca. */
  async removeStaff(
    caller: User,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    this.assertNotSelf(caller, userId);

    const current = await this.prisma.userMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!current) {
      throw this.membershipNotFound(userId, tenantId);
    }

    await this.prisma.$transaction(async (tx) => {
      if (current.role === MembershipRole.owner) {
        await this.assertNotLastOwner(tx, tenantId);
      }

      await tx.userMembership.delete({
        where: { userId_tenantId: { userId, tenantId } },
      });

      await tx.auditLog.create({
        data: {
          action: AuditActions.MEMBERSHIP_DELETED,
          entityType: 'user_membership',
          entityId: userId,
          actorUserId: caller.id,
          tenantId,
          metadata: { role: current.role },
        },
      });
    });
  }

  /**
   * Nadie se gestiona a sí mismo, admin global incluido.
   *
   * Evita que un dueño se auto-degrade o se auto-borre y pierda el acceso a su
   * propia playa. Un admin que igual quiera hacerlo tiene
   * `/admin/users/:id/memberships`; acá es una sola regla sin excepciones.
   */
  private assertNotSelf(caller: User, userId: string): void {
    if (userId === caller.id) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        'You cannot change or remove your own membership',
        INSTANCE,
        ErrorCodes.STAFF_SELF_MANAGEMENT,
      );
    }
  }

  /**
   * El caller tiene que poder administrar el lote DESTINO de una mudanza.
   *
   * El guard sólo validó el `:tenantId` de la URL. Se re-lee el membership en
   * el momento de la acción, como hace `MpAccountsService.handleCallback`.
   *
   * El orden es deliberado: la ownership se chequea ANTES que la existencia del
   * tenant. Un lote que no existe tampoco tiene membership, así que cae en el
   * mismo 403 y el endpoint no sirve para averiguar qué tenants existen. El 404
   * de abajo sólo lo alcanza un admin global, para el que `canManageEntity` da
   * true con `membership = null` y sin él el FK explotaría como un 500.
   */
  private async assertCanManage(
    caller: User,
    targetTenantId: string,
  ): Promise<void> {
    const membership = await this.prisma.userMembership.findUnique({
      where: {
        userId_tenantId: { userId: caller.id, tenantId: targetTenantId },
      },
    });

    if (!this.permissions.canManageEntity(caller, membership)) {
      throw new FormattedException(
        'Forbidden',
        HttpStatus.FORBIDDEN,
        `User does not own tenant: ${targetTenantId}`,
        INSTANCE,
        ErrorCodes.ENTITY_NO_ACCESS,
      );
    }

    const exists = await this.prisma.tenant.findUnique({
      where: { id: targetTenantId },
      select: { id: true },
    });
    if (!exists) {
      throw new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        `Tenant not found: ${targetTenantId}`,
        INSTANCE,
        ErrorCodes.ENTITY_NOT_FOUND,
      );
    }
  }

  /**
   * Un estacionamiento nunca se queda sin dueño.
   *
   * RIESGO CONOCIDO Y ACEPTADO: contar acá no elimina la carrera. Prisma corre
   * en READ COMMITTED y esto es *write skew* — dos owners degradándose
   * mutuamente al mismo tiempo ven ambos `count = 2`, commitean filas distintas
   * y el lote queda en cero. Ni READ COMMITTED ni REPEATABLE READ lo previenen,
   * porque no hay conflicto sobre la misma fila.
   *
   * Se acepta en v1: la ventana es de milisegundos, hacen falta dos owners del
   * mismo lote actuando a la vez, el daño es recuperable desde
   * `/admin/users/:id/memberships`, y el invariante ya es best-effort a nivel
   * sistema — `AdminUsersService.removeMembership` no tiene guard ninguno. Si
   * alguna vez hay que cerrarlo de verdad, el lugar correcto es un trigger en
   * Postgres (la única capa que ve todas las rutas), no `Serializable` + retry
   * acá.
   */
  private async assertNotLastOwner(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    const owners = await tx.userMembership.count({
      where: { tenantId, role: MembershipRole.owner },
    });

    if (owners <= 1) {
      throw new FormattedException(
        'Conflict',
        HttpStatus.CONFLICT,
        `Tenant ${tenantId} would be left without an owner`,
        INSTANCE,
        ErrorCodes.STAFF_LAST_OWNER,
      );
    }
  }

  private alreadyExists(userId: string, tenantId: string): FormattedException {
    return new FormattedException(
      'Conflict',
      HttpStatus.CONFLICT,
      `User ${userId} already has a membership in tenant ${tenantId}`,
      INSTANCE,
      ErrorCodes.MEMBERSHIP_ALREADY_EXISTS,
    );
  }

  private membershipNotFound(
    userId: string,
    tenantId: string,
  ): FormattedException {
    return new FormattedException(
      'Not Found',
      HttpStatus.NOT_FOUND,
      `User ${userId} has no membership in tenant ${tenantId}`,
      INSTANCE,
      ErrorCodes.MEMBERSHIP_NOT_FOUND,
    );
  }
}
