import './loadEnv'
import { z } from 'zod'

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}, z.boolean())

const optionalUrl = z.preprocess(
  (value) => value === '' || value == null ? undefined : value,
  z.string().url().optional(),
)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must contain at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must contain at least 32 characters'),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, 'ENCRYPTION_KEY must be exactly 64 hexadecimal characters'),
  // Envelope encryption. The local provider derives versioned data keys from
  // ENCRYPTION_KEY via HKDF and needs no external service. aws-kms wraps data
  // keys with a KMS master key and requires initialiseKeyring() at boot.
  KMS_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
  KMS_MASTER_KEY_ID: z.string().optional(),
  KMS_REGION: z.string().min(1).default('us-east-1'),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(1_000).default(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  COOKIE_SECURE: boolFromEnv.default(false),
  COOKIE_DOMAIN: z.string().optional(),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
  ALLOW_REGISTRATION: boolFromEnv.default(false),
  OUTBOUND_HTTP_ALLOWLIST: z.string().default(''),
  BOOTSTRAP_EMAIL: z.string().email().optional(),
  BOOTSTRAP_PASSWORD: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // Namespace for RFC 7807 problem type URIs. Defaults to a URN so that no
  // unverified domain or trademark is embedded in the public API contract.
  // Comma-separated provider:state pairs, e.g. "activecampaign:general".
  // Overrides the built-in connector release defaults after legal/provider sign-off.
  CONNECTOR_RELEASE_STATES: z.string().default(''),
  // Provider webhook signing keys. Overridable so a provider key rotation is a
  // configuration change and a restart, not a code change and a redeploy.
  GHL_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  GHL_LEGACY_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  // Reject a webhook whose signed payload carries no usable timestamp. Durable
  // event-id de-duplication stops being a replay defence once the retention
  // worker purges the event record.
  WEBHOOK_REQUIRE_TIMESTAMP: boolFromEnv.default(true),
  // Onboarding contact-scan ceiling. Truncation is always reported to the user.
  CONNECTION_SCAN_LIMIT: z.coerce.number().int().min(100).max(500_000).default(5_000),
  CONNECTION_SCAN_MAX_LIMIT: z.coerce.number().int().min(100).max(1_000_000).default(100_000),
  // [V3] contingency. When HighLevel does not grant workflows.readonly the
  // product falls back to Batch plus connection-health Watch rather than
  // presenting workflow monitoring that cannot function.
  FEATURE_WATCH_WORKFLOWS_ENABLED: boolFromEnv.default(true),
  PROBLEM_TYPE_BASE_URI: z.string().min(1).regex(/^(urn:[a-z0-9][a-z0-9-]{0,31}:[^\s]+|https:\/\/[^\s]+)$/i, 'PROBLEM_TYPE_BASE_URI must be a URN or an https URL').default('urn:logicflower:problem'),

  ARTIFACT_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  ARTIFACT_LOCAL_ROOT: z.string().min(1).default('/var/lib/logicflower/artifacts'),
  ARTIFACT_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(1_073_741_824).default(104_857_600),
  ARTIFACT_S3_BUCKET: z.string().default(''),
  ARTIFACT_S3_REGION: z.string().min(1).default('us-east-1'),
  ARTIFACT_S3_ENDPOINT: optionalUrl,
  ARTIFACT_S3_FORCE_PATH_STYLE: boolFromEnv.default(false),
  ARTIFACT_S3_KMS_KEY_ID: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_SECURE: boolFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('LogicFlower <no-reply@logicflower.local>'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_AGENCY: z.string().optional(),
  STRIPE_PRICE_SCALE: z.string().optional(),

  GHL_CLIENT_ID: z.string().optional(),
  GHL_CLIENT_SECRET: z.string().optional(),
  GHL_REDIRECT_URI: optionalUrl,
  GHL_OAUTH_SCOPES: z.string().trim().min(1).default('contacts.readonly contacts.write locations.readonly workflows.readonly'),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_REDIRECT_URI: optionalUrl,
  HUBSPOT_OAUTH_SCOPES: z.string().trim().min(1).default('crm.objects.contacts.read crm.objects.contacts.write automation'),
  KLAVIYO_CLIENT_ID: z.string().optional(),
  KLAVIYO_CLIENT_SECRET: z.string().optional(),
  KLAVIYO_REDIRECT_URI: optionalUrl,
  KLAVIYO_OAUTH_SCOPES: z.string().trim().min(1).default('profiles:read profiles:write events:write flows:read'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: optionalUrl,

  MONITOR_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  WORKFLOW_MAX_STEPS: z.coerce.number().int().min(1).max(1_000).default(250),
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  WORKFLOW_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  MONITORING_CONCURRENCY: z.coerce.number().int().min(1).max(25).default(2),
  NOTIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  // Sequence engine. The scheduler polls MongoDB rather than consuming a Redis
  // queue, so the interval is the worst-case latency between a step becoming
  // due and being sent. Shorter costs database reads; longer costs punctuality.
  SEQUENCE_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  SEQUENCE_SCHEDULER_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  // How long a worker may hold a step before another may reclaim it. Must
  // comfortably exceed the slowest provider call, or a healthy send gets
  // reclassified as an unknown outcome and stalls the enrolment.
  SEQUENCE_STEP_LEASE_MS: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  // Master switch. Off by default: an operator must consciously turn on a
  // subsystem that sends messages to real people under their own domain.
  SEQUENCE_ENGINE_ENABLED: boolFromEnv.default(false),
  // Social publishing backend (self-hosted trypost, AGPL-3.0-only, run as a
  // separate service). Unset means social publishing is disabled and every
  // publish attempt reports the platform as unimplemented, which is the
  // behaviour without this integration.
  //
  // The admin key provisions workspaces; each organisation's own workspace key
  // is stored encrypted per organisation and is never read from here.
  TRYPOST_BASE_URL: optionalUrl,
  TRYPOST_ADMIN_API_KEY: z.string().optional(),
  TRYPOST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  // How often publish status is polled. trypost exposes no outbound webhook,
  // so status is pulled rather than pushed.
  TRYPOST_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  // Outbound dialer. Off by default; enabling it starts placing real calls.
  DIALER_ENABLED: boolFromEnv.default(false),
  DIALER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  DIALER_BATCH: z.coerce.number().int().min(1).max(100).default(10),
  // Runs every regulatory gate and records the decision without calling any
  // provider. The safe way to validate a calling configuration against real
  // contacts before a phone rings. Defaults ON, so enabling the dialer without
  // consciously turning this off cannot place a call.
  DIALER_DRY_RUN: boolFromEnv.default(true),
  /**
   * Where the built client's index.html lives.
   *
   * Read so an article can be served with its metadata already in the head.
   * Unset simply means article shells fall back to a redirect: the page still
   * works for a person, and only the crawler metadata is lost.
   */
  CLIENT_DIST_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && !value.COOKIE_SECURE) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true in production' })
  }
  if (value.NODE_ENV === 'production' && value.CORS_ORIGINS.split(',').some((origin) => origin.trim() === '*')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGINS'], message: 'Wildcard CORS is forbidden in production' })
  }
  if (value.NODE_ENV === 'production' && !value.SMTP_HOST) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_HOST'], message: 'SMTP_HOST is required in production' })
  }
  if (value.ARTIFACT_STORAGE_DRIVER === 's3' && !value.ARTIFACT_S3_BUCKET) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ARTIFACT_S3_BUCKET'], message: 'ARTIFACT_S3_BUCKET is required when ARTIFACT_STORAGE_DRIVER=s3' })
  }
  if (value.NODE_ENV === 'production' && value.ARTIFACT_STORAGE_DRIVER === 'local' && value.ARTIFACT_LOCAL_ROOT.startsWith('/tmp')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ARTIFACT_LOCAL_ROOT'], message: 'Production artifacts cannot use temporary storage' })
  }
})

export type AppEnv = z.infer<typeof schema>

export function parseEnv(source: NodeJS.ProcessEnv): AppEnv {
  const result = schema.safeParse(source)
  if (result.success) return result.data
  const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  throw new Error(`Invalid environment configuration: ${details}`)
}

export const env = parseEnv(process.env)
export const corsOrigins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
