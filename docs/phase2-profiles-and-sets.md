# Phase 2 Profiles And Sets

Phase 2 makes runtime compatibility explicit instead of treating all rules as
OpenClaw defaults plus local custom arrays.

## Compatibility Sets

Built-in sets:

- `openclaw`: original OpenClaw request/response compatibility rules.
- `hermes-agent`: Hermes Agent rules added after the original OpenClaw set.

Profiles select sets with `compatibilitySets`:

```json
{
  "profiles": {
    "openclaw": {
      "credentialsPath": "~/.claude/openclaw.credentials.json",
      "compatibilitySets": ["openclaw"]
    },
    "hermes": {
      "credentialsPath": "~/.claude/hermes.credentials.json",
      "compatibilitySets": ["hermes-agent"]
    }
  }
}
```

Use both sets when a runtime needs both rule families:

```json
{
  "compatibilitySets": ["openclaw", "hermes-agent"]
}
```

Use no sets when a runtime should use only custom rules:

```json
{
  "compatibilitySets": [],
  "replacements": [["CustomRuntime", "RuntimeCLI"]],
  "reverseMap": [["RuntimeCLI", "CustomRuntime"]]
}
```

Custom `replacements`, `reverseMap`, `toolRenames`, and `propRenames` merge on
top of enabled sets. `mergeDefaults: false` plus `compatibilitySets: []` gives
manual-only behavior.

## Script Behavior

- `setup.js` generates profile-shaped config and supports `--set openclaw`,
  `--set hermes-agent`, repeated/comma sets, and `--no-sets`.
- `troubleshoot.js` loads the same selected profile as `proxy.js`.
- Runtime config checks are set-aware: OpenClaw checks run when `openclaw` is
  active; Hermes Agent checks run when `hermes-agent` is active.
