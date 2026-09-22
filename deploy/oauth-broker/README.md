# LLMatic OAuth broker

The VS Code extension can connect browser-first OAuth providers through a small broker so provider client secrets never ship inside the VSIX.

## Atlassian

The broker implements Jira/Atlassian OAuth 2.0 (3LO):

1. VS Code starts a short-lived broker session.
2. The broker returns the Atlassian authorization URL and a separate poll credential.
3. VS Code opens the browser and polls the broker over HTTPS.
4. Atlassian redirects back to the broker.
5. The broker exchanges the authorization code using the server-side client secret.
6. VS Code receives the token lease once, stores it in SecretStorage, and selects the authorized site/project.
7. Rotating refresh tokens are refreshed through the broker; the client secret never reaches the extension.

Required Worker configuration:

- `ATLASSIAN_CLIENT_ID` — variable.
- `ATLASSIAN_CLIENT_SECRET` — secret.
- `ATLASSIAN_REDIRECT_URI` — exact public callback, e.g. `https://<worker>/v1/connections/callback/atlassian`.
- `CONNECTION_SESSIONS` — KV namespace binding. The canonical Wrangler config declares the
  binding without an account-specific id so deployment tooling can provision it without committing
  Cloudflare account state.

The Atlassian app should enable the Jira scopes used by the worker:

- `read:jira-user`
- `read:jira-work`
- `write:jira-work`
- `offline_access`

After deployment, configure the extension setting `llmatic.connectionBrokerUrl` to the public Worker origin.

Manual Jira authentication remains available as an explicit fallback for development and legacy environments.

## Readiness contract

The broker exposes:

```text
GET /health
```

A healthy but incompletely configured deployment returns HTTP 200 with `ready: false` and only the names of missing configuration entries. Secret values are never returned.

The VS Code extension performs this readiness preflight before opening the Atlassian authorization page. If Atlassian is not ready, the browser is not opened and the user sees the missing broker configuration instead.

After deployment run:

```powershell
pnpm run broker:smoke -- https://<broker-origin>
```

Expected result:

```text
OAUTH BROKER SMOKE PASSED
Service: llmatic-oauth-broker
Version: 1
Atlassian: ready
```

## Production deployment checklist

The repository now contains the canonical Cloudflare configuration at
`deploy/oauth-broker/wrangler.jsonc`. The `CONNECTION_SESSIONS` KV binding intentionally
omits a namespace id so a current Wrangler deployment can provision the KV resource automatically.
Do not commit account-specific secrets or Atlassian client credentials.

1. Authenticate Wrangler:
   `pnpm run broker:whoami`.
   If needed, run `pnpm dlx wrangler@latest login` first.
2. Deploy once to obtain the public Worker origin:
   `pnpm run broker:deploy`.
   This first deployment is expected to report `ready: false` until Atlassian values are configured.
3. In the Atlassian developer console, create or select the single distributable LLMatic OAuth 2.0
   (3LO) app and configure the callback URL exactly as:
   `https://<broker-origin>/v1/connections/callback/atlassian`.
4. Add the Jira scopes used by LLMatic:
   `read:jira-user`, `read:jira-work`, `write:jira-work`, and `offline_access`.
5. Configure the non-secret Worker variables `ATLASSIAN_CLIENT_ID` and
   `ATLASSIAN_REDIRECT_URI` in Cloudflare. The redirect URI must exactly match the Atlassian
   callback configured in step 3.
6. Store the client secret through Wrangler:
   `pnpm run broker:secret:atlassian`.
   Paste the Atlassian client secret only into the Wrangler prompt; never put it in the repository.
7. Deploy again:
   `pnpm run broker:deploy`.
8. Verify readiness:
   `pnpm run broker:smoke -- https://<broker-origin>`.
9. Set VS Code `llmatic.connectionBrokerUrl` to the broker origin.
10. Run **LLMatic: Connect Jira Workspace → Continue with Atlassian** and complete browser consent.
11. Select the authorized Jira site/project in VS Code and verify a refresh-token cycle before
    considering the adapter production-ready.

The session poll token is never stored in plaintext by the broker. Browser authorization sessions expire after 10 minutes and successful session material is returned once, then removed from KV.

## Public-endpoint hardening

The Worker intentionally exposes only the browser authorization/session endpoints. Production deployment should also apply platform-level abuse controls:

- rate-limit `POST /v1/connections/start` by client/IP;
- rate-limit failed `GET /v1/connections/status` attempts;
- keep the Worker behind HTTPS only;
- do not log request bodies or Authorization headers;
- keep KV retention limited to the short broker session TTL;
- monitor 4xx/5xx rates without recording access tokens, refresh tokens, authorization codes or poll tokens.

The Worker itself sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. Browser callback pages additionally block framing and external content with CSP.
