-- Storage bucket for onboarding application documents.
--
-- The binary of each supporting document is uploaded directly from the client
-- to Supabase Storage; `application_documents` only keeps its metadata
-- (name, storage_path, mime_type). This migration provisions the bucket and the
-- RLS policies that let an applicant upload/read the documents of THEIR OWN
-- onboarding applications. PARKIT Ops (service-role on the backend) bypasses
-- RLS and can read every object.
--
-- Path convention (enforced by the policies): `applications/<userId>/<applicationId>/<file>`.
-- Ownership is encoded in the path via the caller's `auth.uid()` so the policies
-- can authorize from the JWT alone — `onboarding_applications` is backend-only
-- (RLS with no policies), so a per-user storage policy cannot read it. PARKIT Ops
-- reads documents server-side with the service role, which bypasses RLS.

-- Private bucket (no public read). Idempotent so `supabase start` (which may also
-- create it from config.toml) and `make reset` both stay green.
INSERT INTO storage.buckets (id, name, public)
VALUES ('application-documents', 'application-documents', false)
ON CONFLICT (id) DO NOTHING;

-- INSERT: an authenticated user may upload only under
-- `applications/<their auth.uid()>/...`.
CREATE POLICY "applicants upload own application documents"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'application-documents'
    AND (storage.foldername(name))[1] = 'applications'
    AND (storage.foldername(name))[2] = auth.uid()::text
);

-- SELECT: same ownership rule, so applicants can list/download their own docs.
CREATE POLICY "applicants read own application documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'application-documents'
    AND (storage.foldername(name))[1] = 'applications'
    AND (storage.foldername(name))[2] = auth.uid()::text
);
