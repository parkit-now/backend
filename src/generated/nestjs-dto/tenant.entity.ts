
import {Prisma,BranchStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'
import {UserMembershipEntity} from './user-membership.entity'
import {EntryEntity} from './entry.entity'
import {RateEntity} from './rate.entity'
import {ScheduleEntity} from './schedule.entity'
import {ServiceEntity} from './service.entity'
import {PaymentMethodEntity} from './payment-method.entity'
import {VehicleEntity} from './vehicle.entity'
import {VehicleTypeEntity} from './vehicle-type.entity'
import {AuditLogEntity} from './audit-log.entity'
import {OnboardingApplicationEntity} from './onboarding-application.entity'
import {CashSessionEntity} from './cash-session.entity'
import {PaymentTransactionEntity} from './payment-transaction.entity'
import {WhitelistEntity} from './whitelist.entity'
import {LprDetectionEventEntity} from './lpr-detection-event.entity'
import {MpAccountEntity} from './mp-account.entity'
import {MpOauthStateEntity} from './mp-oauth-state.entity'


export class TenantEntity {
  id: string ;
name: string ;
legalName: string  | null;
cuit: string  | null;
email: string  | null;
phone: string  | null;
@ApiProperty({
  description: `Dirección completa en una línea, para mostrar. Guarda la \'nomenclatura\'
que devuelve la API Georef. Es el campo de display y el que mantiene la
retrocompatibilidad; los datos para Mercado Pago viven en las columnas
separadas de abajo.`,
})
address: string  | null;
@ApiProperty({
  enum: BranchStatus,
})
status: BranchStatus ;
settings: Prisma.JsonValue ;
@ApiProperty({
  type: `integer`,
  format: `int32`,
})
lprImageRetentionDays: number ;
@ApiProperty({
  description: `Nombre de la calle, sin altura.`,
})
streetName: string  | null;
@ApiProperty({
  description: `Altura, como TEXTO y no entero a propósito: existen "S/N", "1234 bis" y
"Km 5". Mercado Pago también lo recibe como string. No convertir a Int.`,
})
streetNumber: string  | null;
@ApiProperty({
  description: `Piso y/o departamento. Sólo contacto/facturación; Mercado Pago no lo usa.`,
})
floor: string  | null;
cityName: string  | null;
stateName: string  | null;
postalCode: string  | null;
@ApiProperty({
  description: `Latitud en grados decimales. Sólo válida junto con \'longitude\': el CHECK
\'tenants_coordinates_paired\' prohíbe media coordenada.`,
  type: `number`,
  format: `double`,
})
latitude: Prisma.Decimal  | null;
@ApiProperty({
  description: `Longitud en grados decimales. Ver \'latitude\'.`,
  type: `number`,
  format: `double`,
})
longitude: Prisma.Decimal  | null;
@ApiProperty({
  description: `Origen del dato: \'georef\' (normalizado por la API del Estado) o \'manual\'.
Conjunto cerrado por el CHECK \'tenants_geocoding_source_valid\'.`,
})
geocodingSource: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
geocodedAt: Date  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
memberships?: UserMembershipEntity[] ;
entries?: EntryEntity[] ;
rates?: RateEntity[] ;
schedules?: ScheduleEntity[] ;
services?: ServiceEntity[] ;
paymentMethods?: PaymentMethodEntity[] ;
vehicles?: VehicleEntity[] ;
vehicleTypes?: VehicleTypeEntity[] ;
auditLogs?: AuditLogEntity[] ;
applications?: OnboardingApplicationEntity[] ;
cashSessions?: CashSessionEntity[] ;
paymentTransactions?: PaymentTransactionEntity[] ;
whitelists?: WhitelistEntity[] ;
lprDetectionEvents?: LprDetectionEventEntity[] ;
mpAccount?: MpAccountEntity  | null;
mpOauthStates?: MpOauthStateEntity[] ;
}
