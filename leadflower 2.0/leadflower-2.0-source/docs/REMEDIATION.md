# Remediation of the 9713949 audit

Two commits on top of `9713949`. Everything below is verified by
`npm run verify` from the repository root: guardrails, tenant-isolation guard,
typecheck, 517 tests, and both builds.

**Nothing here has been run against a live database.** See
"Before you trust this" at the end. That section is the most important part of
this document.

---

## 1. Do this before deploying anything

`trypost.env` was committed to a **public** repository containing a live
Passport RSA private key, `APP_KEY`, and a database password.

Compounding it, `POST /api/v1/trypost/verify` accepted an email, a password and
a shared secret and returned whether the password was correct. It was mounted
**without authentication**, and the shared secret fell back to a literal that is
also in the public repository (and was hardcoded a second time in
`trypost_web.php`). That is an unauthenticated credential-testing oracle against
every account on the platform, bypassing lockout, MFA and session issuance.
Nothing called it; it has been deleted.

Removing the file from the working tree **does not remove it from history.**

1. Rotate, on the Trypost/Passport side: `php artisan passport:keys --force`,
   `php artisan key:generate`, and a new database password.
2. Generate a new shared secret, at least 32 characters
   (`openssl rand -base64 48`). It is now read from `LEADFLOWER_SSO_SECRET` on
   the PHP side and `TRYPOST_ADMIN_API_KEY` on the Node side; both fail closed
   when unset.
3. Purge from history and force-push:
   ```
   git filter-repo --invert-paths --path "leadflower 2.0/leadflower-2.0-source/trypost.env"
   ```
4. Assume anything reachable with those credentials was reachable by others.
   Review Trypost's user table and the platform audit log for the period the
   file was public.

---

## 2. Security

| Defect | Fix |
|---|---|
| `trypost.env` committed with live private key | Removed, `.gitignore`d, `trypost.env.example` added. **Rotation is still yours to do.** |
| `/trypost/verify` unauthenticated password oracle | Endpoint deleted. The Laravel side authenticates via `/sso/provision` and a signed 5-minute magic link and never needed it. |
| Hardcoded fallback secret and host | Both read from env; fail closed with 503 when unset, when the secret is under 32 chars, or when the URL is not HTTPS in production. |
| `!==` secret comparison in PHP | `hash_equals`. The old comparison returned on the first differing byte and leaked the secret to anyone willing to measure. |
| Trypost provisioned globally by email | Accounts keyed on `(workspace_key, email)`. One person in two workspaces previously shared one external account, and therefore one set of connected social pages — a cross-tenant publishing identity. |
| Trypost mount had no auth or role gate | `authenticate` + CSRF + org context + owner/admin. |
| `/organizations/current/members` had no role gate | Gated on `canView`. Email, MFA state and last-login are no longer *selected* unless the caller is owner/admin — "which of these accounts has no second factor" was answerable by any viewer, billing or customer user. |
| Corporate estate and website management skipped MFA | Both now use `assertCorporate`, which requires platform owner/admin **and** MFA for every mutation. A stolen platform-owner password was refused at `/admin` and admitted here. |
| Magic links replayable within their window | Burned after first use. |

---

## 3. Provisioning

All three reported breakages were real.

- **Agency and client creation could never have succeeded.** Both built an
  `Organization` literal omitting `slug` and `createdBy`, which the schema marks
  required. Both now go through `services/hierarchy/provisioning.ts`, so a third
  call site cannot repeat the omission.
- **Client provisioning is now a complete customer.** Organisation, owner user,
  owner membership, subscription and invitation, created atomically with
  rollback that never deletes a pre-existing user it merely attached. An
  `Organization` alone appears on the agency console as a client and cannot be
  signed into by anybody.
- **Workspace switching works.** The root cause was in `authenticate`, not in
  the switch route: organisation context required a direct `Membership`, so
  `/hierarchy/switch` confirmed access and every following request was refused.
  It now resolves through `resolveAccess` — membership is still checked first,
  so nothing is widened for direct members — and `/switch` rebinds the session
  through `switchSessionOrganization`, a helper that already existed and was
  never called. Support grants are metered per request.
- **`agency_owner` was excluded from every guard**, so a user holding only that
  role was blocked before reaching the console the role exists to grant.
