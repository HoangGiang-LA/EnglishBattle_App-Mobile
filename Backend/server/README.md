# Admin authentication server

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
- Admin workspace business pages still use sample data (`MockAdminService`).

## Local server setup

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

Build `Backend/functions` before using the role tool. The commands now share a
durable membership lock with the admin status APIs, protect the last active admin,
preserve unrelated claims and record audit. Revoke also revokes sessions. Grant
requires an active, enabled user; revoke is available for blocked users. Refresh
the client's token after granting. No roles change automatically on startup/login.

For retries, pass `--request-id ID --reason 'Reason'`. If omitted, the command
prints its generated requestId before making changes; preserve it and the reason
on retry. An ambiguous Auth result retains its lock for server review. SDK-tool
audit identifies `server_operator` (service authority), rather than inventing a
signed-in Firebase UID. See [admin users](../functions/ADMIN-USERS.md).

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
