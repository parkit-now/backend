import { resolveInitialInvoice } from './invoice-policy';

describe('resolveInitialInvoice', () => {
  it('todas las líneas en Automática → se emite', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['auto', 'auto'] }),
    ).toEqual({ kind: 'issue' });
  });

  it('un medio en Manual → pendiente', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['manual'] }),
    ).toEqual({ kind: 'pending' });
  });

  it('mezcla de Automática y desmarcado → pendiente', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['auto', 'none'] }),
    ).toEqual({ kind: 'pending' });
  });

  it('ningún medio marcado → no requiere factura', () => {
    expect(resolveInitialInvoice({ total: 5000, lineModes: ['none'] })).toEqual(
      {
        kind: 'not_required',
      },
    );
    expect(resolveInitialInvoice({ total: 5000, lineModes: [] })).toEqual({
      kind: 'not_required',
    });
  });

  it('monto 0 → no requiere factura aunque el medio sea Automática', () => {
    expect(resolveInitialInvoice({ total: 0, lineModes: ['auto'] })).toEqual({
      kind: 'not_required',
    });
  });

  it('consumidor final desde $10.000.000 → pendiente con motivo', () => {
    expect(
      resolveInitialInvoice({ total: 10_000_000, lineModes: ['auto'] }),
    ).toEqual({ kind: 'pending', reason: 'INVOICE_RECEIVER_REQUIRED' });
  });
});
