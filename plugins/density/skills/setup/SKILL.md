---
name: setup
description: Help users connect the Density plugin, sign in, and diagnose hosted access or dataset preparation errors.
---

# Density Setup

The Density plugin connects to `https://mcp.density.io/mcp` through Streamable HTTP and OAuth.
The hosted server runs tools against the user's authorized data.
The user does not need a local CLI, terminal commands, or local datasets.

## Connect and verify

1. Install the Density plugin through the host's plugin interface.
2. Complete the host's OAuth sign-in flow for Density.
3. Verify that the connection exposes `query_db`, `render_chart`, and `compare_dataset`.
4. Read `density://schema` to verify access to the authorized dataset.
5. Complete the user's requested query with `query_db` when the dataset is ready.

Tool discovery confirms a connection, not dataset readiness or a successful query.
Do not claim that sign-in alone proves the full flow works.
Use the host's actual controls. Do not invent a sign-in button or menu path.
If the host does not expose connection controls, explain the missing control before suggesting another route.

## Diagnose the returned failure

- For an expired access token, let the host attempt automatic refresh.
- For terminal `invalid_grant` or revoked credentials, explain that the host requires sign-in.
- For `insufficient_scope`, inspect the effective configuration and consent before requesting another sign-in.
- For forbidden access, explain the denied operation or dataset; another sign-in does not grant permission.
- For `dataset_pending`, explain that the authorized dataset is still preparing.
- For a temporary server outage, allow a bounded retry and preserve the error and request time.
- For missing tools after sign-in, inspect the connection error before claiming the account has no data.

Do not implement token refresh in the assistant or read the host credential store.
Stop repeated sign-in attempts when the same terminal failure persists.
Do not claim that waiting will fix missing authorization or an unconfigured dataset.
Do not install software, synchronize local data, or switch organizations to bypass an access failure.

OAuth obtains the user's access token through the host.
Server credentials stay on the server.
Do not ask the user to paste tokens, secrets, or authorization headers into chat.
Do not add a static bearer token or custom headers to the normal OAuth connection.

## Check the effective connection

The plugin declares this connection in `.mcp.json`:

```json
{
  "mcpServers": {
    "density": {
      "type": "http",
      "url": "https://mcp.density.io/mcp",
      "scopes": ["density:query"]
    }
  }
}
```

Codex supports `scopes` directly on the server declaration.
Do not move `scopes` inside `oauth`.
The optional `oauth_resource` field identifies an OAuth resource; it does not grant a scope.
The normal connection discovers the resource from server metadata.

A manual `[mcp_servers.density]` connection takes precedence over the plugin's server with the same name.
Codex selects that connection as a whole; it does not inherit missing plugin scopes.
Inspect only the effective URL, scope names, and connection source.
Do not read or print stored credentials.

If a duplicate manual connection is unintended, explain the conflict before changing the user's configuration.
With authorization, remove only that duplicate connection so the plugin owns Density's configuration.
If the manual connection is intentional, preserve it and configure `scopes = ["density:query"]` on that server.
Use `https://mcp.density.io/mcp` as its URL.
After correcting the effective connection, use the host recovery flow if the existing grant still lacks permission.
Configuration changes do not upgrade an existing token's permissions.
Do not prescribe logout, plugin reinstallation, or an application restart as routine recovery.

If `insufficient_scope` persists, inspect sanitized OAuth diagnostics with Density support.
Keep `density:query` explicit in the effective connection; protected resource metadata alone does not ensure Codex requests it.
A synthetic Codex 0.153.4 canary reproduces the production discovery shape.
Without configured scopes, it requests authorization-server scopes and omits `density:query`, despite protected resource metadata advertising that permission.
With configured `density:query`, it requests `density:query offline_access`, including when the login request supplies an empty scope list.
This verifies authorization request construction, not a completed grant or refresh.
Do not infer the requested scopes from a missing scope field in a token response.
Record the connection source, requested scope names, error, and request time without tokens or authorization URLs.

## Verify recovery

1. Confirm that the effective connection uses the intended server and requests `density:query`.
2. Let the host refresh credentials, or complete sign-in when the host reports a terminal grant failure.
3. Read `density://schema` and confirm the authorized organization.
4. Run a small query against an available dataset.
5. Reuse the connection for a follow-up query.

A successful query proves current access; it does not prove that future token refresh succeeds.
Verify refresh separately with a controlled expiry test before claiming durable recovery.
Keep authentication failures separate from `dataset_pending`, forbidden datasets, and server errors.

## Operator configuration check

The operator check requires Node.js and Python 3.11 or newer for standard TOML parsing.
From the Density source checkout, run `node scripts/density-codex-auth-doctor.mjs` for a read-only configuration check.
The report shows collision and scope checks without printing configuration values or credentials.
Its default plugin input is the repository configuration, not proof of the installed or loaded plugin.
Use `--config` and `--plugin-config` to check explicit paths.
Review its findings with the user before removing a manual connection or starting OAuth recovery.

## Codex configuration references

These source checks cover Codex versions 0.144.1 and 0.153.4.
They establish configuration behavior, not successful authentication on a user's account.

- [Plugin configuration parsing](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-mcp/src/plugin_config.rs#L156)
- [Server scopes](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/mcp_types.rs#L253-L263)
- [Connection precedence](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-mcp/src/catalog.rs#L114-L129)
- [OAuth scope selection](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/mcp_processor.rs#L194-L224)
