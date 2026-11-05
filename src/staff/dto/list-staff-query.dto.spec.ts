import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListStaffQueryDto } from './list-staff-query.dto';

describe('ListStaffQueryDto searchField', () => {
  it.each([undefined, 'all', 'name', 'email'])(
    'accepts %s',
    async (searchField) => {
      const errors = await validate(
        plainToInstance(ListStaffQueryDto, { searchField }),
      );
      expect(errors).toHaveLength(0);
    },
  );

  it.each([
    { searchField: 'phone' },
    { searchField: 'name,email' },
    { searchField: ['name', 'email'] },
  ])('rejects an unsupported field: %s', async ({ searchField }) => {
    const errors = await validate(
      plainToInstance(ListStaffQueryDto, { searchField }),
    );
    expect(
      errors.some(
        (error) =>
          error.property === 'searchField' && error.constraints?.isEnum,
      ),
    ).toBe(true);
  });
});
