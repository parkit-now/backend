import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateStaffMemberDto } from './update-staff-member.dto';

/**
 * Los constraints que fallaron, por propiedad — exactamente lo que el pipe
 * global convierte en `validationsErrors[].code`. Mismas opciones que
 * `main.ts`, así que un campo de más falla acá como falla sobre HTTP.
 */
async function failures(
  body: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateStaffMemberDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}),
    ]),
  );
}

const TENANT = '0198f2a4-7c3e-7a1b-9d2e-4f5a6b7c8d9e';

describe('UpdateStaffMemberDto', () => {
  it('accepts a role-only change', async () => {
    expect(await failures({ role: 'operator' })).toEqual({});
  });

  it('accepts a move without a role', async () => {
    expect(await failures({ tenantId: TENANT })).toEqual({});
  });

  it('accepts a move that also changes the role', async () => {
    expect(await failures({ tenantId: TENANT, role: 'owner' })).toEqual({});
  });

  // El caso que motiva todo el `@ValidateIf`: con `@IsOptional()` un body
  // vacío pasaría la validación y llegaría al service sin nada que hacer.
  it('rejects an empty body, naming `role`', async () => {
    expect(await failures({})).toEqual({ role: ['isDefined', 'isEnum'] });
  });

  // `isDefined` encabeza CONSTRAINT_PRIORITY (`main.ts`), así que de los dos
  // constraints de arriba el front recibe ése y no el `isEnum`, que sería
  // engañoso: el problema no es que el rol sea inválido, es que no vino nada.
  it('reports `isDefined` before `isEnum` for the empty body', async () => {
    const constraints = (await failures({})).role;
    expect(constraints.indexOf('isDefined')).toBeLessThan(
      constraints.indexOf('isEnum'),
    );
  });

  it('rejects an explicit null role', async () => {
    expect((await failures({ role: null })).role).toContain('isDefined');
  });

  // Con `@IsOptional()` esto saltearía la cadena entera y se colaría como un
  // body vacío disfrazado.
  // `isUuid`, no `isUUID`: así lo exporta class-validator (`IS_UUID`). Ojo que
  // `CONSTRAINT_PRIORITY` en `main.ts` lo tiene escrito `isUUID`, o sea que esa
  // entrada está muerta. Acá no cambia nada porque `tenantId` tiene un solo
  // validador y no hay desempate que hacer.
  it('rejects an explicit null tenantId', async () => {
    expect(await failures({ tenantId: null })).toEqual({
      tenantId: ['isUuid'],
    });
  });

  it('rejects a non-uuid tenantId', async () => {
    expect(await failures({ tenantId: 'not-a-uuid' })).toEqual({
      tenantId: ['isUuid'],
    });
  });

  it('rejects a role outside the enum', async () => {
    expect(await failures({ role: 'admin' })).toEqual({ role: ['isEnum'] });
  });

  it('rejects unknown properties', async () => {
    expect(await failures({ role: 'operator', email: 'a@b.com' })).toEqual({
      email: ['whitelistValidation'],
    });
  });
});
