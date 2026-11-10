# Admin authentication server

For the Spark-compatible demo environment (no real credentials), follow
[the team Emulator guide](../../docs/LOCAL-EMULATOR.md). Start-AdminServer.ps1
connects only to demo Auth/Database emulators and deliberately skips `.env` loading.

This HTTP server supplements BE1 Cloud Functions. It exposes only
`POST /api/getAdminSession` (plus `/health`). It does not provision users,
implement learning/admin business APIs, or write RTDB records.

## Ownership and request flow

- Android: Firebase Auth SDK → BE1 Callable `ensureUserProfile` → existing
  Callable dashboard, Practice/Test/Daily and result APIs in `asia-southeast1`.
- Admin web: Firebase Auth → the same BE1 Callable → HTTP `getAdminSession`.
- The HTTP server verifies token revocation, disabled status, both current and
  token boolean admin claims, and `accountAccess/{uid}/status === active`.
- BE1 owns profile defaults, wallets, settlement and rewards. HTTP authorization
  never creates, reactivates or changes those records.
- Admin workspace uses sample data only when VITE_ADMIN_DATA_SOURCE=mock. Firebase mode calls the 21 admin Callables; see [Admin API](../functions/ADMIN-API.md). This HTTP server still only verifies sessions.

## Local server setup

For this HTTP server alone use Node.js **22.9+** (`npm start` uses
`--env-file-if-exists`, introduced in 22.9). The full local Emulator workflow
requires **Node.js 24 LTS**, matching the pre-existing Functions engine.
Install with `npm ci`. Use `.env.example` as the configuration template; keep
the actual `.env` and Admin credential file outside Git. Set
`GOOGLE_APPLICATION_CREDENTIALS` to a private server-side key path. Never place
this key in Android or web builds. Then run `npm start`.

`FIREBASE_PROJECT_ID` and `FIREBASE_DATABASE_URL` must identify the same project
as the app and BE1 Functions. Configure `ADMIN_ORIGINS` explicitly. Internet
access requires an HTTPS reverse proxy/server; the local process is not a
public deployment. Web production requires `VITE_BACKEND_BASE_URL=https://…`.
Android does not use this HTTP URL.

## Grant/revoke admin

The target UID must first be provisioned through BE1 (for example by signing
in to Android). An authorized server operator can then use:

```powershell
npm run admin -- grant FIREBASE_UID
npm run admin -- revoke FIREBASE_UID
```

These commands update Auth claims only. Grant requires an active, enabled user;
revoke is also available for blocked users. Refresh the client's token after
granting. No role changes happen automatically during startup or login.

The imported password-policy tool is optional operator tooling. It is never
run automatically; `apply` changes the Firebase project and requires separate
approval. Android validates new passwords locally without changing cloud policy.

## Verification (local Emulator Suite only)

From the workspace, build BE1 first and run one suite:

```powershell
npm --prefix Backend/functions run build
firebase emulators:start --project englishbattleapp-8d764 --only auth,database,functions --config firebase.auth-qa.json
```

In another terminal:

```powershell
npm --prefix Backend/server run check
npm --prefix Backend/server test
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
$env:FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000'
npm --prefix Backend/server run test:integration
```

Tests exercise the real local BE1 provisioning Callable before admin checks,
assert read-only HTTP behavior and validate the merged root Rules. Both Auth
and Database hosts must be loopback in emulator mode. Do not start another
suite while the BE1 ports are in use. No deploy is part of these commands.
