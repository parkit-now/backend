import { resolveReceiver } from './invoice-receiver';

const CUIT = '30712345671';

describe('resolveReceiver', () => {
  it('Responsable Inscripto → condición 1 con su razón social', () => {
    expect(
      resolveReceiver({
        cuit: CUIT,
        environment: 'produccion',
        fiscal: {
          razonSocial: 'Empresa SA',
          condicionIva: 'responsable_inscripto',
          domicilioFiscal: null,
        },
      }),
    ).toEqual({ ok: true, condicionIvaReceptorId: 1, nombre: 'Empresa SA' });
  });

  it('Monotributista → condición 6', () => {
    const r = resolveReceiver({
      cuit: CUIT,
      environment: 'produccion',
      fiscal: {
        razonSocial: 'Juan Pérez',
        condicionIva: 'monotributo',
        domicilioFiscal: null,
      },
    });
    expect(r).toEqual({
      ok: true,
      condicionIvaReceptorId: 6,
      nombre: 'Juan Pérez',
    });
  });

  it('exento no puede recibir A', () => {
    const r = resolveReceiver({
      cuit: CUIT,
      environment: 'produccion',
      fiscal: {
        razonSocial: 'X',
        condicionIva: 'exento',
        domicilioFiscal: null,
      },
    });
    expect(r).toEqual({ ok: false, code: 'INVOICE_RECEIVER_NOT_A' });
  });

  it('sin padrón en producción → no encontrado', () => {
    expect(
      resolveReceiver({ cuit: CUIT, environment: 'produccion', fiscal: null }),
    ).toEqual({ ok: false, code: 'INVOICE_RECEIVER_NOT_FOUND' });
  });

  it('sin padrón en homologación → se prueba como RI', () => {
    expect(
      resolveReceiver({
        cuit: CUIT,
        environment: 'homologacion',
        fiscal: null,
      }),
    ).toEqual({
      ok: true,
      condicionIvaReceptorId: 1,
      nombre: 'CUIT 30-71234567-1',
    });
  });
});
