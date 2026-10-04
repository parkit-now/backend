import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SearchParkingsQueryDto } from './search-parkings-query.dto';

const check = (plain: Record<string, unknown>) => {
  const dto = plainToInstance(SearchParkingsQueryDto, plain);
  return { dto, errors: validateSync(dto) };
};

describe('SearchParkingsQueryDto', () => {
  it('acepta un texto de 2 letras con o sin coordenadas', () => {
    expect(check({ q: 'on' }).errors).toHaveLength(0);
    const { dto, errors } = check({
      q: 'once',
      latitude: '-34.6',
      longitude: '-58.4',
    });
    expect(errors).toHaveLength(0);
    expect(dto.latitude).toBe(-34.6);
  });

  it('recorta los espacios antes de medir el largo mínimo', () => {
    expect(check({ q: ' a ' }).errors).not.toHaveLength(0);
    expect(check({ q: '  ab  ' }).dto.q).toBe('ab');
  });

  it('rechaza q ausente o demasiado corto', () => {
    expect(check({}).errors).not.toHaveLength(0);
    expect(check({ q: 'a' }).errors).not.toHaveLength(0);
  });

  it('rechaza coordenadas fuera de rango', () => {
    expect(
      check({ q: 'once', latitude: '99', longitude: '-58' }).errors,
    ).not.toHaveLength(0);
  });
});
