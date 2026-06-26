-- CI database provisioning (SCM-S57): make a vanilla Postgres match the
-- (Supabase-authored) schema so the migrations apply and the DB-touching tests
-- can run. Mirrors infra/plain-pg provisioning. Idempotent.

-- pgvector + helpers live in an `extensions` schema (the schema references extensions.vector).
CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION IF EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vector      SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
ALTER DATABASE postgres SET search_path TO "$user", public, extensions;

-- Placeholder roles so the schema's GRANTs / RLS policies apply (no Supabase auth in CI).
DO $$ BEGIN CREATE ROLE anon           NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated  NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role   NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticator  NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT anon, authenticated, service_role TO postgres;
