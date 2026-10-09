import { resolveInitialInvoice } from './invoice-policy';

describe('resolveInitialInvoice', () => {
  it('todas las líneas en Automática → se emite', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['auto', 'auto'] }),
    ).toEqual({ kind: 'issue' });
  });

  it('un medio en Manual → sin factura pendiente', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['manual'] }),
    ).toEqual({ kind: 'not_required' });
  });

  it('Manual prevalece en un cobro dividido con Automática', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['auto', 'manual'] }),
    ).toEqual({ kind: 'not_required' });
  });

  it('Manual con monto alto no queda pendiente por identificación', () => {
    expect(
      resolveInitialInvoice({ total: 10_000_000, lineModes: ['manual'] }),
    ).toEqual({ kind: 'not_required' });
  });

  it('Manual con pendiente deja una factura pendiente, aun sin Automática', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['manual_pending'] }),
    ).toEqual({ kind: 'pending' });
    expect(
      resolveInitialInvoice({
        total: 5000,
        lineModes: ['manual', 'manual_pending'],
      }),
    ).toEqual({ kind: 'pending' });
  });

  it('Desactivado impide facturar incluso en un cobro dividido', () => {
    expect(
      resolveInitialInvoice({ total: 5000, lineModes: ['auto', 'none'] }),
    ).toEqual({ kind: 'not_required' });
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
