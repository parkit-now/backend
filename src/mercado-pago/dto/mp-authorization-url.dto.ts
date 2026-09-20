import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Techo de largo del `returnPath`. Una ruta del panel no llega ni cerca. */
export const MAX_RETURN_PATH_LENGTH = 512;

/**
 * Qué cuenta como ruta INTERNA del panel, y por qué cada pieza.
 *
 * 🔴 Esto es la defensa contra un OPEN REDIRECT. El `returnPath` se guarda al
 * iniciar el OAuth y el front lo usa para volver después del callback. Si se
 * acepta cualquier string, el flujo se convierte en un redirector abierto con
 * el dominio de Parkit adelante: un mail de phishing manda a
 * `parkit.com/...?returnPath=https://evil.com`, la víctima ve NUESTRO dominio,
 * y termina en la página del atacante ya "autenticada" mentalmente.
 *
 * | Pieza                 | Qué frena                                          |
 * | --------------------- | -------------------------------------------------- |
 * | `^\/`                 | `https://evil.com`, `javascript:alert(1)`, `evil`   |
 * | `(?![/\\])`           | `//evil.com` y `/\evil.com` (protocol-relative)      |
 * | lista blanca de chars | backslashes, espacios y caracteres de control       |
 *
 * Los dos últimos NO son paranoia de más:
 *
 *  - `//evil.com` es una URL protocol-relative VÁLIDA: el navegador la resuelve
 *    a `https://evil.com`. Empieza con `/`, así que el chequeo ingenuo
 *    "arranca con barra" la deja pasar entera.
 *  - `/\evil.com` es lo mismo con backslash: los navegadores normalizan `\` a
 *    `/` al resolver URLs, así que termina siendo `//evil.com`.
 *  - Los caracteres de control (tab, CR, LF, NUL) se STRIPEAN antes de resolver
 *    la URL, así que una ruta con un tab en el medio se puede colar como
 *    `//evil.com`.
 *
 * El último se resuelve con una LISTA BLANCA —los caracteres que RFC 3986
 * permite en path, query y fragment— y no con una lista negra de controles:
 * una lista negra hay que acordarse de mantenerla, y además obligaría a meter
 * un rango de caracteres de control en el regex, que es exactamente lo que la
 * regla `no-control-regex` marca. Consecuencia asumida: una ruta con acentos
 * hay que mandarla percent-encodeada (`/configuraci%C3%B3n`), que es como viaja
 * igual en una URL real.
 *
 * Una vez que arranca con UNA sola barra y sólo tiene caracteres de esa lista,
 * es una URL relativa: no puede cambiar de host. Ahí se termina el riesgo.
 */
export const INTERNAL_PATH_PATTERN =
  /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=@/?#]*$/;

/**
 * Predicado equivalente al `@Matches` de abajo, para que el service pueda
 * revalidar sin depender de que el `ValidationPipe` haya corrido.
 *
 * No es redundancia por las dudas: el service es el que PERSISTE, y es el
 * único punto por el que pasan todos los caminos (HTTP, tests, un futuro
 * comando). Validar sólo en el DTO deja la regla atada a que nadie llame al
 * service de otro lado.
 */
export function isSafeReturnPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_RETURN_PATH_LENGTH &&
    INTERNAL_PATH_PATTERN.test(value)
  );
}

/** Body de `POST /tenants/:tenantId/mercado-pago/oauth/authorization-url`. */
export class CreateMpAuthorizationUrlDto {
  @ApiPropertyOptional({
    description:
      'Internal panel route to return to after the callback. Must be a relative path starting with a single `/`: absolute URLs, protocol-relative paths (`//host`) and schemes (`javascript:`) are rejected to keep the callback from becoming an open redirect.',
    maxLength: MAX_RETURN_PATH_LENGTH,
    example: '/configuracion/cobros',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RETURN_PATH_LENGTH)
  @Matches(INTERNAL_PATH_PATTERN, {
    message:
      'returnPath must be an internal path starting with a single "/" (no scheme, no host, no backslashes)',
  })
  returnPath?: string;
}

/** Respuesta: a dónde mandar al dueño y hasta cuándo vale ese `state`. */
export class MpAuthorizationUrlDto {
  @ApiProperty({
    description:
      'Mercado Pago authorization URL the owner must open to grant access. Carries the PKCE `code_challenge` and the single-use `state`.',
    example:
      'https://auth.mercadopago.com/authorization?client_id=123&response_type=code&platform_id=mp&state=6f9619ff-8b86-4d01-b42d-00cf4fc964ff&redirect_uri=https%3A%2F%2Fpanel.parkit.app%2Fintegraciones%2Fmercadopago%2Fcallback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
  })
  authorizationUrl: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The single-use `state` tying the callback to this flow. Returned so the client can correlate, never to be reused.',
    example: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
  })
  state: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the `state` expires (10 minutes), matching the lifetime of the Mercado Pago authorization code itself.',
    example: '2026-09-14T01:10:00.000Z',
  })
  expiresAt: string;
}
