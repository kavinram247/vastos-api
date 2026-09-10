#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Vastos ARC — replay the Supabase migration tree onto a vanilla Postgres 17
# database (Phase 5, item 1).
#
# Applies db/00-compat-shim.sql, then every supabase/migrations/*.sql from the
# frontend repo in filename order. Fail-fast: stops at the first migration that
# errors and prints which one.
#
# The migrations live in the FRONTEND repo (github.com/kavinram247/Vastos_ARC),
# not here — point MIGRATIONS_DIR at a checkout of it.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   MIGRATIONS_DIR=~/Downloads/vastoArchV1/supabase/migrations \
#   DATABASE_URL=postgres://vastos:pw@127.0.0.1:5432/vastos \
#     db/replay.sh
#
# or with discrete vars (PG* are honoured by psql directly):
#   MIGRATIONS_DIR=... PGHOST=127.0.0.1 PGPORT=5432 PGUSER=vastos \
#   PGPASSWORD=... PGDATABASE=vastos  db/replay.sh
#
# Against the VPS (Postgres is 127.0.0.1:5432 on the box):
#   ssh -L 5432:127.0.0.1:5432 deploy@89.116.121.54    # in another shell
#   MIGRATIONS_DIR=... DATABASE_URL=postgres://vastos:$POSTGRES_PASSWORD@127.0.0.1:5432/vastos \
#     db/replay.sh
#
# ── Options (env) ────────────────────────────────────────────────────────────
#   MIGRATIONS_DIR   required. Path to supabase/migrations/.
#   DATABASE_URL     libpq connection URI. Or set PG* vars instead.
#   SKIP_SHIM=1      don't apply 00-compat-shim.sql (already applied).
#   FROM=<filename>  resume: skip every migration lexically before this one.
#   STOP_AFTER=<fn>  stop once this migration has been applied.
#   DRY_RUN=1        list what would be applied, apply nothing.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$HERE/00-compat-shim.sql"
OVERLAYS="$HERE/overlays"   # db/overlays/<migration-filename>.sql replaces that migration

: "${MIGRATIONS_DIR:?set MIGRATIONS_DIR to the frontend repo supabase/migrations dir}"
MIGRATIONS_DIR="${MIGRATIONS_DIR/#\~/$HOME}"
[[ -d "$MIGRATIONS_DIR" ]] || { echo "MIGRATIONS_DIR not a directory: $MIGRATIONS_DIR" >&2; exit 2; }

PSQL=(psql -v ON_ERROR_STOP=1 -X -q)
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL+=("$DATABASE_URL")
fi

run() {   # run <label> <extra psql args...>
  local label="$1"; shift
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "  would apply  $label"
    return 0
  fi
  "${PSQL[@]}" "$@"
}

echo "▶ target   : ${DATABASE_URL:-${PGDATABASE:-$USER}@${PGHOST:-local}:${PGPORT:-5432}}"
echo "▶ migrations: $MIGRATIONS_DIR"
echo

# ── connectivity + emptiness check ─────────────────────────────────────────
if [[ "${DRY_RUN:-}" != "1" ]]; then
  ntables=$("${PSQL[@]}" -tAc \
    "select count(*) from pg_tables where schemaname in ('public','auth','vault')")
  if [[ "$ntables" != "0" && -z "${FROM:-}" && "${SKIP_SHIM:-}" != "1" ]]; then
    echo "⚠ target already has $ntables tables in public/auth/vault." >&2
    echo "  replay expects an empty database. Drop & recreate it, or set FROM=<file> to resume." >&2
    exit 3
  fi
fi

# ── 1 · compat shim ───────────────────────────────────────────────────────
if [[ "${SKIP_SHIM:-}" == "1" ]]; then
  echo "· skipping compat shim (SKIP_SHIM=1)"
else
  echo "· compat shim  00-compat-shim.sql"
  run "00-compat-shim.sql" --single-transaction -f "$SHIM"
fi

# ── 2 · migrations, filename order ────────────────────────────────────────
shopt -s nullglob
mapfile -t FILES < <(printf '%s\n' "$MIGRATIONS_DIR"/*.sql | sort)
shopt -u nullglob
[[ ${#FILES[@]} -gt 0 ]] || { echo "no *.sql in $MIGRATIONS_DIR" >&2; exit 2; }

echo "· ${#FILES[@]} migration files"
echo

applied=0
for f in "${FILES[@]}"; do
  base="$(basename "$f")"

  if [[ -n "${FROM:-}" && "$base" < "$FROM" ]]; then
    continue
  fi

  # An overlay in db/overlays/ replaces the upstream migration of the same name
  # (kept minimal — currently just migration 28's catalogue-FK guard).
  src="$f"
  note=""
  if [[ -f "$OVERLAYS/$base" ]]; then
    src="$OVERLAYS/$base"
    note=" (overlay)"
  fi

  # Files that BEGIN;/COMMIT; on their own must not be wrapped again.
  if head -20 "$src" | grep -qiE '^[[:space:]]*begin[[:space:]]*;'; then
    txn=()
    note="$note (self-managed txn)"
  else
    txn=(--single-transaction)
  fi

  # Run every migration as `postgres` — the owner role hosted Supabase uses, and
  # the grantor the C1b/C4 default-privilege migrations name explicitly. Objects
  # come out postgres-owned; `set role` reverts at end of this psql session.
  printf '  %-64s' "$base$note"
  if { printf 'set role postgres;\n'; cat "$src"; } | run "$base" "${txn[@]}" -f -; then
    echo "ok"
  else
    echo "FAIL"
    echo
    echo "✗ replay stopped at: $base" >&2
    echo "  re-run just this file:" >&2
    echo "    { echo 'set role postgres;'; cat '$src'; } | ${PSQL[*]} --single-transaction -f -" >&2
    echo "  then resume:  FROM=$base SKIP_SHIM=1 $0" >&2
    exit 1
  fi
  applied=$((applied + 1))

  if [[ -n "${STOP_AFTER:-}" && "$base" == "$STOP_AFTER" ]]; then
    echo
    echo "· stopped after $base (STOP_AFTER)"
    break
  fi
done

echo
echo "✔ replay complete — $applied migration(s) applied"

# ── 3 · post-replay sanity ────────────────────────────────────────────────
if [[ "${DRY_RUN:-}" != "1" ]]; then
  echo
  echo "── sanity ─────────────────────────────────────────────────────────"
  "${PSQL[@]}" <<'SQL'
\pset footer off
select 'tables (public)'   as k, count(*)::text v from pg_tables      where schemaname='public'
union all
select 'views (public)',        count(*)::text   from pg_views       where schemaname='public'
union all
select 'functions (public)',    count(*)::text   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
union all
select 'RLS policies (public)', count(*)::text   from pg_policies    where schemaname='public'
union all
select 'enum types',            count(*)::text   from pg_type        where typtype='e'
union all
select 'SECURITY DEFINER fns',  count(*)::text   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef;

\echo
\echo 'key helpers (expect all present, prosecdef = t):'
select p.proname, p.prosecdef as secdef
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('current_firm_id','crm_has_permission','crm_current_role_id',
                    'inv_current_actor','auth_uid')
order by 1;
SQL
fi
