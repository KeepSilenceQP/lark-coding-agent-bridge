# Repository Agent Notes

## TraeX compatibility

When asked to connect TraeX to this bridge, read
`docs/runbooks/traex-codex-compatible-profile.md` before changing code or
configuration.

The established integration is configuration-level: create a `codex` profile
with `LARK_CHANNEL_CODEX_BIN` pointing to the absolute TraeX executable path.
The bridge persists that path and runs TraeX through `CodexAdapter`; a native
`traex` agent kind or source patch is not required while TraeX satisfies the
documented Codex CLI and JSONL compatibility contract.

Verify the redacted profile export, service status, one new turn, and one
resumed turn. Keep TraeX model/provider/auth settings in TraeX, never copy
credentials into the repository or logs, and do not introduce a native
`TraexAdapter` unless the user explicitly requests first-class support or the
compatibility contract has broken.
