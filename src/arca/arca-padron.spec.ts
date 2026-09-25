import { parseTaxpayer } from './arca-padron';

const domicilio = {
  direccion: 'AV SIEMPRE VIVA 742',
  localidad: 'CABA',
  descripcionProvincia: 'CIUDAD AUTONOMA BUENOS AIRES',
};

describe('parseTaxpayer', () => {
  it('monotributo: datosMonotributo presente', () => {
    const data = parseTaxpayer({
      datosGenerales: {
        apellido: 'PEREZ',
        nombre: 'JUAN',
        domicilioFiscal: domicilio,
      },
      datosMonotributo: { categoriaMonotributo: {} },
    });

    expect(data).toEqual({
      razonSocial: 'PEREZ JUAN',
      condicionIva: 'monotributo',
      domicilioFiscal:
        'AV SIEMPRE VIVA 742, CABA, CIUDAD AUTONOMA BUENOS AIRES',
    });
  });

  it('responsable inscripto: impuesto 30 (IVA), también como objeto suelto', () => {
    const data = parseTaxpayer({
      datosGenerales: { razonSocial: 'PARKIT SA' },
      datosRegimenGeneral: { impuesto: { idImpuesto: 30 } },
    });

    expect(data?.razonSocial).toBe('PARKIT SA');
    expect(data?.condicionIva).toBe('responsable_inscripto');
  });

  it('exento: impuesto 32', () => {
    const data = parseTaxpayer({
      datosGenerales: { razonSocial: 'CLUB' },
      datosRegimenGeneral: { impuesto: [{ idImpuesto: 32 }] },
    });

    expect(data?.condicionIva).toBe('exento');
  });

  it('sin IVA ni monotributo: condición desconocida', () => {
    const data = parseTaxpayer({ datosGenerales: { razonSocial: 'X' } });

    expect(data?.condicionIva).toBeNull();
  });

  it('null o errorConstancia: no hay datos (el padrón de homologación)', () => {
    expect(parseTaxpayer(null)).toBeNull();
    expect(
      parseTaxpayer({ datosGenerales: {}, errorConstancia: { error: 'x' } }),
    ).toBeNull();
  });
});
