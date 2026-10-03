import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDriverVehicleDto,
  UpdateDriverVehicleDto,
} from './driver-vehicle.dto';

/** Mismas opciones que `main.ts`: lo no declarado también es un 400. */
async function failures<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]),
  );
}

describe('categoría del vehículo del conductor', () => {
  describe('CreateDriverVehicleDto', () => {
    it.each(['car', 'suv', 'pickup', 'van', 'motorcycle'])(
      'acepta la categoría reservable %s',
      async (category) => {
        expect(
          await failures(CreateDriverVehicleDto, {
            plate: 'AB123CD',
            category,
          }),
        ).toEqual({});
      },
    );

    it.each(['bicycle', 'truck', 'other'])(
      'una categoría real pero NO reservable (%s) da 400',
      async (category) => {
        expect(
          await failures(CreateDriverVehicleDto, {
            plate: 'AB123CD',
            category,
          }),
        ).toEqual({ category: ['isIn'] });
      },
    );

    it('el valor viejo suv_pickup ya no existe', async () => {
      expect(
        await failures(CreateDriverVehicleDto, {
          plate: 'AB123CD',
          category: 'suv_pickup',
        }),
      ).toEqual({ category: ['isIn'] });
    });

    it('el campo viejo `kind` se rechaza y falta category', async () => {
      const result = await failures(CreateDriverVehicleDto, {
        plate: 'AB123CD',
        kind: 'car',
      });
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('kind');
    });
  });

  describe('UpdateDriverVehicleDto', () => {
    it('acepta una categoría reservable y rechaza una que no lo es', async () => {
      expect(
        await failures(UpdateDriverVehicleDto, { category: 'van' }),
      ).toEqual({});
      expect(
        await failures(UpdateDriverVehicleDto, { category: 'truck' }),
      ).toEqual({ category: ['isIn'] });
    });
  });
});
