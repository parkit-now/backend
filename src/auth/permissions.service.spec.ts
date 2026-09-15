import { MembershipRole } from '@prisma/client';
import type { User, UserMembership } from '@prisma/client';
import { PermissionsService } from './permissions.service';

const admin: User = {
  id: 'a',
  role: 'admin',
  email: 'admin@once.test',
  name: null,
  createdAt: new Date(),
};
const plainUser: User = {
  id: 'u',
  role: 'user',
  email: 'user@once.test',
  name: null,
  createdAt: new Date(),
};

function membership(role: MembershipRole): UserMembership {
  return { userId: 'u', tenantId: 't-1', role, createdAt: new Date() };
}

describe('PermissionsService', () => {
  const permissions = new PermissionsService();
  const ownerMembership = membership(MembershipRole.owner);
  const operatorMembership = membership(MembershipRole.operator);

  describe('isAdmin', () => {
    it('is true only for the admin global role', () => {
      expect(permissions.isAdmin(admin)).toBe(true);
      expect(permissions.isAdmin(plainUser)).toBe(false);
    });
  });

  describe('canViewEntity', () => {
    it('admin can view without a membership', () => {
      expect(permissions.canViewEntity(admin, null)).toBe(true);
    });
    it('a member (owner or operator) can view', () => {
      expect(permissions.canViewEntity(plainUser, ownerMembership)).toBe(true);
      expect(permissions.canViewEntity(plainUser, operatorMembership)).toBe(
        true,
      );
    });
    it('a non-member cannot view', () => {
      expect(permissions.canViewEntity(plainUser, null)).toBe(false);
      expect(permissions.canViewEntity(plainUser, undefined)).toBe(false);
    });
  });

  describe('canOperateEntity', () => {
    it('admin and any member can operate', () => {
      expect(permissions.canOperateEntity(admin, null)).toBe(true);
      expect(permissions.canOperateEntity(plainUser, operatorMembership)).toBe(
        true,
      );
    });
    it('a non-member cannot operate', () => {
      expect(permissions.canOperateEntity(plainUser, null)).toBe(false);
    });
  });

  describe('canManageEntity', () => {
    it('admin can manage without a membership', () => {
      expect(permissions.canManageEntity(admin, null)).toBe(true);
    });
    it('only an owner membership can manage', () => {
      expect(permissions.canManageEntity(plainUser, ownerMembership)).toBe(
        true,
      );
    });
    it('an operator cannot manage', () => {
      expect(permissions.canManageEntity(plainUser, operatorMembership)).toBe(
        false,
      );
    });
    it('a non-member cannot manage', () => {
      expect(permissions.canManageEntity(plainUser, null)).toBe(false);
    });
  });
});
