import forge from 'node-forge';
import { aliasFromPem, arcaCertAlias, generateArcaCsr } from './arca-csr';

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

  it('el alias es parkit + el nombre de la sede, sólo letras y números', () => {
    const id = '1a2b3c4d-5e6f-4000-8000-000000000000';

    expect(arcaCertAlias('Estacionamiento Palermo', id)).toBe(
      'parkitestacionamientopalermo',
    );
    expect(arcaCertAlias('Playa Ñuñoa Nº 2', id)).toBe('parkitplayanunoan2');
    expect(arcaCertAlias('---', id)).toBe('parkit1a2b3c4d');
  });

  it('aliasFromPem lee el CN de la solicitud', () => {
    const { csrPem } = generateArcaCsr({
      cuit: '20123456786',
      alias: 'parkitx',
    });

    expect(aliasFromPem(csrPem)).toBe('parkitx');
    expect(aliasFromPem('basura')).toBeNull();
  });
});
