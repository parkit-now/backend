import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateServiceDto } from './update-service.dto';

async function failures(
  body: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateServiceDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]),
  );
}

describe('UpdateServiceDto.reservationVehicleCategories', () => {
  it('acepta las cinco categorías reservables', async () => {
    expect(
      await failures({
        reservationVehicleCategories: [
          'car',
          'suv',
          'pickup',
          'van',
          'motorcycle',
        ],
      }),
    ).toEqual({});
  });

  it.each(['bicycle', 'truck', 'other', 'suv_pickup'])(
    'rechaza %s (no reservable o valor viejo)',
    async (category) => {
      expect(
        await failures({ reservationVehicleCategories: ['car', category] }),
      ).toEqual({ reservationVehicleCategories: ['isIn'] });
    },
  );

  it('rechaza duplicados', async () => {
    expect(
      await failures({ reservationVehicleCategories: ['car', 'car'] }),
    ).toEqual({ reservationVehicleCategories: ['arrayUnique'] });
  });
});
