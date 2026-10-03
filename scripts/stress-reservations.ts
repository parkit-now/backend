// Estrés de concurrencia de reservas (fase 2). SOLO LOCAL.
//
// Verifica que el lock por playa (`pg_advisory_xact_lock`) serializa las altas:
// con `reservable_spots = 1` y 20 conductores distintos pidiendo la MISMA
// franja a la vez, tiene que haber EXACTAMENTE 1 reserva creada
// (`pending_payment`) y 19 rechazos 409 `RESERVATION_NO_CAPACITY`.
//
// Qué hace, contra el backend local (:3000) y la base local, con el tenant Once:
//   1. Guarda la config original del servicio ADVANCE_RESERVATION y deja
//      `reservableSpots = 1` (y una tarifa de reservas si no tenía).
//   2. Registra 20 conductores de prueba (`POST /auth/register`) y le da a
//      cada uno un vehículo (`POST /driver/vehicles`).
//   3. Dispara 20 `POST /driver/reservations` en paralelo, con `returnUrl`.
//   4. Verifica 1 creada + 19 `RESERVATION_NO_CAPACITY` y que en la base haya
//      una sola reserva viva.
//   5. Limpia todo lo que creó (usuarios de prueba y, por cascada, sus
//      vehículos, reservas y pagos) y restaura la config, pase lo que pase.
//
// Uso (con Supabase local y el backend corriendo, proveedor de pago `dev`):
//
//   bun run scripts/stress-reservations.ts
//
// Variables opcionales: API_URL (default http://localhost:3000), CONCURRENCY
// (default 20). Lee DATABASE_URL del entorno / `.env` como el resto de los
// scripts. Se niega a correr si la base no es local. Exit code != 0 si falla.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const ONCE = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'StressTest-12345';
const EMAIL_DOMAIN = '@stress.parkit.test';
const RETURN_URL = 'http://localhost:5173/reserva/listo';

// La base tiene que ser local (no se imprime la URL).
function assertLocal(): void {
  let host = '';
  try {
    host = new URL(DATABASE_URL).hostname;
  } catch {
    // cae en el rechazo de abajo
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    console.error('✗ Me niego a correr: DATABASE_URL no es local o no existe.');
    process.exit(1);
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(API_URL)) {
    console.error('✗ Me niego a correr: API_URL no es local.');
    process.exit(1);
  }
}
assertLocal();

