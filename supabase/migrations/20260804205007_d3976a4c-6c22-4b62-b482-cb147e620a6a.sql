CREATE TABLE public.bitacora (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo text NOT NULL,
  entrada text NOT NULL DEFAULT '',
  salida text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bitacora TO authenticated;
GRANT ALL ON public.bitacora TO service_role;
ALTER TABLE public.bitacora ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own bitacora all" ON public.bitacora FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX bitacora_user_created_idx ON public.bitacora (user_id, created_at DESC);