# LogicFlower

LogicFlower is a multi-tenant workflow operations platform for governed CRM automation, batch data work, connector health, monitoring, versioned workflow snapshots, notifications, and usage-based SaaS administration.

This repository contains the customer web application, API, queue worker, connector adapters, production containers, automated verification, and operational documentation. It intentionally does **not** execute customer-supplied JavaScript. Customer logic is represented as validated, bounded, structured operations.

## Product surfaces

- **Engine and Studio** — structured transformations, formulas, conditions, branching, templates, validation, and execution history.
- **Batch** — preview-first contact operations with estimates, chunking, checkpoints, pause/resume/cancel controls, retries, idempotency, partial-success accounting, and failed-record export.
- **Bridge** — encrypted per-organisation connections, OAuth/API-key lifecycle, capability manifests, rate governance, signed webhooks, and connector health.
- **Watch** — job, workflow, webhook, schedule, and credential monitoring with incident and alert routing.
- **Vault** — immutable workflow snapshots, version history, structural comparison, neutral export, and restore guidance where a platform permits it.
- **Agency and SaaS** — organisations, membership roles, invitations, audit history, usage metering, subscription billing, and owner administration.
- **Reports and governed data movement** — operational summaries, reviewed batch synchronisation, and allow-listed Google Sheets operations where the selected connector supports them.

## Requirements

- Node.js 22 LTS (Node 20 is also supported)
- npm 10+
- MongoDB 8
- Redis 7.4+
- Docker with Compose for the fastest local start

External connectors, email delivery, and billing require credentials issued by their respective providers. The application starts without those optional credentials; unavailable capabilities remain explicitly unconfigured rather than silently pretending to succeed.

## Quick start with Docker

1. Copy `server/.env.example` to `server/.env`.
2. Replace all values beginning with `replace-`. Safe signing/encryption values can be generated with `npm run secrets:generate`.
3. Start the stack:

   ```bash
   docker compose up --build
   ```

4. Open `http://localhost:8080`. Mail sent in local development is visible at `http://localhost:8025`.
5. Create the first owner with the explicit bootstrap command:

   ```bash
   docker compose exec api npm run bootstrap
   ```

The API exposes liveness and dependency readiness separately at `/healthz` and `/readyz`.

## Local development

```bash
npm install
npm run install:all
cp server/.env.example server/.env
npm run dev
```

The Vite web application runs on `http://localhost:5173`; the API runs on `http://localhost:4000`.

## Verification

```bash
npm run verify
```

The release gate includes repository security guardrails, strict TypeScript checking, unit/integration tests, and production builds for both applications. `npm run lint:security` runs the ESLint security ruleset; secret scanning and CodeQL run in `.github/workflows/security.yml`. Before production deployment, also complete [the live acceptance checklist](docs/LIVE_ACCEPTANCE.md) using provider sandbox accounts and a Stripe test-mode account.

## Deployment and operations

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operations and recovery](docs/OPERATIONS.md)
- [Feature and release gates](docs/FEATURE_MATRIX.md)
- [Current release status](docs/RELEASE_STATUS.md)
- [Independent completion audit](docs/COMPLETION_AUDIT.md)
- [Remediation record 1.1.1](docs/REMEDIATION_1_1_1.md)
- [Remediation record 1.1.2](docs/REMEDIATION_1_1_2.md)
- [Remediation record 1.1.3](docs/REMEDIATION_1_1_3.md)
- [Remediation record 1.1.3](docs/REMEDIATION_1_1_3.md)
- [Live-provider acceptance](docs/LIVE_ACCEPTANCE.md)
- [Security policy](SECURITY.md)
- [Incident response plan](docs/INCIDENT_RESPONSE.md)
- [Subprocessors](docs/SUBPROCESSORS.md)
- [Incident response plan](docs/INCIDENT_RESPONSE.md)
- [Subprocessors](docs/SUBPROCESSORS.md)

## Production boundary

Source-code verification can prove deterministic application behavior, isolation checks, build integrity, and provider contract handling. It cannot grant OAuth applications, approve marketplace listings, create DNS/TLS records, validate a customer-owned account, or prove delivery through credentials that are not supplied. Those external gates are listed explicitly in `docs/LIVE_ACCEPTANCE.md`; they must pass before enabling the corresponding connector in production.
