import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_ENVIRONMENT: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  EXPECTED_DATABASE_NAME: z.string().trim().min(1),
  EXPECTED_DATABASE_USER: z.string().trim().min(1),
  EXPECTED_DATABASE_INSTANCE_ID: z.string().uuid(),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform(v => v === 'true')
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  if (parsed.data.NODE_ENV === 'production' && !['staging', 'production'].includes(parsed.data.DEPLOYMENT_ENVIRONMENT)) {
    throw new Error('DEPLOYMENT_ENVIRONMENT must be staging or production when NODE_ENV=production');
  }
  return parsed.data;
}
