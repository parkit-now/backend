/** Piezas compartidas por las páginas de retorno del checkout (dev y Mercado Pago). */

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  );

export const page = (title: string, body: string): string => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  .card{border:1px solid #ddd;border-radius:12px;padding:1.25rem}
  .tag{display:inline-block;background:#fff3cd;border-radius:6px;padding:.1rem .5rem;font-size:.8rem}
  dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#666}dd{margin:0}
  button{width:100%;padding:.8rem;margin-top:.6rem;border:0;border-radius:8px;font-size:1rem;cursor:pointer}
  .ok{background:#16a34a;color:#fff}.no{background:#dc2626;color:#fff}
  label{display:block;margin-top:.8rem;font-size:.9rem}
</style></head><body>${body}</body></html>`;

export function withResult(
  returnUrl: string,
  reservationId: string,
  status: string,
): string {
  try {
    const url = new URL(returnUrl);
    url.searchParams.set('reservationId', reservationId);
    url.searchParams.set('status', status);
    return url.toString();
  } catch {
    const separator = returnUrl.includes('?') ? '&' : '?';
    return `${returnUrl}${separator}reservationId=${reservationId}&status=${status}`;
  }
}
