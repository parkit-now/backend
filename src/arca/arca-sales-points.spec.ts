import { checkSalesPoint } from './arca-sales-points';

const list = (...ptoVenta: unknown[]) => ({ resultGet: { ptoVenta } });

describe('checkSalesPoint', () => {
  it('ok si figura y no está bloqueado', () => {
    expect(
      checkSalesPoint(list({ nro: 3, bloqueado: 'N', fechaBaja: 'NULL' }), 3),
    ).toBe('ok');
  });

  it('not_found si no está en la lista de web services', () => {
    expect(checkSalesPoint(list({ nro: 1, bloqueado: 'N' }), 3)).toBe(
      'not_found',
    );
  });

  it('disabled si está bloqueado o dado de baja', () => {
    expect(checkSalesPoint(list({ nro: 3, bloqueado: 'S' }), 3)).toBe(
      'disabled',
    );
    expect(
      checkSalesPoint(
        list({ nro: 3, bloqueado: 'N', fechaBaja: '20250101' }),
        3,
      ),
    ).toBe('disabled');
  });

  it('un solo punto de venta llega como objeto suelto', () => {
    expect(
      checkSalesPoint(
        { resultGet: { ptoVenta: { nro: '3', bloqueado: 'N' } } },
        3,
      ),
    ).toBe('ok');
  });

  it('empty si ARCA no devuelve ninguno (homologación)', () => {
    expect(checkSalesPoint({ errors: { err: [] } }, 3)).toBe('empty');
    expect(checkSalesPoint(null, 3)).toBe('empty');
  });
});
