import {
  readCapacity,
  readDesktopCameraConfig,
  readTicketTemplate,
  withCapacity,
  withDesktopCameraConfig,
  withTicketTemplate,
} from './entity-settings';

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

  describe('ticketTemplate', () => {
    const template = {
      version: 1 as const,
      fields: [
        {
          id: 'plate',
          visible: true,
          fontSizePt: 13,
          emphasis: 'bold' as const,
        },
      ],
      cuitOverride: '',
      grossIncomeText: 'IIBB',
      nonFiscalControlText: 'Control no fiscal',
    };

    it('conserva el resto de settings al guardar la plantilla', () => {
      expect(withTicketTemplate({ capacity: { total: 55 } }, template)).toEqual(
        {
          capacity: { total: 55 },
          ticketTemplate: template,
        },
      );
    });

    it('lee una plantilla válida', () => {
      expect(readTicketTemplate({ ticketTemplate: template })).toEqual(
        template,
      );
    });

    it('ignora plantillas corruptas o sin campos válidos', () => {
      expect(readTicketTemplate({ ticketTemplate: { fields: [] } })).toBeNull();
      expect(
        readTicketTemplate({
          ticketTemplate: { fields: [{ id: 'campo-raro' }] },
        }),
      ).toBeNull();
    });
  });

  describe('desktopCameraConfig', () => {
    const camera = {
      mode: 'ip' as const,
      deviceIndex: 0,
      host: '192.168.1.26',
      port: 554,
      username: 'admin',
      streamPath: '/h264_stream',
      cameraId: 'entrada',
      location: 'entrada' as const,
      tuning: { roi: [0, 0, 100, 100] },
    };

    it('conserva el resto de settings al guardar cámara', () => {
      expect(
        withDesktopCameraConfig({ capacity: { total: 12 } }, camera),
      ).toEqual({
        capacity: { total: 12 },
        desktopCameraConfig: camera,
      });
    });

    it('lee una config de cámara válida sin contraseña', () => {
      expect(readDesktopCameraConfig({ desktopCameraConfig: camera })).toEqual(
        camera,
      );
    });

    it('ignora configs sin modo válido', () => {
      expect(
        readDesktopCameraConfig({ desktopCameraConfig: { mode: 'otra' } }),
      ).toBeNull();
    });
  });
});
