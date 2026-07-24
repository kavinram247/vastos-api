import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly client: ReturnType<typeof createClient>;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('SUPABASE_URL');
    // Anon key by default — same privilege level the frontend already uses,
    // so Postgres RLS stays the enforcement backstop. SUPABASE_SERVICE_ROLE_KEY
    // is deliberately not wired up yet: bypassing RLS should be an explicit,
    // reviewed decision per-endpoint, not the default client every module gets.
    const anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  getClient() {
    return this.client;
  }

  async verifyUserToken(accessToken: string) {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error) return null;
    return data.user;
  }
}
