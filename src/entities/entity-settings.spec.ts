import { readCapacity, withCapacity } from './entity-settings';

describe('entity-settings', () => {
  describe('withCapacity', () => {
    it('conserva el resto de las claves de settings', () => {
      // La razón de ser del helper. `applications.service.approve()` escribía
      // `settings: { capacity }` a mano, que PISA el objeto entero: el día que
      // haya una segunda clave, ese literal la borra sin avisar. Es también el
      // motivo por el que la dirección estructurada vive en columnas y no acá.
      const result = withCapacity(
        { capacity: { total: 10 }, algoQueVieneDespues: { on: true } },
        { total: 55 },
      );

      expect(result).toEqual({
        capacity: { total: 55 },
        algoQueVieneDespues: { on: true },
      });
    });

    it('arranca de cero cuando settings no es un objeto', () => {
      expect(withCapacity(null, { total: 7 })).toEqual({
        capacity: { total: 7 },
      });
      expect(withCapacity([], { total: 7 })).toEqual({
        capacity: { total: 7 },
      });
    });

    it('no muta el settings original', () => {
      const original = { capacity: { total: 10 }, otra: 1 };

      withCapacity(original, { total: 55 });

      expect(original.capacity.total).toBe(10);
    });
  });

  describe('readCapacity', () => {
    it('defaultea a cero cuando no hay capacity', () => {
      expect(readCapacity({})).toEqual({ total: 0 });
      expect(readCapacity(null)).toEqual({ total: 0 });
    });

    it('suma la forma vieja de tres contadores', () => {
      expect(
        readCapacity({
          capacity: { carSpots: 40, motorcycleSpots: 10, bicycleSpots: 5 },
        }),
      ).toEqual({ total: 55 });
    });
  });
});
