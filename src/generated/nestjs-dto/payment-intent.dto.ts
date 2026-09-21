
import {Prisma,PaymentIntentStatus} from '@prisma/client'
import {ApiProperty} from '@nestjs/swagger'


export class PaymentIntentDto {
  @ApiProperty({
  description: `UUIDv7 generado por el cliente, igual que \'Entry\' y \'CashSession\': sin
\'@default\' a propósito. Es además el \'external_reference\' que viaja a
Mercado Pago — 36 chars de hex y guiones, dentro del máximo de 64 y del
charset que MP exige (letras, números, \'-\' y \'_\'), y SIN datos personales.`,
})
id: string ;
@ApiProperty({
  description: `NUESTRO estado, el que manda el comportamiento del sistema.`,
  enum: PaymentIntentStatus,
})
status: PaymentIntentStatus ;
@ApiProperty({
  description: `El monto a cobrar, congelado al crear el intento. NO se recalcula nunca:
la recuperación de un intent en \'created\' re-POSTea el MISMO body a MP con
la misma \'X-Idempotency-Key\', y un monto recalculado —aunque sea por un
minuto más de estadía— cambia el body y hace que MP conteste
\'409 idempotency_key_already_used\' en vez de devolver la orden original.
Ver el docblock de \'MpApiClient.createOrder\'.`,
  type: `number`,
  format: `double`,
})
amount: Prisma.Decimal ;
@ApiProperty({
  description: `El \'id\' de la Order del lado de Mercado Pago. NULL entre el INSERT y la
respuesta de \'POST /v1/orders\' — y también cuando esa llamada murió por
timeout y no sabemos si la orden existe. Ese hueco es exactamente el caso
que resuelve el re-POST idempotente.`,
})
mpOrderId: string  | null;
@ApiProperty({
  description: `El \'status\' CRUDO de Mercado Pago (\'created\', \'processed\', \'canceled\',
\'refunded\', \'expired\'). \'String\' y no enum a propósito: MP puede sumar un
valor mañana y eso no puede tirar abajo el webhook. Diagnóstico, no
fuente de verdad.`,
})
mpStatus: string  | null;
@ApiProperty({
  description: `El \'status_detail\' CRUDO de MP (\'created\', \'canceled\', \'accredited\',
\'refunded\', \'expired\', \'partially_refunded\'). Mismo criterio que \'mpStatus\'.`,
})
mpStatusDetail: string  | null;
@ApiProperty({
  description: `Cuándo deja de servir este intento. Se calcula UNA vez al crearlo, del
mismo TTL que viaja a MP como \'expiration_time\' (duración relativa ISO
8601, p. ej. \'PT5M\'). Lo barre el reconciliador.`,
  type: `string`,
  format: `date-time`,
})
expiresAt: Date ;
@ApiProperty({
  description: `Cuándo Mercado Pago acreditó el pago: el instante que reporta MP, no el de
nuestro reloj. Entre que el cliente paga y el webhook llega puede haber
minutos, y el comprobante tiene que decir cuándo se pagó.`,
  type: `string`,
  format: `date-time`,
})
approvedAt: Date  | null;
@ApiProperty({
  description: `Cuándo el intento se convirtió en una \'PaymentTransaction\'. Junto con
\'paymentTransactionId\' es el candado de un solo uso: se consume UNA vez,
con un UPDATE condicional sobre el estado, y el segundo intento de
consumirlo actualiza 0 filas.`,
  type: `string`,
  format: `date-time`,
})
consumedAt: Date  | null;
@ApiProperty({
  description: `El cobro que este intento generó al consumirse. Se llena en B5. SIN
\'@relation\' y SIN FK en la base a propósito: \'payment_transactions\' es
tenant-local y tiene borrado lógico, así que una FK ataría una tabla
global a una tenant-local para ganar nada. El vínculo se navega desde el
service, que ya filtra por tenant.`,
})
paymentTransactionId: string  | null;
@ApiProperty({
  description: `Por qué falló, en texto libre y para humanos. NUNCA lleva tokens ni datos
personales del pagador: lo lee soporte y termina en logs y exports.`,
})
failureReason: string  | null;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
createdAt: Date ;
@ApiProperty({
  type: `string`,
  format: `date-time`,
})
updatedAt: Date ;
}
