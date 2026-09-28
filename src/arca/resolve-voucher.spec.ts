import { letterFor, resolveVoucher } from './resolve-voucher';

describe('resolveVoucher', () => {
  it('Responsable Inscripto a consumidor final → B con IVA 21% discriminado', () => {
    const v = resolveVoucher({
      emitter: 'responsable_inscripto',
      total: 1210,
      ivaRate: 21,
    });

    expect(v.letter).toBe('B');
    expect(v.cbteTipo).toBe(6);
    expect(v.docTipo).toBe(99);
    expect(v.docNro).toBe(0);
    expect(v.condicionIvaReceptorId).toBe(5);
    expect(v.impNeto).toBe(1000);
    expect(v.impIva).toBe(210);
    expect(v.iva).toEqual([{ Id: 5, BaseImp: 1000, Importe: 210 }]);
  });

  it('el redondeo nunca deja neto + IVA distinto del total', () => {
    for (const total of [1, 99.99, 1500, 2333.33, 7777.77]) {
      const v = resolveVoucher({
        emitter: 'responsable_inscripto',
        total,
        ivaRate: 21,
      });
      expect(Math.round((v.impNeto + v.impIva) * 100)).toBe(
        Math.round(total * 100),
      );
    }
  });

  it('Monotributo → C sin IVA: ImpNeto = total y sin array Iva', () => {
    const v = resolveVoucher({
      emitter: 'monotributo',
      total: 1210,
      ivaRate: 21,
    });

    expect(v.letter).toBe('C');
    expect(v.cbteTipo).toBe(11);
    expect(v.impNeto).toBe(1210);
    expect(v.impIva).toBe(0);
    expect(v.iva).toBeUndefined();
  });

  it('Exento también emite C', () => {
    expect(
      resolveVoucher({ emitter: 'exento', total: 500, ivaRate: 21 }).letter,
    ).toBe('C');
  });

  it('una alícuota que ARCA no conoce es un error, no se redondea', () => {
    expect(() =>
      resolveVoucher({
        emitter: 'responsable_inscripto',
        total: 100,
        ivaRate: 19,
      }),
    ).toThrow(/19%/);
  });

  it('RI con receptor → A con CUIT y la condición del padrón', () => {
    const v = resolveVoucher({
      emitter: 'responsable_inscripto',
      total: 1210,
      ivaRate: 21,
      receiver: { cuit: '30712345671', condicionIvaReceptorId: 6 },
    });

    expect(v.letter).toBe('A');
    expect(v.cbteTipo).toBe(1);
    expect(v.docTipo).toBe(80);
    expect(v.docNro).toBe(30712345671);
    expect(v.condicionIvaReceptorId).toBe(6);
    expect(v.impNeto).toBe(1000);
    expect(v.impIva).toBe(210);
  });

  it.each([1, 6, 13, 16])(
    'RI + receptor con condición %i → A (la tabla de cmp_Clase A)',
    (condicion) => {
      const v = resolveVoucher({
        emitter: 'responsable_inscripto',
        total: 1210,
        ivaRate: 21,
        receiver: { cuit: '30712345671', condicionIvaReceptorId: condicion },
      });
      expect(v.letter).toBe('A');
      expect(v.condicionIvaReceptorId).toBe(condicion);
    },
  );

  it.each([4, 5, 7, 15])(
    'RI + receptor con condición %i → B identificada con el CUIT',
    (condicion) => {
      const v = resolveVoucher({
        emitter: 'responsable_inscripto',
        total: 1210,
        ivaRate: 21,
        receiver: { cuit: '30712345671', condicionIvaReceptorId: condicion },
      });

      expect(v.letter).toBe('B');
      expect(v.cbteTipo).toBe(6);
      expect(v.docTipo).toBe(80);
      expect(v.docNro).toBe(30712345671);
      expect(v.condicionIvaReceptorId).toBe(condicion);
      expect(v.iva).toEqual([{ Id: 5, BaseImp: 1000, Importe: 210 }]);
    },
  );

  it('Monotributo con receptor RI → sigue siendo C, identificada con el CUIT', () => {
    const v = resolveVoucher({
      emitter: 'monotributo',
      total: 1210,
      ivaRate: 21,
      receiver: { cuit: '30712345671', condicionIvaReceptorId: 1 },
    });

    expect(v.letter).toBe('C');
    expect(v.cbteTipo).toBe(11);
    expect(v.docTipo).toBe(80);
    expect(v.docNro).toBe(30712345671);
    expect(v.condicionIvaReceptorId).toBe(1);
    expect(v.impNeto).toBe(1210);
    expect(v.impIva).toBe(0);
    expect(v.iva).toBeUndefined();
  });
});

describe('letterFor', () => {
  it('sólo un RI emite A o B; el resto siempre C', () => {
    expect(letterFor('responsable_inscripto', null)).toBe('B');
    expect(letterFor('responsable_inscripto', 1)).toBe('A');
    expect(letterFor('responsable_inscripto', 4)).toBe('B');
    expect(letterFor('monotributo', 1)).toBe('C');
    expect(letterFor('exento', 6)).toBe('C');
  });
});
