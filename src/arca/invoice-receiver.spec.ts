import {
  condicionIvaLabel,
  condicionIvaReceptorFor,
  receivesInvoiceA,
  resolveReceiver,
} from './invoice-receiver';

const CUIT = '30712345671';

describe('condicionIvaReceptorFor (padrón → CondicionIVAReceptorId)', () => {
  it('RI → 1, monotributo → 6, exento → 4', () => {
    expect(condicionIvaReceptorFor('responsable_inscripto')).toBe(1);
    expect(condicionIvaReceptorFor('monotributo')).toBe(6);
    expect(condicionIvaReceptorFor('exento')).toBe(4);
  });

  it('sin IVA ni monotributo → Consumidor Final (5)', () => {
    expect(condicionIvaReceptorFor(null)).toBe(5);
  });
});

describe('receivesInvoiceA', () => {
  it('1, 6, 13 y 16 reciben A; el resto no', () => {
    expect([1, 6, 13, 16].every(receivesInvoiceA)).toBe(true);
    expect([4, 5, 7, 8, 9, 10, 15].some(receivesInvoiceA)).toBe(false);
  });
});

describe('condicionIvaLabel', () => {
  it('usa la descripción de ARCA', () => {
    expect(condicionIvaLabel(1)).toBe('IVA Responsable Inscripto');
    expect(condicionIvaLabel(4)).toBe('IVA Sujeto Exento');
    expect(condicionIvaLabel(99)).toBe('Condición 99');
  });
});

describe('resolveReceiver', () => {
  it('con padrón → su condición y razón social', () => {
    expect(
      resolveReceiver({
        cuit: CUIT,
        environment: 'produccion',
        padron: { razonSocial: 'Empresa SA', condicionIvaReceptorId: 4 },
      }),
    ).toEqual({
      ok: true,
      condicionIvaReceptorId: 4,
      nombre: 'Empresa SA',
      assumed: false,
    });
  });

  it('padrón sin razón social → el CUIT con guiones como nombre', () => {
    const r = resolveReceiver({
      cuit: CUIT,
      environment: 'produccion',
      padron: { razonSocial: null, condicionIvaReceptorId: 1 },
    });
    expect(r).toMatchObject({ ok: true, nombre: 'CUIT 30-71234567-1' });
  });

  it('sin datos en producción → no encontrado', () => {
    expect(
      resolveReceiver({ cuit: CUIT, environment: 'produccion', padron: null }),
    ).toEqual({ ok: false, code: 'INVOICE_RECEIVER_NOT_FOUND' });
    expect(
      resolveReceiver({
        cuit: CUIT,
        environment: 'produccion',
        padron: { razonSocial: null, condicionIvaReceptorId: null },
      }),
    ).toEqual({ ok: false, code: 'INVOICE_RECEIVER_NOT_FOUND' });
  });

  it('sin datos en homologación → se asume Responsable Inscripto', () => {
    expect(
      resolveReceiver({
        cuit: CUIT,
        environment: 'homologacion',
        padron: null,
      }),
    ).toEqual({
      ok: true,
      condicionIvaReceptorId: 1,
      nombre: 'CUIT 30-71234567-1',
      assumed: true,
    });
  });
});
