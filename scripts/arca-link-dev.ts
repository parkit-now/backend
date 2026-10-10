// Vincula una playa con ARCA desde la terminal, sin interfaz (Etapa 1).
//
// Lee el certificado y la clave privada DESDE LAS RUTAS QUE LE PASÁS, cifra la
// clave con ARCA_KEY_ENCRYPTION_KEY y deja `arca_accounts` en `linked`. Lo
// corre la persona dueña del certificado, nunca un agente: lee la clave.
//
// Los datos fiscales van por argumento porque el padrón de homologación
// devuelve `null` para CUIT reales (hallazgo de la Etapa 0). En la Etapa 2
// esto lo reemplaza el wizard del panel.
//
// Uso:
//   bun run scripts/arca-link-dev.ts --tenant <uuid> --cuit 20XXXXXXXXX \
//     --condicion RI|MONOTRIBUTO|EXENTO --pto-vta 1 \
//     --cert ~/arca-homo/homo.crt --key ~/arca-homo/homo.key \
//     --razon-social "..." --domicilio "..." [--iibb "..."] [--inicio AAAAMMDD]
//
// Guardrails: sólo corre contra una base local y sólo en homologación.

import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type ArcaTaxCondition } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { ArcaConfigService } from '../src/arca/arca-config.service';
import { ArcaCryptoService } from '../src/arca/arca-crypto.service';
import { parseArcaCertificate } from '../src/arca/arca-cert.util';
import { fromArcaDate } from '../src/arca/arca-dates';

const CONDICIONES: Record<string, ArcaTaxCondition> = {
  RI: 'responsable_inscripto',
  MONOTRIBUTO: 'monotributo',
  EXENTO: 'exento',
};

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}

const { values: args } = parseArgs({
  options: {
    tenant: { type: 'string' },
    cuit: { type: 'string' },
    condicion: { type: 'string' },
    'pto-vta': { type: 'string' },
    cert: { type: 'string' },
    key: { type: 'string' },
    'razon-social': { type: 'string' },
    domicilio: { type: 'string' },
    iibb: { type: 'string' },
    inicio: { type: 'string' },
  },
});

for (const required of [
  'tenant',
  'cuit',
  'condicion',
  'pto-vta',
  'cert',
  'key',
  'razon-social',
  'domicilio',
] as const) {
  if (!args[required]) fail(`Falta --${required}.`);
}

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  fail(
    'DATABASE_URL no apunta a una base local. Este script es sólo de desarrollo.',
  );
}

const cuit = args.cuit!.replace(/\D/g, '');
if (!/^\d{11}$/.test(cuit)) fail('--cuit tiene que tener 11 dígitos.');

const condicionIva = CONDICIONES[args.condicion!.toUpperCase()];
if (!condicionIva) fail('--condicion tiene que ser RI, MONOTRIBUTO o EXENTO.');

const ptoVta = Number(args['pto-vta']);
if (!Number.isInteger(ptoVta) || ptoVta < 1) fail('--pto-vta inválido.');

const inicioActividad = args.inicio ? fromArcaDate(args.inicio) : null;
if (args.inicio && !inicioActividad) fail('--inicio tiene que ser AAAAMMDD.');

const config = new ArcaConfigService(new ConfigService());
config.onModuleInit();
if (!config.enabled) fail('Falta ARCA_ENV en el .env del backend.');
if (config.production) {
  fail('ARCA_ENV=produccion: este script sólo vincula en homologación.');
}
const crypto = new ArcaCryptoService(config);

const certPem = readFileSync(expandHome(args.cert!), 'utf8');
const keyPem = readFileSync(expandHome(args.key!), 'utf8');

let cert: ReturnType<typeof parseArcaCertificate>;
try {
  cert = parseArcaCertificate(certPem);
} catch (error) {
  fail((error as Error).message);
}
if (cert.cuit !== cuit) {
  fail(`El certificado es del CUIT ${cert.cuit}, no de ${cuit}.`);
}
if (cert.notAfter.getTime() <= Date.now()) {
  fail(`El certificado venció el ${cert.notAfter.toISOString()}.`);
}

async function main(): Promise<void> {
  const encryptedKey = crypto.encrypt(keyPem);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: args.tenant! },
      select: { name: true },
    });
    if (!tenant) fail(`No existe el tenant ${args.tenant}.`);

    const data = {
      environment: config.environment,
      status: 'linked' as const,
      cuit,
      iibb: args.iibb ?? null,
      razonSocial: args['razon-social']!,
      condicionIva,
      domicilioFiscal: args.domicilio!,
      inicioActividad,
      ptoVta,
      certPem,
      keyEncrypted: encryptedKey.ciphertext,
      keyVersion: encryptedKey.keyVersion,
      certFingerprint: cert.fingerprint,
      certExpiresAt: cert.notAfter,
      linkedAt: new Date(),
    };
    const existing = await prisma.arcaAccount.findFirst({
      where: {
        tenantId: args.tenant!,
        role: 'primary',
        status: { not: 'unlinked' },
      },
    });
    if (existing)
      await prisma.arcaAccount.update({ where: { id: existing.id }, data });
    else
      await prisma.arcaAccount.create({
        data: { tenantId: args.tenant!, ...data },
      });

    console.log(
      `✓ "${tenant.name}" vinculada con ARCA (${config.environment}): CUIT ${cuit}, ` +
        `${condicionIva}, punto de venta ${ptoVta}, certificado hasta ` +
        `${cert.notAfter.toISOString().slice(0, 10)}.`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
