# Deprecated experimental native Codex scripts

These scripts are retained only for protocol-compatibility archaeology. They are
not installed, invoked, tested as a normal workflow, or supported as a way to
route Codex Desktop.

- `switch-codex-native-mode.ps1` rewrites shared Codex Desktop provider config.
- `install-codex-deepseek-profiles.ps1` downloads a pinned upstream setup script
  and writes native DeepSeek profiles/catalog helpers.

Do not run either script against a real Codex home during Orchestrator-first
development or S0-S9 validation. The supported normal entry is
`scripts/router-terminal.ps1`, which exposes only the deterministic Orchestrator.

Removal is tracked by `docs/16-orchestrator-first-implementation-plan.md`
TODO-07. Keeping these files here does not imply compatibility or support.
