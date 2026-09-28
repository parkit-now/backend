import {
  createPrivateKey,
  generateKeyPairSync,
  X509Certificate,
} from 'node:crypto';
import forge from 'node-forge';

export interface ArcaCsrSubject {
  readonly cuit: string;
  /**
   * `CN=`: el alias del certificado en ARCA («Nombre simbólico del DN» en
   * WSASS). Sólo letras y números.
   */
  readonly alias: string;
}

export interface GeneratedArcaCsr {
  /** Clave privada PKCS#8 en PEM. Se cifra ANTES de tocar la base. */
  readonly keyPem: string;
  readonly csrPem: string;
}

/**
 * Genera la clave privada (RSA 2048) y la solicitud de certificado que el
 * dueño sube a ARCA. Reemplaza el `openssl genrsa` + `openssl req` de la
 * Etapa 0: la clave nunca sale de Parkit.
 *
 * La clave la genera `node:crypto` (nativo, milisegundos); `node-forge` sólo
 * arma y firma el CSR, que es lo que `node:crypto` no sabe hacer. Generar la
 * clave con forge en JS puro tarda segundos y bloquea el event loop.
 */
export function generateArcaCsr(subject: ArcaCsrSubject): GeneratedArcaCsr {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(publicKey);
  csr.setSubject([
    { shortName: 'C', value: 'AR' },
    // La razón social todavía no se conoce (sale del padrón DESPUÉS del
    // certificado) y ARCA no la valida: el CUIT alcanza y es ASCII puro.
    { shortName: 'O', value: `CUIT ${subject.cuit}` },
    { shortName: 'CN', value: subject.alias },
    // ARCA lee el CUIT de acá: exactamente "CUIT", un espacio y 11 dígitos.
    { name: 'serialNumber', value: `CUIT ${subject.cuit}` },
  ]);
  csr.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return {
    keyPem: privateKey,
    csrPem: forge.pki.certificationRequestToPem(csr),
  };
}

/** Largo máximo de lo que se toma del nombre de la sede para el alias. */
const ALIAS_NAME_MAX = 24;

/**
 * Alias del certificado («Nombre simbólico del DN» en WSASS, alias en
 * Certificados Digitales): `parkit` + el nombre de la sede sin tildes ni
 * espacios, p. ej. `parkitestacionamientopalermo`. Legible para que el dueño
 * lo reconozca después en ARCA. Sólo letras y números: es lo que acepta ARCA.
 * Si el nombre no deja nada usable, cae a 8 hex del tenant.
 */
export function arcaCertAlias(tenantName: string, tenantId: string): string {
  const slug = tenantName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, ALIAS_NAME_MAX);
  return `parkit${slug || tenantId.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * El alias REAL: el CN del certificado o, si todavía no hay, el de la
 * solicitud. Es lo que ARCA tiene registrado, aunque la sede se haya
 * renombrado después o se haya vinculado con otro alias (el script de dev).
 */
export function aliasFromPem(pem: string | null): string | null {
  if (!pem) return null;
  try {
    const subject = pem.includes('CERTIFICATE REQUEST')
      ? forge.pki.certificationRequestFromPem(pem).subject
      : forge.pki.certificateFromPem(pem).subject;
    const field = subject.getField('CN') as { value?: unknown } | null;
    return typeof field?.value === 'string' ? field.value : null;
  } catch {
    return null;
  }
}

/** ¿El certificado se emitió para ESTA clave (la de nuestro CSR)? */
export function certMatchesKey(certPem: string, keyPem: string): boolean {
  return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
}
