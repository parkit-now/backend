import { Prisma } from '@prisma/client';
import {
  addressCreateData,
  addressUpdateData,
  describeMissingAddressFields,
  missingDeclaredAddressFields,
  readDeclaredAddress,
  resolveAddressLine,
  toEntityAddressDto,
  type TenantAddressColumns,
} from './tenant-address';

function row(overrides: Partial<TenantAddressColumns> = {}) {
  return {
    address: null,
    streetName: null,
    streetNumber: null,
    floor: null,
    cityName: null,
    stateName: null,
    postalCode: null,
    latitude: null,
    longitude: null,
    geocodingSource: null,
    geocodedAt: null,
    ...overrides,
  } satisfies TenantAddressColumns;
}

describe('tenant-address', () => {
  describe('toEntityAddressDto', () => {
    it('coerce Decimal a number y Date a ISO', () => {
      const dto = toEntityAddressDto(
        row({
          address: 'Av. Corrientes 1234, CABA',
          latitude: new Prisma.Decimal('-34.603722'),
          longitude: new Prisma.Decimal('-58.381592'),
          geocodedAt: new Date('2026-09-13T16:46:17.000Z'),
        }),
      );

      expect(dto.formatted).toBe('Av. Corrientes 1234, CABA');
      expect(dto.latitude).toBe(-34.603722);
      expect(dto.longitude).toBe(-58.381592);
      expect(dto.geocodedAt).toBe('2026-09-13T16:46:17.000Z');
    });

    it('descarta un geocoding_source que no esté en el conjunto cerrado', () => {
      // La base lo prohíbe con un CHECK, pero el mapper no confía: una fila
      // escrita por fuera (seed, script) no puede filtrar basura al contrato.
      expect(
        toEntityAddressDto(row({ geocodingSource: 'google' })).geocodingSource,
      ).toBeNull();
      expect(
        toEntityAddressDto(row({ geocodingSource: 'manual' })).geocodingSource,
      ).toBe('manual');
    });
  });

  describe('readDeclaredAddress', () => {
    it('tolera la forma vieja: sólo `address` plano, sin objeto `location`', () => {
      const address = readDeclaredAddress({
        name: 'Centro',
        address: 'Av. Corrientes 1234, CABA',
      });

      expect(address.formatted).toBe('Av. Corrientes 1234, CABA');
      expect(address.streetName).toBeNull();
      expect(address.cityName).toBeNull();
      expect(address.latitude).toBeNull();
      expect(address.geocodedAt).toBeNull();
    });

    it('lee la forma nueva y le da prioridad sobre el `address` plano', () => {
      const address = readDeclaredAddress({
        address: 'lo que tipeó el usuario',
        location: {
          formatted: 'Av. Corrientes 1234, Balvanera, CABA',
          streetName: 'Avenida Corrientes',
          streetNumber: 'S/N',
          cityName: 'Balvanera',
          latitude: -34.603722,
          longitude: -58.381592,
          geocodingSource: 'georef',
          geocodedAt: '2026-09-13T16:46:17.000Z',
        },
      });

      expect(address.formatted).toBe('Av. Corrientes 1234, Balvanera, CABA');
      expect(address.streetName).toBe('Avenida Corrientes');
      // Altura como texto: "S/N" es una altura real.
      expect(address.streetNumber).toBe('S/N');
      expect(address.latitude).toBe(-34.603722);
      expect(address.geocodingSource).toBe('georef');
      expect(address.geocodedAt).toBe('2026-09-13T16:46:17.000Z');
    });

    it('no explota con un declared_entity vacío ni con basura en `location`', () => {
      expect(readDeclaredAddress({}).formatted).toBeNull();
      expect(
        readDeclaredAddress({ location: 'no soy un objeto' }).formatted,
      ).toBeNull();
      expect(readDeclaredAddress({ location: [] }).streetName).toBeNull();
      expect(readDeclaredAddress({ location: null }).cityName).toBeNull();
    });

    it('descarta media coordenada: es peor que ninguna', () => {
      const onlyLat = readDeclaredAddress({ location: { latitude: -34.6 } });
      expect(onlyLat.latitude).toBeNull();
      expect(onlyLat.longitude).toBeNull();

      const paired = readDeclaredAddress({
        location: { latitude: -34.6, longitude: -58.38 },
      });
      expect(paired.latitude).toBe(-34.6);
      expect(paired.longitude).toBe(-58.38);
    });

    it('ignora tipos que no corresponden en vez de propagarlos', () => {
      const address = readDeclaredAddress({
        location: {
          streetName: 42,
          streetNumber: '',
          latitude: 'no es un número',
          longitude: -58.38,
          geocodedAt: 'no es una fecha',
        },
      });

      expect(address.streetName).toBeNull();
      expect(address.streetNumber).toBeNull();
      expect(address.latitude).toBeNull();
      expect(address.longitude).toBeNull();
      expect(address.geocodedAt).toBeNull();
    });
  });

  describe('addressUpdateData', () => {
    it('sólo incluye las claves presentes (patch)', () => {
      const data = addressUpdateData({ cityName: 'Balvanera' });

      expect(data).toEqual({ cityName: 'Balvanera' });
      expect('streetName' in data).toBe(false);
    });

    it('respeta un `null` explícito como borrado', () => {
      expect(addressUpdateData({ postalCode: null })).toEqual({
        postalCode: null,
      });
    });

    it('nunca escribe `address`: esa columna la resuelve el caller', () => {
      const data = addressUpdateData({ formatted: 'Av. Corrientes 1234' });

      expect(data).toEqual({});
    });

    it('convierte `geocodedAt` a Date', () => {
      expect(
        addressUpdateData({ geocodedAt: '2026-09-13T16:46:17.000Z' })
          .geocodedAt,
      ).toEqual(new Date('2026-09-13T16:46:17.000Z'));
      expect(addressUpdateData({ geocodedAt: null }).geocodedAt).toBeNull();
    });
  });

  describe('addressCreateData', () => {
    it('deja todas las columnas explícitas en null cuando no viene nada', () => {
      expect(addressCreateData()).toEqual({
        streetName: null,
        streetNumber: null,
        floor: null,
        cityName: null,
        stateName: null,
        postalCode: null,
        latitude: null,
        longitude: null,
        geocodingSource: null,
        geocodedAt: null,
      });
    });
  });

  describe('resolveAddressLine', () => {
    it('`formatted` le gana al `address` plano legacy', () => {
      expect(
        resolveAddressLine('a mano', { formatted: 'normalizada por Georef' }),
      ).toBe('normalizada por Georef');
    });

    it('cae al `address` plano cuando no hay `formatted`', () => {
      expect(resolveAddressLine('a mano', { cityName: 'Balvanera' })).toBe(
        'a mano',
      );
      expect(resolveAddressLine('a mano')).toBe('a mano');
      expect(resolveAddressLine(undefined)).toBeNull();
    });
  });

  describe('missingDeclaredAddressFields', () => {
    // La regla de COMPLETITUD, espejo de `validateAddress()` del wizard
    // (front-web/src/features/onboarding/validation.ts). La usa `submit()`
    // para no dejar pasar a revisión una solicitud sin domicilio.

    it('una dirección normalizada por Georef alcanza sola', () => {
      // Camino feliz: la persona eligió una sugerencia y no tipeó un campo.
      // Exigirle igual calle/altura/localidad/provincia sería pedirle que
      // repita a mano lo que el autocompletado ya resolvió.
      const address = readDeclaredAddress({
        location: {
          formatted: 'Av. Corrientes 1234, Balvanera, CABA',
          geocodingSource: 'georef',
        },
      });

      expect(missingDeclaredAddressFields(address)).toEqual([]);
    });

    it('los cuatro campos cargados a mano también alcanzan', () => {
      // Georef caído o sin resultados no puede frenar un alta.
      const address = readDeclaredAddress({
        location: {
          streetName: 'Avenida Corrientes',
          streetNumber: '1234',
          cityName: 'Balvanera',
          stateName: 'Ciudad Autónoma de Buenos Aires',
          geocodingSource: 'manual',
        },
      });

      expect(missingDeclaredAddressFields(address)).toEqual([]);
    });

    it('no exige piso, código postal ni coordenadas', () => {
      // Georef NO devuelve CP: exigirlo haría la carga manual más estricta que
      // el propio autocompletado. Y nadie tipea coordenadas.
      const address = readDeclaredAddress({
        location: {
          streetName: 'Avenida Corrientes',
          streetNumber: '1234',
          cityName: 'Balvanera',
          stateName: 'CABA',
        },
      });

      expect(address.postalCode).toBeNull();
      expect(address.latitude).toBeNull();
      expect(missingDeclaredAddressFields(address)).toEqual([]);
    });

    it('un `declared_entity` sin dirección devuelve los cuatro campos', () => {
      expect(missingDeclaredAddressFields(readDeclaredAddress({}))).toEqual([
        'streetName',
        'streetNumber',
        'cityName',
        'stateName',
      ]);
    });

    it('devuelve SÓLO lo que falta cuando la dirección está a medias', () => {
      const address = readDeclaredAddress({
        location: { streetName: 'Avenida Corrientes', streetNumber: '1234' },
      });

      expect(missingDeclaredAddressFields(address)).toEqual([
        'cityName',
        'stateName',
      ]);
    });

    it('`formatted` sin `geocodingSource = georef` NO alcanza', () => {
      // Incluye la forma vieja (sólo `address` plano). Una línea de texto
      // libre no sirve para la ubicación del Store de Mercado Pago, que es
      // para lo que se pide la dirección. Mismo criterio que el front.
      const legacy = readDeclaredAddress({ address: 'Av. Corrientes 1234' });

      expect(legacy.formatted).toBe('Av. Corrientes 1234');
      expect(missingDeclaredAddressFields(legacy)).toHaveLength(4);
    });

    it('`geocodingSource = georef` sin línea de display tampoco alcanza', () => {
      const address = readDeclaredAddress({
        location: { geocodingSource: 'georef' },
      });

      expect(missingDeclaredAddressFields(address)).toHaveLength(4);
    });

    it('un campo con sólo espacios cuenta como vacío', () => {
      const address = readDeclaredAddress({
        location: {
          streetName: '   ',
          streetNumber: '1234',
          cityName: 'Balvanera',
          stateName: 'CABA',
        },
      });

      expect(missingDeclaredAddressFields(address)).toEqual(['streetName']);
    });
  });

  describe('describeMissingAddressFields', () => {
    it('enumera los campos que faltan', () => {
      expect(describeMissingAddressFields(['cityName'])).toBe('cityName');
      expect(describeMissingAddressFields(['cityName', 'stateName'])).toBe(
        'cityName and stateName',
      );
      expect(
        describeMissingAddressFields([
          'streetName',
          'streetNumber',
          'cityName',
        ]),
      ).toBe('streetName, streetNumber and cityName');
    });
  });
});
