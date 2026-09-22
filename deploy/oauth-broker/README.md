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
