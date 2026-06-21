# Phase 1 Spec

Phase 1 stabilizes the current Node behavior so a later Go daemon can be built
against explicit fixtures instead of porting a one-file script by inspection.

## Module Boundaries

- `src/cli.js`: process entrypoint, config load, signal wiring.
- `src/config.js`: config parsing and normalization. Runtime loading does not
  write credential files or extract Keychain data.
- `src/profiles.js`: request-to-profile selection.
- `src/token-store.js`: per-profile token cache, refresh lock, and credential
  write-back.
- `src/transforms.js`: request, response, SSE, thinking, and opaque-payload
  transforms.
- `src/upstream.js`: Anthropic request headers and upstream request creation.
- `src/server.js`: local HTTP server, health endpoint, body streaming, and
  response writing.

## Profile Config Shape

Flat config remains a legacy single-profile form. When `profiles` is present,
root fields act as defaults for each profile.

```json
{
  "port": 18801,
  "profile": "runtime",
  "credentialsPath": "~/.claude/.credentials.json",
  "profiles": {
    "runtime": {
      "credentialsPath": "~/.claude/runtime.credentials.json"
    },
    "family": {
      "credentialsPath": "~/.claude/family.credentials.json",
      "stripSystemConfig": false
    }
  },
  "routing": {
    "type": "clientToken",
    "tokens": {
      "local-runtime-token": "runtime",
      "local-family-token": "family"
    }
  }
}
```

Supported routing modes:

- `profile`: always use the selected profile.
- `header`: use `x-sub-model-profile`, falling back to the selected profile.
- `clientToken`: map local bearer or `x-api-key` tokens to profiles.

Profile selection precedence is `--profile`, then `PROXY_PROFILE`, then
`config.profile` / `config.defaultProfile`, then the first configured profile.

## Deferred Daemon Work

The following belong to the later daemon/product hardening phase:

- strict path/method allowlisting based on observed client traffic;
- request and response size limits;
- upstream deadlines and client-abort cancellation;
- graceful in-flight request draining;
- split `/livez` and `/readyz`;
- structured logs and metrics;
- non-root Docker image and explicit persisted-refresh semantics;
- systemd and LaunchAgent units;
- Go implementation against the Phase 1 fixture suite.
