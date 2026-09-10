-- ═══════════════════════════════════════════════════════════════════════════
-- Vastos ARC — Supabase compatibility shim  (Phase 5, item 1)
--
-- The 66 migrations in the frontend repo's supabase/migrations/ were written
-- against hosted Supabase. Replayed verbatim onto a vanilla PostgreSQL 17
-- database they reference Supabase-provided objects and, more subtly, a set of
-- Supabase-provided DEFAULT PRIVILEGES that make the whole security-phase
-- narrative (C1 / C1b / C4 revoke what Supabase granted) make sense.
--
-- This file recreates just enough of that environment, then hands control to
-- the migration tree unchanged.
--
-- Run this ONCE, before any migration, against an empty `vastos` database, as
-- the bootstrap superuser. db/replay.sh does exactly that, and then runs every
-- migration with `SET ROLE postgres` so objects are owned by `postgres` and
-- Supabase's `for role postgres` default-privilege logic (which the C1b/C4
-- migrations target by name) applies verbatim.
--
-- What Supabase gives you that this replaces:
--   1. roles  anon / authenticated / service_role / postgres
--   2. Supabase's public-schema default privileges (GRANT ALL to anon /
--      authenticated / service_role on new tables, sequences, functions) — the
--      thing C1 / C1b / C4 exist to walk back
--   3. schema `auth` + auth.uid()            (RLS reads the caller from here)
--   4. table  auth.users                     (2 read-only refs in the tree)
--   5. schema `extensions` + pgcrypto        (digest / gen_random_bytes)
--   6. schema `vault` + secrets/create/update (Meta OAuth token storage, 1 mig)
--   7. database search_path incl. `extensions`
--
-- Confirmed NOT needed (never referenced by any migration): storage.*, realtime,
-- graphql, pg_net / net.http, pgsodium, pgmq, supabase_functions, auth.jwt(),
-- auth.role(), the `authenticator` role.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- ── 1 · Roles ──────────────────────────────────────────────────────────────
--   anon           C1/C4 revoke everything from it again; kept so the
--                  dev-anon-policy migrations and their later DROPs resolve.
--   authenticated  the real client role. RLS applies.
--   service_role   BYPASSRLS, to match Supabase. Item 2's caller-context
--                  lookups use a connection that assumes this role.
--   postgres       Supabase's migration/owner role. replay.sh runs every
--                  migration as this role; the C1b/C4 migrations alter default
--                  privileges "for role postgres" by name.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres superuser noinherit nologin;
  end if;
end $$;

-- The bootstrap superuser must be able to SET ROLE into these.
do $$
declare me text := current_user;
begin
  execute format('grant anon, authenticated, service_role, postgres to %I', me);
end $$;


