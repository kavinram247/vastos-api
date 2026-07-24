import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: ReturnType<typeof createClient>;
  private serviceRoleClient?: ReturnType<typeof createClient>;

  constructor(private readonly config: ConfigService) {
    const url = config.getOrThrow<string>('SUPABASE_URL');
    // Anon key by default — same privilege level the frontend already uses,
    // so Postgres RLS stays the enforcement backstop. SUPABASE_SERVICE_ROLE_KEY
    // is deliberately not wired up as the default client: bypassing RLS should
    // be an explicit, reviewed decision per-endpoint (see getServiceRoleClient()).
    const anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  getClient() {
    return this.client;
  }

  // Bypasses RLS entirely — only for endpoints that have an explicit,
  // reviewed need to read data RLS can't express (e.g. resolving caller
  // identity/role, since crm_roles/crm_role_permissions have no
  // `authenticated` policy at all, only a permissive anon-dev one).
  getServiceRoleClient() {
    if (!this.serviceRoleClient) {
      const url = this.config.getOrThrow<string>('SUPABASE_URL');
      const serviceRoleKey = this.config.getOrThrow<string>(
        'SUPABASE_SERVICE_ROLE_KEY',
      );
      this.serviceRoleClient = createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    return this.serviceRoleClient;
  }

  async verifyUserToken(accessToken: string) {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error) return null;
    return data.user;
  }
}
