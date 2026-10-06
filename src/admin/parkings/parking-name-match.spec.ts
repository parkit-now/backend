import { normalizeParkingName, parkingNameMatches } from './parking-name-match';

describe('parkingNameMatches', () => {
  it('acepta el nombre exacto', () => {
    expect(parkingNameMatches('Playa Centro', 'Playa Centro')).toBe(true);
  });

  it('rechaza otro nombre', () => {
    expect(parkingNameMatches('Playa Norte', 'Playa Centro')).toBe(false);
  });

  it('acepta la misma tilde escrita en NFD y en NFC', () => {
    // El caso que motiva la normalización: el portapapeles de macOS entrega
    // NFD. Los dos strings se ven idénticos en pantalla y `===` los separa.
    const nfc = 'Garage Belgrano Centro Sótano';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(parkingNameMatches(nfd, nfc)).toBe(true);
    expect(parkingNameMatches(nfc, nfd)).toBe(true);
  });

  it('ignora mayúsculas y espacios de los bordes', () => {
    expect(parkingNameMatches('  playa CENTRO  ', 'Playa Centro')).toBe(true);
  });

  it('NO ignora espacios del medio: siguen siendo nombres distintos', () => {
    expect(parkingNameMatches('PlayaCentro', 'Playa Centro')).toBe(false);
  });

  it('un nombre vacío no confirma un estacionamiento con nombre', () => {
    expect(parkingNameMatches('', 'Playa Centro')).toBe(false);
    expect(parkingNameMatches('   ', 'Playa Centro')).toBe(false);
  });

  it('normaliza a NFC, no a NFD', () => {
    expect(normalizeParkingName('Sótano'.normalize('NFD'))).toBe(
      'sótano'.normalize('NFC'),
    );
  });
});
