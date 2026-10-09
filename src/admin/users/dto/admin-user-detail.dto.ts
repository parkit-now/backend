import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { AdminUserDto } from './admin-user.dto';

/** A user's link to a parking lot, with the per-parking role. */
export class AdminUserMembershipDto {
  @ApiProperty({ format: 'uuid', description: 'Parking lot id (uuid).' })
  parkingId: string;

  @ApiProperty({ description: 'Parking lot display name.' })
  parkingName: string;

  @ApiProperty({
    enum: MembershipRole,
    description: 'Role held at this parking lot: `owner` or `operator`.',
  })
  role: MembershipRole;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'When the membership was granted.',
  })
  createdAt: Date;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se dio de baja el estacionamiento, o `null` si está vivo. ' +
      'La membresía se devuelve IGUAL cuando el estacionamiento está dado de ' +
      'baja: esconderla mentiría sobre quién tiene acceso, y si después se ' +
      'restaura su personal aparecería de la nada. El panel la muestra ' +
      'marcada.',
  })
  parkingDeletedAt: Date | null;
}

/** Full user detail for the admin panel: identity + parking memberships. */
export class AdminUserDetailDto extends AdminUserDto {
  @ApiProperty({ type: AdminUserMembershipDto, isArray: true })
  memberships: AdminUserMembershipDto[];
}
