# TraeX Through A Codex-Compatible Profile

This runbook records the supported configuration-level way to connect TraeX to
the bridge. It is intentionally not a TraeX-specific source-code integration.

## Integration contract

The bridge has two native agent kinds: `claude` and `codex`. TraeX is connected
as a `codex` profile whose `codex.binaryPath` points at the TraeX executable:

```text
Feishu/Lark message
  -> profile with agentKind=codex
  -> CodexAdapter
  -> TraeX executable
  -> Codex-compatible JSONL events
  -> bridge cards and final reply
```

This works only while TraeX remains compatible with the Codex CLI surface used
by the bridge. Before creating a production profile, verify that the installed
TraeX supports all of the following:

- `exec --json` with the prompt read from stdin via `-`;
- `exec resume --json <thread-id> -`;
- `--sandbox`, `--model`, `-c key=value`, `-C <workspace>`, and
  `--skip-git-repo-check`;
- any enabled bridge options such as `--image`, `--ignore-user-config`, or
  `--ignore-rules`;
- JSONL event shapes accepted by the bridge's `CodexJsonlTranslator`.

Do not create a `traex` agent kind, patch the installed bridge artifact, or add
a wrapper script merely to select the executable. Those changes are not needed
for this compatibility path.

## Create the profile

Resolve the executable first and keep the absolute path for verification:

```bash
command -v traex
traex --version
traex exec --help
traex exec resume --help
```

Create a new profile by overriding the Codex executable for that command:

```bash
LARK_CHANNEL_CODEX_BIN='/absolute/path/to/traex' \
  lark-channel-bridge profile create traex --agent codex
```

`LARK_CHANNEL_CODEX_BIN` is needed only during creation. The bridge resolves
the executable and persists its absolute path in the profile. Later starts use
the stored path:

```bash
lark-channel-bridge start --profile traex
lark-channel-bridge status --profile traex
lark-channel-bridge profile list
```

If the profile already exists, do not recreate it. Inspect the redacted export:

```bash
lark-channel-bridge profile export traex
```

The expected shape is:

```json
{
  "agentKind": "codex",
  "codex": {
    "binaryPath": "/absolute/path/to/traex"
  }
}
```

Never use `--include-secrets` for routine inspection, logs, documentation, or
agent prompts.

## TraeX configuration remains separate

The bridge selects the executable and supplies per-run arguments. TraeX still
owns its model/provider/reasoning configuration and authentication. Configure
those through TraeX's supported commands or its own configuration file; do not
copy credentials into the bridge repository or this runbook.

The bridge deliberately continues to label this profile as `codex`. Therefore:

- the Web UI and `/status` may display `codex`, not `traex`;
- the bridge's model picker contains the Codex catalog and should normally be
  left at its default so TraeX can use its own configured model;
- session probing, resume, developer instructions, sandbox flags, and JSONL
  translation follow Codex assumptions;
- a future TraeX CLI change can break this compatibility without any bridge
  source change.

## Verification after creation or upgrade

Run all of these checks before calling the integration healthy:

1. `profile export traex` still shows the absolute TraeX `binaryPath`.
2. `start --profile traex` or `status --profile traex` reports the expected Bot.
3. A new Feishu/Lark message produces a streamed response and a final reply.
4. A second message in the same chat resumes the same agent session.
5. If the deployment uses images, send one image and verify that TraeX accepts
   the bridge's `--image` invocation.

Bridge package upgrades normally preserve this setup because the profile lives
under `LARK_CHANNEL_HOME`, outside the installed package. Do not delete the
bridge state directory during a reinstall. Re-run the checks above whenever
TraeX or the bridge is upgraded.

## Troubleshooting boundary

- If the executable is missing or moved, repair the profile's stored absolute
  path through the normal profile/config workflow; do not silently fall back to
  `codex`.
- If argument parsing fails, compare `traex exec --help` and
  `traex exec resume --help` with `src/agent/codex/argv.ts`.
- If streaming or final replies fail, compare TraeX JSONL output with
  `src/agent/codex/jsonl.ts`.
- If developer-instruction probing fails, inspect
  `src/agent/codex/prompt-input-capability.ts` before disabling the check.
- Only build a native `TraexAdapter` when TraeX no longer satisfies the contract
  above or when a first-class TraeX product experience is explicitly required.

