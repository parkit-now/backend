import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, MaxLength } from 'class-validator';
import { normalizeEmailField } from '../../utils/text/normalize-email';

/**
 * Alta de un empleado en el lote de la URL, identificándolo por email.
 *
 * Manual y no autogenerado (AGENTS.md §4): `email` no es columna de
 * `user_memberships`. El contrato pide un mail justamente para NO exponer un
 * listado de usuarios de la plataforma — un dueño de playa no tiene por qué
 * poder recorrer el padrón.
 */
export class CreateStaffMemberDto {
  @ApiProperty({
    format: 'email',
    maxLength: 255,
    example: 'ana@example.com',
    description: [
      'Email de una cuenta **ya registrada** en Parkit. Se normaliza (trim + minúsculas) antes de buscarla.',
      '',
      'No hay flujo de invitación: si nadie se registró con ese mail, la respuesta es `404 USER_NOT_FOUND` y la persona tiene que crearse la cuenta primero.',
    ].join('\n'),
  })
  @Transform(normalizeEmailField)
  @IsEmail()
  // La columna es `@db.VarChar(255)`: sin este tope, un mail más largo se
  // rechazaría recién en Postgres como un 500 en vez de un 400.
  @MaxLength(255)
  email: string;

  @ApiProperty({
    enum: MembershipRole,
    example: 'operator',
    description:
      'Rol en **este** lote. `owner` está permitido: un dueño puede nombrar a otro dueño.',
  })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}
