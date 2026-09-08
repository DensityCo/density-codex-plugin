---
name: setup
description: Help users connect the Density plugin, sign in, and diagnose hosted access or dataset preparation errors.
---

# Density Setup

The Density plugin connects to `https://mcp.density.io` through Streamable HTTP and OAuth.
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

- For an authentication error, ask the user to reconnect and sign in again.
- For forbidden access, explain that the server did not authorize the requested operation or dataset.
- For `dataset_pending`, explain that the authorized dataset is still preparing.
- For a server error, report the error and request time for Density support.
- For missing tools after sign-in, inspect the connection error before claiming the account has no data.

Stop automatic retries on an authentication failure until the user reconnects.
Do not claim that waiting will fix missing authorization or an unconfigured dataset.
Do not install software, synchronize local data, or switch organizations to bypass an access failure.

OAuth obtains the user's access token through the host.
Server credentials stay on the server.
Do not ask the user to paste tokens, secrets, or authorization headers into chat.
Do not add a static bearer token or custom headers to the normal OAuth connection.
