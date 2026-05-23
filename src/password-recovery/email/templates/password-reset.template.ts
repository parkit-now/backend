interface PasswordResetTemplateInput {
  resetUrl: string;
  ttlMinutes: number;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderPasswordResetEmail(
  input: PasswordResetTemplateInput,
): RenderedEmail {
  const { resetUrl, ttlMinutes } = input;
  const subject = 'Recuperá tu contraseña de Parkit';

  const text = [
    'Recibimos un pedido para restablecer tu contraseña de Parkit.',
    '',
    `Abrí este link para elegir una nueva contraseña (vence en ${ttlMinutes} minutos):`,
    resetUrl,
    '',
    'Si no fuiste vos, ignorá este mensaje — tu contraseña actual sigue siendo válida.',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="es">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; line-height: 1.5; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #111827; margin: 0 0 16px;">Recuperá tu contraseña</h2>
    <p>Recibimos un pedido para restablecer tu contraseña de Parkit.</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Elegir nueva contraseña</a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">El link vence en ${ttlMinutes} minutos. Si no fuiste vos, ignorá este mensaje — tu contraseña actual sigue siendo válida.</p>
    <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">Si el botón no funciona, copiá y pegá esta URL en tu navegador:<br/><span style="word-break: break-all;">${resetUrl}</span></p>
  </body>
</html>`;

  return { subject, html, text };
}
