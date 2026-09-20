import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole, UserRole } from '@prisma/client';

/**
 * Una membresía después de crearla o modificarla: la persona + dónde y con qué
 * rol quedó.
 *
 * Plano a propósito, y no una reutilización de `StaffMemberDto`: ése agrupa por
 * persona y lista TODAS sus membresías, que es lo que la tabla necesita. Acá el
 * front acaba de tocar UNA, y sobre todo hizo el POST con un email —
 * necesita el `userId` de vuelta para poder mandar los PATCH/DELETE
 * siguientes, que van por id.
 */
export class StaffMembershipResultDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id de la persona. Es el `:userId` de los PATCH/DELETE posteriores.',
  })
  userId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nombre espejado de Supabase Auth. `null` en cuentas de email/password creadas sin uno.',
    example: 'Ana Gómez',
  })
  name: string | null;

  @ApiProperty({ format: 'email', example: 'ana@example.com' })
  email: string;

  @ApiProperty({
    enum: UserRole,
    description:
      'Rol de plataforma (`admin` | `user`), no el del lote. El del lote es `role`.',
    example: 'user',
  })
  globalRole: UserRole;

  @ApiProperty({
    format: 'uuid',
    description:
      'Lote donde quedó la membresía. Difiere del `:tenantId` de la URL cuando el PATCH fue una mudanza.',
  })
  tenantId: string;

  @ApiProperty({
    description: 'Nombre del lote, para no obligar a un segundo lookup.',
    example: 'Estacionamiento Once',
  })
  tenantName: string;

  @ApiProperty({ enum: MembershipRole, example: 'operator' })
  role: MembershipRole;

  @ApiProperty({
    format: 'date-time',
    description:
      'Antigüedad de la persona en la empresa. Se conserva al mudarla de lote, así que puede ser anterior al alta del lote destino.',
  })
  createdAt: Date;
}
