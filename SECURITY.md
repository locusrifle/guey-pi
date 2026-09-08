# Security

Guey runs Pi with the operating-system permissions of the user who starts it. Tools can read and modify files, run commands, and access credentials available to that process. Extensions are executable code. This is not a sandbox or a multi-user service.

## Network boundary

- The stock launcher binds loopback by default.
- The server accepts only loopback or Tailscale-range IPv4 binds. Host and Origin checks help prevent requests from unrelated browser pages.
- There is no application access-control authentication. Provider OAuth/API-key setup authenticates to a model provider, not to Guey.
- Any process or network peer able to reach and speak to the console may exercise your account's authority. Private-network membership must be trusted.
- Never expose Guey through a public hostname, reverse proxy, tunnel or port forward. Adding an allowed Origin does not add authentication.

Use a VM or an appropriately restricted OS account for untrusted projects. Treat prompts, repository instructions, external content and extensions as inputs that may influence a shell-capable agent.

## Credentials and persistence

By default the launcher shares `~/.pi/agent` credentials, models and settings with terminal Pi, but keeps Guey's sessions in its own state directory. Login and logout can change credentials used by your terminal. Session transcripts and logs can contain sensitive data. Closing a browser leaves the agent running; stopping the launcher ends an active turn.

The optional terminal bridge protects only sessions advertised by terminals running that extension. Pi session files are not universally locked. Avoid opening one session for writing in multiple processes.

`GUEY_ISOLATE=1` is a test/resource-discovery mode, not a security sandbox and not a promise that real credentials are unavailable. Use an empty HOME and a scrubbed environment for clean-profile testing.

## Reporting a vulnerability

Please do not post credentials or an exploitable vulnerability in a public issue. Use the repository's **Security → Report a vulnerability** when private reporting is enabled. If it is unavailable, open an issue requesting a private reporting channel without including exploit details.

This preview has no guaranteed response time or long-term support policy. Include the commit/version, OS, Node/Pi version, affected boundary and a minimal reproduction using synthetic data.
