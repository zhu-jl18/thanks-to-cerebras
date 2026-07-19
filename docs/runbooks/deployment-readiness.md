# Deployment Readiness Runbook

## Purpose

Use this runbook when a new deployment starts, a container restarts, or traffic
should only be sent to a fully initialized instance.

## Signals

- `/healthz` is liveness only. It returns `200 ok` when the HTTP process is
  alive.
- `/readyz` is readiness. It checks required runtime prerequisites without
  calling Cerebras upstream.
- `x-request-id` is emitted on every response and in the `http_request`
  structured log event.

## Required runtime configuration

- `KEY_ENCRYPTION_SECRET` must be set before reading or writing stored API keys.
  It must remain stable: both API-key encryption and deployment-scoped blind
  fingerprints are derived from it with separate cryptographic contexts.
- `SETUP_TOKEN` must be set until the first admin password is created.
- `KV_PATH` is optional for local/Docker deployments and controls the local Deno
  KV directory.
- `PORT` is optional locally and defaults to `8339`.

## API-key schema cutover

The current API-key store requires a strict one-to-one relation between each
record and its HMAC fingerprint claim. There is intentionally no online
migration from the previous API-key schema.

Before deploying this version over an existing store:

1. Record the API keys that must be re-imported through a secure operator-held
   source; plaintext export from the application remains disabled.
2. Stop traffic and back up KV.
3. Remove old API-key records and old API-key value-index entries, or clear the
   entire KV store when a full reset is acceptable.
4. Deploy with the intended stable `KEY_ENCRYPTION_SECRET`.
5. Re-import API keys through `POST /api/keys` or `POST /api/keys/batch`.
6. Confirm `/readyz`, `/api/keys`, and a test proxy request succeed before
   enabling traffic.

A startup failure mentioning a missing fingerprint, record/claim count mismatch,
dangling claim, or ciphertext/fingerprint mismatch is a store-invariant failure;
do not bypass it by manually creating claim entries without verifying plaintext.

## Triage

1. Check liveness:
   ```sh
   curl -fsS "$BASE_URL/healthz"
   ```
2. Check readiness:
   ```sh
   curl -fsS "$BASE_URL/readyz"
   ```
3. If `/healthz` passes but `/readyz` returns `503`, use the admin diagnostics
   endpoint to inspect individual checks:
   ```sh
   curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" "$BASE_URL/api/diagnostics"
   ```
   The response includes a `checks` object:
   - `keyEncryptionSecret`: set or fix `KEY_ENCRYPTION_SECRET`.
   - `kv`: verify Deno KV availability and local KV path permissions.
   - `config`: verify the KV config shape is compatible.
4. Inspect logs by `requestId` from the failing response.
5. For Docker or VPS, ensure the process was started with `deno task start` and
   the same environment used during initialization.

## Recovery

- Missing secret: set the environment variable and restart.
- Changed secret: restore the original `KEY_ENCRYPTION_SECRET`, or clear the
  API-key store and securely re-import keys under the new secret.
- Local KV permission error: fix the `KV_PATH` directory ownership/permissions
  and restart.
- Incompatible KV config or API-key store: stop traffic, back up KV, then clear
  the incompatible data before restart. The API-key store has no online repair
  or migration endpoint.
- Failed DAST after deployment: keep traffic disabled and run
  `deno task dast:check` against the candidate instance.