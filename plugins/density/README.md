# Density

Install the Density plugin in Codex and complete sign-in.
Start a new chat and ask a workplace question.

The plugin connects to `https://mcp.density.io/mcp`.
It requires no local CLI, local dataset, or manually entered credentials.

Density can query authorized workplace data, compare available datasets, and create charts from query evidence.
The server enforces each user's access.

Let the host refresh expired access tokens automatically.
Use the host's sign-in flow when it reports a terminal grant failure.
If a dataset is pending, report that state to the service operator.
A pending dataset is not a completed analysis.

## Connection recovery

Diagnose the returned failure before requesting another sign-in.
A successful sign-in does not prove that a query has access.
Verify the authorized dataset and run a small query after reconnecting.
See [Density Setup](skills/setup/SKILL.md) for scope checks and duplicate connection recovery.
