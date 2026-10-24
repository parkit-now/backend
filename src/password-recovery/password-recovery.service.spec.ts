import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from '../users/users.service';
import { ErrorCodes } from '../utils/exceptions/error-codes';
import { EMAIL_SENDER } from './email/email-sender';
import { PasswordRecoveryService } from './password-recovery.service';

const ENV: Record<string, string> = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_ANON_KEY: 'anon',
  WEB_PANEL_URL: 'https://panel.parkit.test',
  PASSWORD_RESET_LINK_TTL_MIN: '15',
};

describe('PasswordRecoveryService', () => {
  let service: PasswordRecoveryService;

  const mockPrisma = {
    passwordResetRequest: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockUsers = { findByEmail: jest.fn() };
  const mockEmail = { sendPasswordReset: jest.fn() };
  const mockConfig = {
    getOrThrow: (key: string) => ENV[key],
    get: (key: string) => ENV[key],
  };
  // Los clientes de Supabase se reemplazan después de `onModuleInit`.
  const admin = {
    auth: { admin: { generateLink: jest.fn(), updateUserById: jest.fn() } },
  };
  const anon = { auth: { verifyOtp: jest.fn() } };

  function statuses(): string[] {
    return mockPrisma.passwordResetRequest.create.mock.calls.map(
      ([arg]) => (arg as { data: { status: string } }).data.status,
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    // Los fallos se loguean a propósito: acá sólo ensuciarían la salida.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockPrisma.passwordResetRequest.count.mockResolvedValue(0);
    mockUsers.findByEmail.mockResolvedValue({ id: 'ana' });
    admin.auth.admin.generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash/+' } },
      error: null,
    });
    mockEmail.sendPasswordReset.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordRecoveryService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: UsersService, useValue: mockUsers },
        { provide: EMAIL_SENDER, useValue: mockEmail },
      ],
    }).compile();

    service = module.get(PasswordRecoveryService);
    service.onModuleInit();
    Object.assign(service, { admin, anon });
  });

  describe('requestReset', () => {
    it('manda el link con el token y lo registra como enviado', async () => {
      await service.requestReset('  Ana@Parkit.Test ', '10.0.0.1');

      expect(admin.auth.admin.generateLink).toHaveBeenCalledWith({
        type: 'recovery',
        email: 'ana@parkit.test',
        options: { redirectTo: 'https://panel.parkit.test/reset-password' },
      });
      expect(mockEmail.sendPasswordReset).toHaveBeenCalledWith(
        'ana@parkit.test',
        'https://panel.parkit.test/reset-password?token=hash%2F%2B',
        15,
      );
      expect(mockPrisma.passwordResetRequest.create).toHaveBeenCalledWith({
        data: {
          email: 'ana@parkit.test',
          ipAddress: '10.0.0.1',
          status: 'sent',
        },
      });
    });

    it('con muchos pedidos recientes no manda nada', async () => {
      mockPrisma.passwordResetRequest.count.mockResolvedValue(3);

      await service.requestReset('ana@parkit.test', null);

      expect(mockUsers.findByEmail).not.toHaveBeenCalled();
      expect(statuses()).toEqual(['ignored_rate_limited']);
    });

    it('un email desconocido se ignora sin revelarlo', async () => {
      mockUsers.findByEmail.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.requestReset('nadie@parkit.test', null),
      ).resolves.toBeUndefined();
      expect(statuses()).toEqual(['ignored_unknown_email']);
      expect(mockEmail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('registra el fallo si Supabase no genera el link', async () => {
      admin.auth.admin.generateLink.mockResolvedValueOnce({
        data: null,
        error: { message: 'boom' },
      });
      await service.requestReset('ana@parkit.test', null);

      admin.auth.admin.generateLink.mockRejectedValueOnce(new Error('red'));
      await service.requestReset('ana@parkit.test', null);

      expect(statuses()).toEqual(['email_failed', 'email_failed']);
      expect(mockEmail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('registra el fallo si no se pudo mandar el email', async () => {
      mockEmail.sendPasswordReset.mockRejectedValue(new Error('smtp'));

      await service.requestReset('ana@parkit.test', null);

      expect(statuses()).toEqual(['email_failed']);
    });
  });

  describe('confirmReset', () => {
    it('cambia la contraseña y cierra el último pedido', async () => {
      anon.auth.verifyOtp.mockResolvedValue({
        data: { user: { id: 'ana', email: 'Ana@Parkit.Test' } },
        error: null,
      });
      admin.auth.admin.updateUserById.mockResolvedValue({ error: null });
      mockPrisma.passwordResetRequest.findFirst.mockResolvedValue({
        id: 'req-1',
      });

      await service.confirmReset('hash', 'nueva-clave-1');

      expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith('ana', {
        password: 'nueva-clave-1',
      });
      expect(mockPrisma.passwordResetRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'ana@parkit.test', status: 'sent' },
        }),
      );
      expect(mockPrisma.passwordResetRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: expect.objectContaining({ status: 'completed' }) as unknown,
      });
    });

    it('sin pedido previo no marca nada', async () => {
      anon.auth.verifyOtp.mockResolvedValue({
        data: { user: { id: 'ana', email: 'ana@parkit.test' } },
        error: null,
      });
      admin.auth.admin.updateUserById.mockResolvedValue({ error: null });
      mockPrisma.passwordResetRequest.findFirst.mockResolvedValue(null);

      await service.confirmReset('hash', 'nueva-clave-1');

      expect(mockPrisma.passwordResetRequest.update).not.toHaveBeenCalled();
    });

    it('rechaza un token inválido o vencido', async () => {
      anon.auth.verifyOtp.mockResolvedValue({
        data: { user: null },
        error: { message: 'expired' },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.confirmReset('viejo', 'nueva-clave-1'),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.AUTH_RESET_TOKEN_INVALID, status: 400 },
      });
    });

    it('distingue una contraseña débil de otro fallo', async () => {
      anon.auth.verifyOtp.mockResolvedValue({
        data: { user: { id: 'ana', email: 'ana@parkit.test' } },
        error: null,
      });
      admin.auth.admin.updateUserById.mockResolvedValueOnce({
        error: { code: 'weak_password', message: 'weak' },
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.confirmReset('hash', '123')).rejects.toMatchObject({
        response: { code: ErrorCodes.AUTH_WEAK_PASSWORD },
      });

      admin.auth.admin.updateUserById.mockResolvedValueOnce({
        error: { code: 'unexpected', message: 'boom' },
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        service.confirmReset('hash', 'nueva-clave-1'),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.AUTH_RESET_PASSWORD_FAILED },
      });
    });
  });
});
