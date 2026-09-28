import { X509Certificate } from 'node:crypto';

export interface ParsedArcaCertificate {
  /** CUIT del `serialNumber=CUIT 20XXXXXXXXX` del subject. */
  readonly cuit: string;
  readonly notAfter: Date;
  /** SHA-256 del certificado en hex minúscula, sin `:`. */
  readonly fingerprint: string;
}

/**
 * Lee lo que Parkit necesita de un certificado de ARCA. Tira `Error` si el PEM
 * no es un certificado o si el subject no trae el CUIT (no es de ARCA).
 */
export function parseArcaCertificate(pem: string): ParsedArcaCertificate {
  const cert = new X509Certificate(pem);

  const match = /serialNumber=CUIT (\d{11})/.exec(cert.subject);
  if (!match) {
    throw new Error(
      'El certificado no trae "serialNumber=CUIT ..." en el subject: no es un certificado de ARCA.',
    );
  }

  return {
    cuit: match[1],
    notAfter: new Date(cert.validTo),
    fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
  };
}

const PEM_HEADER = '-----BEGIN CERTIFICATE-----';
const PEM_FOOTER = '-----END CERTIFICATE-----';

/**
 * Rearma el PEM de un certificado pegado a mano desde la pantalla de ARCA:
 * copiar de una página web trae espacios, saltos `\r\n`, líneas cortadas en
 * cualquier lado o directamente sin las líneas BEGIN/END. Si lo que queda no
 * es base64, lo devuelve tal cual y que falle el parseo con su mensaje.
 */
export function normalizeCertificatePem(text: string): string {
  const raw = text.trim();
  const start = raw.indexOf(PEM_HEADER);
  const end = raw.indexOf(PEM_FOOTER);
  const body =
    start >= 0 && end > start ? raw.slice(start + PEM_HEADER.length, end) : raw;
  const base64 = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return raw;

  const lines = base64.match(/.{1,64}/g) ?? [];
  return [PEM_HEADER, ...lines, PEM_FOOTER].join('\n') + '\n';
}
