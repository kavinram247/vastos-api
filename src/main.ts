import { NestFactory } from '@nestjs/core';
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

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header = non-browser request (curl, server-to-server) — allow.
      if (!origin || originMatches(allowedOrigins, origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    // PATCH/DELETE added for the generic data layer (Phase 5, item 2.6) —
    // bootstrap and document presigning only ever needed GET/POST.
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
