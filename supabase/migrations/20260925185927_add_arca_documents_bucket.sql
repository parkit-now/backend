-- Storage bucket para los documentos de ARCA de cada playa (hoy, la constancia
-- del punto de venta que se sube en el paso 3 del wizard de vinculación).
--
-- Igual que `lpr-detection-images`: el documento es de un TENANT y la
-- pertenencia no sale del JWT (ver TenantMembershipGuard), así que el bucket
-- NO tiene policies para clientes. Es deny-by-default en la capa de storage y
-- todo el acceso pasa por el backend (StorageService, service-role) detrás del
-- mismo guard que protege `/tenants/:tenantId/arca/*`.
--
-- Convención de path: `<tenantId>/pto-vta-constancia.pdf`.

-- Privado (sin lectura pública). Idempotente para que `supabase start` y
-- `make reset` sigan en verde.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('arca-documents', 'arca-documents', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;
