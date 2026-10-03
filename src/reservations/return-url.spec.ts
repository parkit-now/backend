import { isAllowedReturnUrl } from './return-url';

describe('isAllowedReturnUrl', () => {
  it.each([
    'parkit://reservas',
    'parkit://reservas?x=1',
    'exp://192.168.0.5:8081/--/reservas',
    'http://localhost:8081/reservas',
  ])('acepta %s', (url) => {
    expect(isAllowedReturnUrl(url)).toBe(true);
  });

  it.each([
    '',
    'https://evil.com',
    'http://localhost:8081',
    'http://localhost:8081.evil.com/x',
    'http://localhost:8081@evil.com/',
    'http://localhost:3000/x',
    'javascript:alert(1)',
    'PARKIT://reservas',
    ' parkit://reservas',
    'parkit://re servas',
    'parkit://reservas\r\nLocation: https://evil.com',
    'parkit://reservas\u0000',
  ])('rechaza %j', (url) => {
    expect(isAllowedReturnUrl(url)).toBe(false);
  });

  it('rechaza null y undefined', () => {
    expect(isAllowedReturnUrl(null)).toBe(false);
    expect(isAllowedReturnUrl(undefined)).toBe(false);
  });
});
