import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import { AppModule } from './app.module';

// A plain array passed to `cors`'s `origin` option only matches by exact
// string equality — "https://*.vercel.app" would never match a real preview
// URL like "https://my-preview-abc123.vercel.app". Match wildcard entries as
// patterns instead so Vercel preview deployments actually work.
function originMatches(allowedOrigins: string[], origin: string): boolean {
  return allowedOrigins.some((allowed) => {
    if (!allowed.includes('*')) return allowed === origin;
    const pattern = allowed
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`).test(origin);
  });
}

// Routes meant to be posted to from any origin at all — a per-firm webhook/
// share token carried in the request is the entire trust boundary, not the
// caller's origin, same posture these had as public Supabase Edge Functions.
// Exact-or-slash-prefixed match only: '/api/leads/intake' must NOT also match
// '/api/leads/intake-tokens/...' (the authenticated token-management routes,
// which need GET/DELETE, not just POST, and a real origin check).
const OPEN_CORS_PREFIXES = ['/api/leads/intake'];
function isOpenCorsRoute(path: string): boolean {
  return OPEN_CORS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors((req: Request, callback: (err: Error | null, options?: object) => void) => {
    if (isOpenCorsRoute(req.path)) {
      callback(null, {
        origin: true,
        methods: ['POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Token'],
      });
      return;
    }

    // No Origin header = non-browser request (curl, server-to-server) — allow.
    const origin = req.headers.origin as string | undefined;
    if (!origin || originMatches(allowedOrigins, origin)) {
      callback(null, {
        origin: true,
        // PATCH/DELETE added for the generic data layer (Phase 5, item 2.6) —
        // bootstrap and document presigning only ever needed GET/POST.
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      });
      return;
    }
    callback(new Error('Not allowed by CORS'));
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
