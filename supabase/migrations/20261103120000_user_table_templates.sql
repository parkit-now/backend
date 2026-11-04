-- Personal, platform-specific table views, including global administration tables.
CREATE TABLE public.user_table_templates (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  platform varchar(10) NOT NULL CHECK (platform IN ('web', 'desktop')),
  context_key varchar(40) NOT NULL CHECK (context_key = 'admin' OR context_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
  table_key varchar(100) NOT NULL,
  id varchar(200) NOT NULL,
  name varchar(150) NOT NULL,
  description varchar(1000),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, platform, context_key, table_key, id)
);
CREATE TABLE public.user_table_template_mutations (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);
ALTER TABLE public.user_table_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_table_template_mutations ENABLE ROW LEVEL SECURITY;
-- Clients go through Nest for writes (validation, receipts and authorization).
REVOKE ALL ON public.user_table_templates FROM authenticated, anon;
GRANT SELECT ON public.user_table_templates TO authenticated;
REVOKE ALL ON public.user_table_template_mutations FROM authenticated, anon;
CREATE POLICY table_templates_read_own ON public.user_table_templates
FOR SELECT TO authenticated USING (
  user_id = (SELECT auth.uid())
  AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    OR EXISTS (
      SELECT 1 FROM public.user_memberships m JOIN public.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = auth.uid() AND m.tenant_id::text = context_key AND t.deleted_at IS NULL
    )
  )
);
