import { ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsDefined, IsEnum, IsUUID, ValidateIf } from 'class-validator';

/**
 * Modificación de una membresía existente: cambiar el rol, mudarla a otro lote,
 * o las dos cosas.
 *
 * Lo que este DTO NO hace es "appendear": mandar `tenantId` MUEVE la membresía
 * (el lote de la URL la pierde). Para que alguien trabaje en dos lotes a la vez
 * se hace `POST /tenants/<el otro>/staff` con el mismo email.
 */
export class UpdateStaffMemberDto {
  // Nota sobre el par: `@ValidateIf` corre los validadores de la propiedad sólo
  // si la condición da true. `role` se valida si vino, o si NO vino NINGUNO de
  // los dos — ahí `@IsDefined` rechaza el body vacío nombrando el campo.
  //
  // No se puede usar `@IsOptional()` acá: registra CONDITIONAL_VALIDATION y
  // saltea TODA la cadena cuando el valor es `undefined`, que es justo el caso
  // a rechazar. Mismo patrón y misma razón que `UpdateEntityAddressDto`
  // (`src/entities/dto/entity-address.dto.ts`) con el par lat/long.
  @ApiPropertyOptional({
    enum: MembershipRole,
    description:
      'Nuevo rol. Si además viene `tenantId`, se aplica en el lote destino. Omitirlo en una mudanza conserva el rol actual.',
  })
  @ValidateIf(
    (o: UpdateStaffMemberDto) =>
      o.role !== undefined || o.tenantId === undefined,
  )
  @IsDefined()
  @IsEnum(MembershipRole)
  role?: MembershipRole;

  // `@ValidateIf(!== undefined)` y no `@IsOptional()`: con `@IsOptional()` un
  // `{ "tenantId": null }` saltearía la cadena entera y llegaría al service
  // disfrazado de body vacío.
  @ApiPropertyOptional({
    format: 'uuid',
    description: [
      '**Mueve** la membresía a este lote: el de la URL deja de tenerla.',
      '',
      'El caller tiene que ser owner de los dos. Mandar el mismo id que el de la URL no es una mudanza — se trata como un cambio de rol común.',
    ].join('\n'),
  })
  @ValidateIf((o: UpdateStaffMemberDto) => o.tenantId !== undefined)
  @IsUUID()
  tenantId?: string;
}
