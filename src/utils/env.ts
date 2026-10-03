/**
 * `true` en producción. `NODE_ENV=production` es el único flag de entorno que
 * existe (lo fija el `Dockerfile`), así que se centraliza acá para que las
 * reglas "esto nunca en producción" (checkout de dev, camino viejo de las
 * reservas sin pago) lean todas lo mismo.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