- **"Request access" now creates a request.** It previously called `/switch`,
  which returned 403 under `on_request` and told the client nothing.

---

## 4. Data loss

Contact creation collected an address, job title, secondary phone, preferred
contact method, referrer and lead score, declared every one of them on the
schema, and wrote none of them — with no error. A workspace could run for months
believing it held data it discarded on every contact it created.

Create and update now build their document from one definition
(`services/crm/contactFields.ts`). Tags are accepted at creation and applied
through `applyTagChanges`, so a contact created with the tag that enrols them in
a sequence is actually enrolled.

**A latent bug the audit did not catch:** `randomToken` returns base64url, whose
alphabet includes `-` and `_`. `slugify` lowercased it and appended it directly,
so roughly one organisation in eight has received a malformed slug since launch,
in the registration path too. The suffix now comes from an explicit `[0-9a-z]`
alphabet; stress-tested at 100,000 iterations.

---

## 5. Package and customer management

These were **absent, not broken**. Plans were four object literals in source, so
changing a price or a quota required a code change and a deploy.

New: `models/Package.ts` (versioned, admin-editable), `models/Invoice.ts`,
`services/packages.ts`, `routes/adminPackages.ts`, `routes/adminCustomers.ts`.

Two design decisions worth stating plainly:

**The four-tier `plan` enum stays.** Those codes are woven through Stripe
metadata, usage counters already written, and plan policy. Replacing them would
be a data migration across live billing records to gain nothing a customer can
see. Each package declares which `tier` it bills as; the tier remains the
compatibility surface and the package carries the commercial terms.

**Built-in limits remain the floor.** Resolution order is override → package →
tier default. Every existing subscription has `packageId: null` and receives
exactly what it receives today — a resolution path that returned zero or threw
for an unmigrated customer would take the product off the air for the whole
estate on deploy. This is pinned by tests.

Packages are versioned and never edited once published, because editing in place
would silently reprice everyone already on it with no approval and no record.
Archiving withdraws a package from sale and does **not** cancel subscribers.

Customer management covers list and detail (plan, quota headroom, users,
invoices, failed-payment reasons), creation through the same provisioning path,
profile edits, suspend/reactivate/soft-delete with a mandatory recorded reason,
package assignment, per-customer quota overrides, agency reassignment, invitation
resend, session revocation and account unlock. Destructive actions additionally
require recent authentication.

Deletion is soft. An admin button that irreversibly destroys a tenant's data one
click and one confirm away is not a feature; purging belongs to the retention
pipeline, with its ledger and its delay.

---

## 6. Repository and CI

CI ran `npm ci` at the repository root while the application lived two
directories down under a path containing a space, so **every run failed on its
first step**. The application is now at the root; the committed 1.1 MB source zip
and stale patch are gone. All CI steps verified locally.

---

## 7. Before you trust this

`npm run verify` proves the code compiles, the guards hold and the units behave.
It proves **nothing** about provisioning, payments, booking uniqueness, messaging
or any external integration.

These changes touch the authentication path — specifically, how *every* request
resolves its organisation. That is the highest-blast-radius change in this set.
Complete `docs/LIVE_ACCEPTANCE.md` against real MongoDB, Redis, Stripe and
email/SMS providers before this reaches a paying customer, and cover at minimum:

1. A direct member's role is unchanged after the `authenticate` rewrite.
2. An agency user switching into a client is scoped to that client and can read
   nothing else.
3. A support engineer with no live grant is refused exactly as a stranger is.
4. A suspended organisation's users are signed out on their next request.
5. An unmigrated customer's quotas are byte-for-byte what they were before.
6. Provisioning a client end-to-end: the owner receives the invitation, sets a
   password, signs in, and lands in their own workspace.

## 8. Still outstanding

Not fixable from the repository — they need accounts, approvals or contracts:
social platform app review, WhatsApp sending, AI/voice dialling and DNC provider
integration, the customer payment-confirmation webhook, blog media library, the
scheduled-post publishing worker, root `robots.txt`/`sitemap.xml` routing, and
the missing `/features/*` and `/compare/*` marketing pages.

Admin **UI** for packages and customers is not built. The API surface above is
complete and tested; the screens that drive it are not.
