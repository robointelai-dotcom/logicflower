# Deployment

## Environments

Use separate databases, Redis instances, encryption keys, cookie secrets, OAuth applications, billing accounts, domains, email credentials, and object-storage buckets for development, staging, and production. Never copy production customer payloads into a lower environment.

## Required production configuration

Set every non-optional value from `server/.env.example`. At minimum:

- `NODE_ENV=production`
- public HTTPS `APP_URL`, `API_URL`, and an exact `CORS_ORIGINS` allowlist
- authenticated TLS MongoDB and Redis connection strings
- independent high-entropy access/refresh signing secrets
- a 32-byte encryption key represented as 64 hexadecimal characters
- `COOKIE_SECURE=true`
- a transactional SMTP account and verified sender
- public OAuth callback URLs for each enabled connector
- provider webhook/signing secrets and Stripe webhook secret for enabled services
- durable encrypted artifact storage: a shared persistent volume for `local`, or a private S3-compatible bucket for `s3`

The application intentionally fails fast when a required production security value is missing or is still a placeholder.

## Container deployment

The included images build TypeScript in a builder stage and copy only runtime output and production dependencies into the final image. Run at least one API process and a separately scalable worker process. Place the web/API behind a trusted TLS reverse proxy and preserve the original request scheme/IP only through configured trusted proxies.

Do not expose MongoDB or Redis publicly. Local Compose binds them to loopback for developer diagnostics; production networks must make them reachable only from application identities.

MongoDB must run as a replica set or through `mongos`. Workflow/contact quota reservation couples an atomic counter and immutable usage ledger in a transaction; the application intentionally pauses billable work with a retryable 503 if transactions are unavailable rather than allowing an unmetered write. The included Compose stack initializes a single-node development replica set.

## Release sequence

1. Create an immutable source revision and pass CI.
2. Build and scan images once; promote the same digests across environments.
3. Back up the database and verify the latest restore drill.
4. Apply backward-compatible indexes/schema migrations with `npm run migrate:tenancy`, then run the explicit first-owner bootstrap only for a new installation.
5. Deploy API processes, then workers, then the web asset.
6. Check `/healthz`, `/readyz`, login/refresh/logout, queue processing, and one non-mutating provider request.
7. Watch errors, queue latency, token-refresh failures, and webhook rejection rates during the observation window.
8. Enable new capabilities with feature flags after their live acceptance cases pass.

## Scaling

Scale APIs on latency/concurrency and workers on runnable queue depth/oldest-job age. Protect each provider with its own distributed rate bucket; adding workers must not multiply allowed outbound throughput beyond provider/customer limits. Use MongoDB replica sets with tested backups and Redis persistence/replication appropriate to the recovery targets.

## Rollback

Application rollback must not require destructive database rollback. Additive schema changes precede code that depends on them; destructive cleanup occurs only after the old version is outside the rollback window. If a connector release misbehaves, disable that capability, stop new work, allow safe jobs to checkpoint, and roll back the image while preserving job records.