-- ── 2 · Supabase's public-schema privileges & default privileges ───────────
-- Supabase grants USAGE on `public` and ALL on every present + future table /
-- sequence / function to anon, authenticated and service_role. RLS — not the
-- grant — is the gate. The entire Phase 1–3 security effort (C1, C1b, C4, …) is
-- about clawing this back where it should never have applied. Replaying those
-- migrations onto a database that never had the grants makes their assertions
-- ("existing tables lost their authenticated grants", "a new function must not
-- be anon-executable", …) fire on the wrong side.
--
-- Set as role `postgres`, because that is the grantor the migrations name when
-- they revoke, and because replay.sh creates every object as `postgres`.
set role postgres;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;


-- ── 3 · extensions schema + pgcrypto ───────────────────────────────────────
-- ~4 refs to extensions.digest() / extensions.gen_random_bytes() in
-- security_phase3_c9_w1c_lead_intake and security_phase3_h7_meta_oauth, plus an
-- unqualified `encode(gen_random_bytes(32),'hex')` column default in
-- phase1_auth_subscriptions. Those call sites qualify with `extensions.`, so
-- pgcrypto MUST live in that schema. Migration 01's `create extension if not
-- exists pgcrypto` then becomes a no-op.
create schema if not exists extensions;

-- The Phase-0 VPS bootstrap already installed pgcrypto (per the handoff, into
-- the default schema — `public`). A bare `create extension if not exists` would
-- leave it there and every `extensions.digest(...)` call would fail. Relocate
-- it; the DB has no app schema yet so nothing depends on it.
do $$
declare v_ns text;
begin
  select n.nspname into v_ns
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_ns is null then
    create extension pgcrypto with schema extensions;
  elsif v_ns <> 'extensions' then
    alter extension pgcrypto set schema extensions;
  end if;
end $$;

grant usage on schema extensions to public;
grant execute on all functions in schema extensions to public;
alter default privileges in schema extensions grant execute on functions to public;


-- ── 4 · auth schema, auth.uid(), auth.users ────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- The real Supabase definition, verbatim. RLS policies and SECURITY DEFINER
-- helpers across the tree (44 call sites) plus crm_current_role_id(),
-- crm_has_permission(), inv_current_actor() all resolve the caller through
-- this. The value comes from the `request.jwt.claims` GUC — set by PostgREST on
-- hosted Supabase, and set by the NestJS API (item 2) with
--   select set_config('request.jwt.claims',
--                     json_build_object('sub', <verified uid>)::text, true)
-- at the top of every request transaction, after verifying the bearer token.
--
-- NOTE (deviation from the Phase-5 handoff): the handoff proposed a bespoke
-- `app.user_id` GUC. That breaks replay — four Phase 2/3 migration self-test
-- blocks (w1a, h2b, platform_c ×2) impersonate a user with
-- `set_config('request.jwt.claims', json_build_object('sub', ...), true)` and
-- expect auth.uid() to see it. Reading request.jwt.claims keeps those green and
-- keeps us bit-for-bit compatible with Supabase's auth.uid() semantics.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- 2 real references:
--   platform_c_operator_console.sql:1049  select u.id from auth.users u
--                                         where lower(u.email) = v_email
--   02_boq_core_entities.sql:18           comment only
-- Empty is correct for item 1: the platform_c operator seed then RAISE WARNINGs
-- and returns (it is written to tolerate exactly this). Populated from Clerk in
-- item 4, matched to public.profiles by email.
create table if not exists auth.users (
  id    uuid primary key,
  email text
);


-- ── 5 · vault shim (pgcrypto-backed) ───────────────────────────────────────
-- Referenced by exactly one migration: security_phase3_h7_meta_oauth — Meta /
-- Facebook Ads long-lived access-token storage for the Marketing module. It
-- calls vault.create_secret / vault.update_secret and reads back through
-- vault.decrypted_secrets, and its self-test does a full round-trip + rotation,
-- so the shim has to actually encrypt and decrypt.
--
-- Supabase's Vault is pgsodium-backed with an out-of-database root key. This is
-- a pgcrypto (pgp_sym) stand-in with the symmetric key held in a one-row table
-- in this same database. That is weaker than Supabase Vault — anyone with
-- superuser / raw disk / an unencrypted backup can recover the key and thus the
-- tokens. Acceptable pre-launch for a single low-value integration secret;
-- revisit (KMS/age/sops, or real pgsodium) before the Marketing module carries
-- anything sensitive.  ← FLAGGED for the user.
create schema if not exists vault;

create table if not exists vault.secret_keys (
  id  integer primary key default 1,
  key text    not null,
  constraint vault_secret_keys_singleton check (id = 1)
);

-- Generate the key on first install only. replay.sh / deploy can pre-seed a
-- specific key (from a secrets manager) by inserting row id=1 before this file
-- runs; the ON CONFLICT keeps it.
insert into vault.secret_keys (id, key)
values (1, encode(extensions.gen_random_bytes(32), 'base64'))
on conflict (id) do nothing;

create table if not exists vault.secrets (
  id           uuid primary key default gen_random_uuid(),
  name         text unique,
  description  text not null default '',
  secret       bytea not null,                -- raw pgp_sym_encrypt(...) output
  key_id       uuid,                           -- unused; shape parity
  nonce        bytea,                          -- unused; shape parity
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace view vault.decrypted_secrets as
  select
    s.id,
    s.name,
    s.description,
    s.secret,
    extensions.pgp_sym_decrypt(
      s.secret,
      (select key from vault.secret_keys where id = 1)
    ) as decrypted_secret,
    s.key_id,
    s.nonce,
    s.created_at,
    s.updated_at
  from vault.secrets s;

-- Supabase signature:
--   vault.create_secret(new_secret text, new_name text DEFAULT NULL,
--                       new_description text DEFAULT '') RETURNS uuid
create or replace function vault.create_secret(
  new_secret      text,
  new_name        text default null,
  new_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id  uuid;
  v_key text;
begin
  select key into v_key from vault.secret_keys where id = 1;
  if v_key is null then
    raise exception 'vault shim: no symmetric key present';
  end if;

  insert into vault.secrets (name, description, secret)
  values (
    new_name,
    coalesce(new_description, ''),
    extensions.pgp_sym_encrypt(new_secret, v_key)
  )
  returning id into v_id;

  return v_id;
end $$;

-- Supabase signature:
--   vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL,
--                       new_name text DEFAULT NULL,
--                       new_description text DEFAULT NULL) RETURNS void
create or replace function vault.update_secret(
  secret_id       uuid,
  new_secret      text default null,
  new_name        text default null,
  new_description text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_key text;
begin
  select key into v_key from vault.secret_keys where id = 1;

  update vault.secrets s
     set secret      = case when new_secret is null
                            then s.secret
                            else extensions.pgp_sym_encrypt(new_secret, v_key) end,
         name        = coalesce(new_name, s.name),
         description  = coalesce(new_description, s.description),
         updated_at   = now()
   where s.id = secret_id;

  if not found then
    raise exception 'vault shim: no secret with id %', secret_id;
  end if;
end $$;

-- The h7 RPCs that reach the vault are SECURITY DEFINER owned by `postgres`, so
-- they can use these without a grant. Nothing else should.
revoke all on schema vault from public;
revoke all on all tables    in schema vault from public, anon, authenticated;
revoke all on all functions in schema vault from public, anon, authenticated;


-- ── 6 · database search_path ───────────────────────────────────────────────
-- Supabase's role search_path includes `extensions`; a few unqualified
-- pgcrypto calls (and the phase1_auth_subscriptions column default) rely on it.
-- Takes effect on connections opened AFTER this statement — replay.sh opens a
-- fresh psql per migration, so migration 01 onward already sees it.
reset role;
do $$
begin
  execute format(
    'alter database %I set search_path to "$user", public, extensions',
    current_database());
end $$;


-- ── 7 · Application login role ─────────────────────────────────────────────
-- The NestJS API (item 2) connects as this, NOT as the superuser: non-
-- superuser, non-BYPASSRLS, so every existing RLS policy applies. It inherits
-- `authenticated` for the table/function grants the tree hands out, and can
-- assume `service_role` for the handful of caller-context lookups that need to
-- see across the RLS boundary.
--
-- Password is set by replay.sh / deploy (DATABASE_URL). Created here so a fresh
-- replay is immediately usable.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vastos_app') then
    create role vastos_app login;
  end if;
  grant authenticated to vastos_app;
  grant service_role  to vastos_app;
end $$;

grant usage on schema public to vastos_app;
