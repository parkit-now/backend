import forge from 'node-forge';
import { arcaCertAlias, generateArcaCsr } from './arca-csr';

describe('generateArcaCsr', () => {
  it('arma un CSR firmado con el subject que pide ARCA', () => {
    const { keyPem, csrPem } = generateArcaCsr({
      cuit: '20123456786',
      alias: 'parkit1a2b3c4d',
    });

    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const field = (name: string) =>
      csr.subject.attributes.find(
        (a) => a.name === name || a.shortName === name,
      )?.value;

    expect(csr.verify()).toBe(true);
    expect(field('serialNumber')).toBe('CUIT 20123456786');
    expect(field('CN')).toBe('parkit1a2b3c4d');
    expect(field('C')).toBe('AR');
    expect(keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('el alias es parkit + 8 hex del tenant, sólo letras y números', () => {
    expect(arcaCertAlias('1a2b3c4d-5e6f-4000-8000-000000000000')).toBe(
      'parkit1a2b3c4d',
    );
  });
});