const pool = new Pool({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type Json = Record<string, unknown>;

async function http(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Próximo día hábil (lun-vie) a las 10:00-12:00 ART, dentro de los 7 días. */
function pickWindow(now = new Date()): { entryAt: string; exitAt: string } {
  const ART_OFFSET_MS = -3 * 3_600_000;
  for (let d = 1; d <= 6; d++) {
    const local = new Date(now.getTime() + ART_OFFSET_MS + d * 86_400_000);
    const dow = local.getUTCDay(); // 0 dom … 6 sáb
    if (dow === 0 || dow === 6) continue;
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    return {
      entryAt: `${y}-${m}-${day}T10:00:00-03:00`,
      exitAt: `${y}-${m}-${day}T12:00:00-03:00`,
    };
  }
  throw new Error('No encontré un día hábil dentro de los próximos 7 días.');
}

async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const failures: string[] = [];
  const check = (ok: boolean, label: string): void => {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };

  // Config original, para restaurarla pase lo que pase.
  const original = await prisma.service.findFirst({
    where: { tenantId: ONCE, code: 'ADVANCE_RESERVATION' },
  });
  if (!original)
    throw new Error('Once no tiene el servicio ADVANCE_RESERVATION.');
  const fallbackRate = await prisma.rate.findFirst({
    where: { tenantId: ONCE, isActive: true, deletedAt: null },
    orderBy: { shortcutNumber: 'asc' },
  });
  if (!original.reservationRateId && !fallbackRate) {
    throw new Error('Once no tiene una tarifa activa para reservas.');
  }

  try {
    await prisma.service.update({
      where: { id: original.id },
      data: {
        enabled: true,
        reservableSpots: 1,
        reservationRateId:
          original.reservationRateId ?? (fallbackRate?.id as string),
        acceptanceMode: 'auto',
        reservationHoursMode: 'opening',
        reservationVehicleKinds: ['car', 'suv_pickup', 'motorcycle'],
      },
    });
    console.log(`Config: reservableSpots=1 en Once (run ${runId}).`);

    // 20 conductores, cada uno con su vehículo.
    const drivers: { token: string; plate: string }[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const email = `stress-${runId}-${i}${EMAIL_DOMAIN}`;
      const plate = `ST${runId.toUpperCase().slice(-3)}${String(i).padStart(2, '0')}`;
      const reg = await http('POST', '/auth/register', {
        name: `Stress ${i}`,
        email,
        password: PASSWORD,
      });
      if (reg.status !== 201 && reg.status !== 200) {
        throw new Error(
          `register ${i} → ${reg.status} ${JSON.stringify(reg.body)}`,
        );
      }
      const login = await http('POST', '/auth/login', {
        email,
        password: PASSWORD,
      });
      const token = login.body.accessToken as string | undefined;
      if (!token) throw new Error(`login ${i} → ${login.status}`);
      const veh = await http(
        'POST',
        '/driver/vehicles',
        { plate, kind: 'car' },
        token,
      );
      if (veh.status !== 201) {
        throw new Error(
          `vehicle ${i} → ${veh.status} ${JSON.stringify(veh.body)}`,
        );
      }
      drivers.push({ token, plate });
    }
    console.log(`Preparados ${drivers.length} conductores con vehículo.`);

    const { entryAt, exitAt } = pickWindow();
    console.log(`Franja: ${entryAt} → ${exitAt}`);

    const started = Date.now();
    const results = await Promise.all(
      drivers.map((d) =>
        http(
          'POST',
          '/driver/reservations',
          {
            id: crypto.randomUUID(),
            parkingId: ONCE,
            vehiclePlate: d.plate,
            entryAt,
            exitAt,
            returnUrl: RETURN_URL,
          },
          d.token,
        ),
      ),
    );
    console.log(
      `${results.length} pedidos resueltos en ${Date.now() - started} ms.`,
    );

    const created = results.filter((r) => r.status === 200);
    const noCapacity = results.filter(
      (r) => r.status === 409 && r.body.code === 'RESERVATION_NO_CAPACITY',
    );
    const other = results.filter(
      (r) => !created.includes(r) && !noCapacity.includes(r),
    );
    console.log(
      `Resultado: ${created.length} creada(s), ${noCapacity.length} RESERVATION_NO_CAPACITY, ${other.length} otras.`,
    );
    if (other.length) {
      console.log(
        'Otras respuestas:',
        JSON.stringify(other.map((r) => [r.status, r.body.code ?? r.body])),
      );
    }

    check(created.length === 1, 'exactamente 1 reserva creada');
    check(
      noCapacity.length === CONCURRENCY - 1,
      `${CONCURRENCY - 1} rechazos RESERVATION_NO_CAPACITY`,
    );
    const reservation = created[0]?.body.reservation as Json | undefined;
    check(
      reservation?.status === 'pending_payment',
      'la creada está en pending_payment',
    );

    const alive = await prisma.reservation.count({
      where: {
        tenantId: ONCE,
        user: { email: { endsWith: EMAIL_DOMAIN } },
        status: 'pending_payment',
      },
    });
    check(alive === 1, 'la base tiene 1 sola reserva pending_payment');
  } finally {
    // Limpieza: borrar auth.users arrastra users → vehículos, reservas, pagos.
    const removed = await pool.query(
      `DELETE FROM auth.users WHERE email LIKE $1`,
      [`stress-%${EMAIL_DOMAIN}`],
    );
    console.log(
      `Limpieza: ${removed.rowCount} conductores de prueba borrados.`,
    );
    await prisma.service.update({
      where: { id: original.id },
      data: {
        enabled: original.enabled,
        reservableSpots: original.reservableSpots,
        reservationRateId: original.reservationRateId,
        acceptanceMode: original.acceptanceMode,
        reservationHoursMode: original.reservationHoursMode,
        reservationVehicleKinds: original.reservationVehicleKinds,
      },
    });
    console.log('Config de ADVANCE_RESERVATION restaurada.');
  }

  if (failures.length) {
    console.error(`\n✗ FALLÓ: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ OK: 1 creada y los demás rechazados por falta de cupo.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
