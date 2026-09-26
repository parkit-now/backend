import { isValidCuit, normalizeCuit } from './arca-cuit';

describe('isValidCuit', () => {
  it('acepta un CUIT con el dígito verificador correcto', () => {
    expect(isValidCuit('20123456786')).toBe(true);
    expect(isValidCuit('30500010912')).toBe(true);
  });

  it('rechaza un dígito verificador equivocado', () => {
    expect(isValidCuit('20123456787')).toBe(false);
  });

  it('rechaza lo que no son 11 dígitos', () => {
    expect(isValidCuit('2012345678')).toBe(false);
    expect(isValidCuit('20-12345678-6')).toBe(false);
  });

  it('normalizeCuit saca guiones y espacios', () => {
    expect(normalizeCuit('20-12345678-6')).toBe('20123456786');
    expect(normalizeCuit(' 20 12345678 6 ')).toBe('20123456786');
  });
});
