import { Injectable, NotFoundException } from '@nestjs/common';
import type { User, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { UserDto } from '../generated/nestjs-dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByIdOrNull(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findById(id: string): Promise<User> {
    const user = await this.findByIdOrNull(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email } });
  }

  /**
   * Provision the `public.users` row that mirrors a Supabase Auth user.
   * `id` MUST equal `auth.users.id` (FK with ON DELETE CASCADE).
   * Tenant association (if any) is created separately in `user_memberships`.
   *
   * Idempotent by design: social OAuth may auto-provision this row in SQL
   * triggers before the backend touches it.
   */
  create(input: { id: string; role: UserRole; email: string }): Promise<User> {
    return this.prisma.user.upsert({
      where: { id: input.id },
      create: input,
      update: { role: input.role, email: input.email },
    });
  }

  delete(id: string): Promise<User> {
    return this.prisma.user.delete({ where: { id } });
  }

  toResponse(user: User): UserDto {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
