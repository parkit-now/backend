-- Storage bucket for LPR detection event photos.
--
-- Unlike `application-documents` (owned 1:1 by the applicant's auth.uid()),
-- an LPR detection event belongs to a TENANT and is reviewed by any of its
-- operators/owners — membership isn't derivable from the JWT alone (see
-- TenantMembershipGuard). So this bucket has NO client-facing RLS policies:
-- it's deny-by-default at the storage layer, and access is mediated
-- entirely by the backend (StorageService, service-role) behind the same
-- TenantMembershipGuard that already protects every `lpr-events` endpoint.
--
-- Path convention: `<tenantId>/<lprDetectionEventId>.jpg`.

-- Private bucket (no public read). Idempotent so `supabase start` and
-- `make reset` both stay green.
INSERT INTO storage.buckets (id, name, public)
VALUES ('lpr-detection-images', 'lpr-detection-images', false)
ON CONFLICT (id) DO NOTHING;
