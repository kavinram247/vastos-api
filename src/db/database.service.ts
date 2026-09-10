import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';

/**
 * Direct Postgres access for the `/api/*` layer that replaces PostgREST.
 *
 * The app connects as `vastos_app` — a non-superuser, non-BYPASSRLS role (see
 * db/00-compat-shim.sql). Every RLS policy in the migration tree therefore
 * applies exactly as it did on Supabase. Identity reaches the policies through
 * the `request.jwt.claims` GUC, set per transaction by `withCaller()` after the
 * request's bearer token has been verified — the same mechanism PostgREST used,
 * so `auth.uid()` / `current_firm_id()` / `crm_has_permission()` resolve
 * unchanged.
 *
 * The pool is created lazily-ish: constructing it does not open a socket, so the
 * app still boots without DATABASE_URL (mirroring DocumentsService). Any actual
 * query without it raises 503.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('DATABASE_URL');
    if (!url) {
      this.logger.warn(
        'DATABASE_URL is not set — /api/* database endpoints will return 503',
      );
      this.pool = null;
      return;
    }
    this.pool = new Pool({
      connectionString: url,
      max: Number(config.get('DATABASE_POOL_MAX') ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Postgres is reached over the private `kamal` Docker network, not TLS.
      ssl: /sslmode=require/.test(url)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    this.pool.on('error', (err) => {
      this.logger.error(`idle pool client error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new ServiceUnavailableException('Database is not configured');
    }
    return this.pool;
  }

  /**
   * Run `fn` inside a transaction that impersonates `authUid` for RLS.
   *
   * Opens BEGIN, stamps `request.jwt.claims` = `{"sub": authUid}` transaction-
   * locally, runs `fn`, then COMMIT — or ROLLBACK on any throw. The GUC is
   * scoped to the transaction, so a pooled client never leaks one caller's
   * identity into the next request.
   */
  async withCaller<T>(
    authUid: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!authUid) {
      // Never open an "authenticated" transaction with an empty subject — that
      // would make auth.uid() NULL and silently widen every `OR firm_id IS NULL`
      // policy.
      throw new ServiceUnavailableException('missing caller identity');
    }
    const client = await this.requirePool().connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: authUid, role: 'authenticated' }),
      ]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A transaction that additionally `SET ROLE service_role` — bypasses RLS.
   * Only for the few lookups that must see across the firm boundary (resolving
   * an invite, platform-operator checks). Use `withCaller` everywhere else.
   */
  async withServiceRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('begin');
      await client.query('set local role service_role');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
