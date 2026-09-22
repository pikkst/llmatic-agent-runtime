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
- `CONNECTION_SESSIONS` — KV namespace binding.

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

1. Create the Cloudflare Worker and KV namespace.
2. Bind the KV namespace as `CONNECTION_SESSIONS`.
3. Configure `ATLASSIAN_CLIENT_ID`.
4. Store `ATLASSIAN_CLIENT_SECRET` as a Worker secret.
5. Configure `ATLASSIAN_REDIRECT_URI` to the exact public callback:
   `https://<broker-origin>/v1/connections/callback/atlassian`.
6. Add the same callback URI to the Atlassian 3LO app.
7. Deploy the Worker.
8. Run `pnpm run broker:smoke -- https://<broker-origin>`.
9. Set VS Code `llmatic.connectionBrokerUrl` to the broker origin.
10. Run **LLMatic: Connect Jira Workspace → Continue with Atlassian**.

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
