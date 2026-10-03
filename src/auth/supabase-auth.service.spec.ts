import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { SupabaseAuthService } from './supabase-auth.service';

const createUser = jest.fn();
const signInWithPassword = jest.fn();

describe('RegisterDto', () => {
  const base = { email: 'jane@parkit.com', password: 'CorrectHorse1!' };

  it('exige name', async () => {
    const dto = plainToInstance(RegisterDto, base);
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('name');
  });

  it('rechaza name vacío o sólo espacios', async () => {
    const dto = plainToInstance(RegisterDto, { ...base, name: '   ' });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('name');
  });

  it('recorta el name', async () => {
    const dto = plainToInstance(RegisterDto, { ...base, name: '  Jane Doe ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.name).toBe('Jane Doe');
  });

  it('rechaza name de más de 120 caracteres', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...base,
      name: 'a'.repeat(121),
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toContain('name');
  });
});

describe('SupabaseAuthService.register', () => {
  const users = { create: jest.fn(), findByIdOrNull: jest.fn() };
  let service: SupabaseAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    const config = {
      getOrThrow: () => 'x',
    } as unknown as ConfigService;
    service = new SupabaseAuthService(config, users as unknown as UsersService);
    // Se inyectan los clientes de Supabase en vez de llamar a `onModuleInit()`
    // (que crearía clientes reales).
    Object.assign(service, {
      admin: { auth: { admin: { createUser, deleteUser: jest.fn() } } },
      anon: { auth: { signInWithPassword } },
    });
    createUser.mockResolvedValue({
      data: { user: { id: 'u-1' } },
      error: null,
    });
    users.create.mockResolvedValue({ id: 'u-1', name: 'Jane Doe' });
    users.findByIdOrNull.mockResolvedValue({ id: 'u-1' });
    signInWithPassword.mockResolvedValue({
      data: {
        session: {
          user: { id: 'u-1' },
          access_token: 'a',
          refresh_token: 'r',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1,
        },
      },
      error: null,
    });
  });

  it('manda el nombre como user_metadata.full_name y lo guarda en public.users', async () => {
    await service.register({
      name: 'Jane Doe',
      email: 'jane@parkit.com',
      password: 'CorrectHorse1!',
    });

    const arg = createUser.mock.calls[0][0] as {
      user_metadata: { full_name: string };
    };
    expect(arg.user_metadata).toEqual({ full_name: 'Jane Doe' });
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-1', name: 'Jane Doe' }),
    );
  });
});
