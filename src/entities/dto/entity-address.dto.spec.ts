import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateEntityAddressDto } from './entity-address.dto';

function errorsOf(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(UpdateEntityAddressDto, payload);
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);
}

describe('UpdateEntityAddressDto', () => {
  describe('coordenadas de a pares', () => {
    // La base tiene el CHECK `tenants_coordinates_paired`, pero en Prisma 7
    // con `@prisma/adapter-pg` una violación de CHECK llega como
    // `DriverAdapterError` y el filter de errores no la mapea: sería un 500
    // opaco. Por eso el par también se valida acá, donde da un 400 que nombra
    // el campo que falta.
    it('rechaza latitude sin longitude', () => {
      expect(errorsOf({ latitude: -34.603722 })).toEqual(['longitude']);
    });

    it('rechaza longitude sin latitude', () => {
      expect(errorsOf({ longitude: -58.381592 })).toEqual(['latitude']);
    });

    it('rechaza una mitad en null y la otra cargada', () => {
      expect(errorsOf({ latitude: null, longitude: -58.381592 })).toEqual([
        'latitude',
      ]);
    });

    it('acepta el par completo', () => {
      expect(errorsOf({ latitude: -34.603722, longitude: -58.381592 })).toEqual(
        [],
      );
    });

    it('acepta que no haya coordenadas', () => {
      expect(errorsOf({ cityName: 'Balvanera' })).toEqual([]);
    });

    it('acepta borrar el par entero con null', () => {
      expect(errorsOf({ latitude: null, longitude: null })).toEqual([]);
    });
  });

  describe('rangos y precisión', () => {
    it('rechaza latitud fuera de [-90, 90]', () => {
      expect(errorsOf({ latitude: 91, longitude: 0 })).toEqual(['latitude']);
    });

    it('rechaza longitud fuera de [-180, 180]', () => {
      expect(errorsOf({ latitude: 0, longitude: -181 })).toEqual(['longitude']);
    });

    it('rechaza más de 6 decimales (la columna es numeric(9,6))', () => {
      expect(errorsOf({ latitude: -34.6037221, longitude: 0 })).toEqual([
        'latitude',
      ]);
    });
  });

  describe('geocodingSource', () => {
    it('acepta sólo el conjunto cerrado', () => {
      expect(errorsOf({ geocodingSource: 'georef' })).toEqual([]);
      expect(errorsOf({ geocodingSource: 'manual' })).toEqual([]);
      expect(errorsOf({ geocodingSource: 'google' })).toEqual([
        'geocodingSource',
      ]);
    });
  });

  describe('streetNumber', () => {
    it('acepta alturas que no son números', () => {
      // El motivo por el que la columna es `text` y no `int`.
      expect(errorsOf({ streetNumber: 'S/N' })).toEqual([]);
      expect(errorsOf({ streetNumber: '1234 bis' })).toEqual([]);
      expect(errorsOf({ streetNumber: 'Km 5' })).toEqual([]);
    });
  });

  describe('forbidNonWhitelisted', () => {
    it('rechaza un campo que no está declarado en el DTO', () => {
      // El ValidationPipe global usa `forbidNonWhitelisted: true`: un typo del
      // front es un 400, no un campo ignorado en silencio.
      expect(errorsOf({ street_name: 'Avenida Corrientes' })).toEqual([
        'street_name',
      ]);
    });
  });
});
