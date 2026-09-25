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
