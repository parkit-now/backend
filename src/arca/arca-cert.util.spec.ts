import { parseArcaCertificate } from './arca-cert.util';

/**
 * Autofirmado y descartable (clave tirada a /dev/null al generarlo), con el
 * subject que arma ARCA: `serialNumber=CUIT <11 dígitos>`.
 */
const CERT = `-----BEGIN CERTIFICATE-----
MIIDiTCCAnGgAwIBAgIUagaJlffda7jLDBt/ow1tbEcSOZowDQYJKoZIhvcNAQEL
BQAwUzELMAkGA1UEBhMCQVIxFDASBgNVBAoMC1BhcmtpdCBUZXN0MRMwEQYDVQQD
DApwYXJraXR0ZXN0MRkwFwYDVQQFExBDVUlUIDIwMDAwMDAwMDAxMCAXDTI2MDky
NTAwMTU0OVoYDzIxMjYwOTAxMDAxNTQ5WjBTMQswCQYDVQQGEwJBUjEUMBIGA1UE
CgwLUGFya2l0IFRlc3QxEzARBgNVBAMMCnBhcmtpdHRlc3QxGTAXBgNVBAUTEENV
SVQgMjAwMDAwMDAwMDEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5
WEjeDMKRrfn7Ni02axCkLPtICu01bcBhm1RXEv2jewyT+KWMMQQ0nhyOftgDhug0
FQsDnQTKugmhAUXeYcR0BXsBp1WyKJUTv2UTtZHj2tpPE9JtMnU6NtpOUzYsMJHu
9KFn+oHxkEAdEOPy9E3Lg8goakvHFOxYVeP2+B0a6pACR8IXTnRgv37hgBvXpTjW
vJN01CmhTWbPvR65QQHOA7wILX7K65PHTmwSIpYrEXu0tWPbCH18+1Wm5FAvv46O
lLUcZieOi69c9l8CsJ59K068nhtWGhBFl1CDM1zSPvNIb8sVcSEugi5YPAUUK1MA
fsjgh9jWdofe93vMe9nPAgMBAAGjUzBRMB0GA1UdDgQWBBRCtHaWlH9j6H6hZMmy
XtXxbKqHmTAfBgNVHSMEGDAWgBRCtHaWlH9j6H6hZMmyXtXxbKqHmTAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAr2YF/gIB5entNU0oct/a2Z+EB
yA+l0r4ROuzBjPuT849YA2D4CXiRrRnjSZTFKvuxp7f365Q0U20bQdT55TcCEfPp
MVkSmKUoKhTBafzS6mZ8EeXec6PKWFf1JmrzlytpOjbF52MUe6I1eXDFRLiNtJrN
g8vI/cemYSUJS54U7bgaeTTMXVtquI46nJx5BOKyK+AELOLLvQDKHXJZmwsZjX1b
+bDiCoLQl+LrEjzBNYFIvDaKE9wvdhCylJmNyCXoGO2UjBTLC2rlWV1XPN6p6ix0
BtZhhV/TYaaRcKRWZDY1a2bgWJlG2oYJ6AKkaGeU7CYo37ngwzpFD0QgifK1
-----END CERTIFICATE-----`;

describe('parseArcaCertificate', () => {
  it('saca el CUIT del serialNumber, el vencimiento y la huella SHA-256', () => {
    const cert = parseArcaCertificate(CERT);

    expect(cert.cuit).toBe('20000000001');
    expect(cert.notAfter.getUTCFullYear()).toBe(2126);
    expect(cert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un PEM que no es certificado falla', () => {
    expect(() => parseArcaCertificate('no soy un certificado')).toThrow();
  });
});
