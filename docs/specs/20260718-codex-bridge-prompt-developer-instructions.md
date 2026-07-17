# Codex Bridge Prompt Developer Instructions Spec

Date: 2026-07-18
Status: approved and implemented; runtime rollout pending

## Recommendation

Move the code-owned bridge runtime contract out of the Codex user prompt and
into Codex `developer_instructions`. Keep the dynamic message envelope on
stdin. Apply the developer instructions on every Codex CLI invocation,
including `exec resume`, matching the operational model already used by the
Claude adapter.

This change fixes the Bridge Prompt transport only. Group-specific role,
persona, and project prompts are a separate design and must not be added here.
The implementation and rollout are Codex-only: Claude code, configuration,
processes, and runtime behavior are outside the change boundary.

## Background

The bridge has a code-owned runtime contract that teaches an agent how to
interpret bridge-injected metadata and safely operate inside a Lark channel.
It covers `bridge_context`, quoted messages, interactive cards, bot-to-bot
mentions, the bridge-bound `lark-cli` environment, OAuth handling, and the
agent's resolved Lark identity. This contract is infrastructure protocol, not a
group persona, project brief, or user-authored instruction.

Both the Codex and Claude adapters consume the same semantic contract, but the
repository already gives each adapter its own transport:

- Claude generates the contract with `buildBridgeSystemPrompt(...)`, writes it
  to a temporary file, and passes that file through
  `--append-system-prompt-file`. Its stdin contains only the dynamic message.
- Codex currently calls `prefixBridgeSystemPrompt(...)`, which internally uses
  the same builder and concatenates the contract with the dynamic message on
  stdin.

The issue is therefore not missing Bridge Prompt content. It is a Codex-only
role and transport mismatch: bridge-owned instructions are repeatedly carried
inside the model-visible user message. The desired change is semantic-layer
parity with Claude, not code-path unification and not a claim that static
instructions become token-free or are sent only once per persisted session.

## Problem And Boundary

The Codex adapter currently sends this on stdin for every turn:

```text
<shared bridge runtime contract>

## user_message

<dynamic message envelope>
```

Codex therefore records the bridge contract as part of repeated user input.
This mixes bridge-owned instructions with user content, makes prompt inspection
misleading, and can accumulate duplicate static text in a resumed thread.

The Claude adapter already separates the two layers: the bridge contract is
passed through `--append-system-prompt-file`, while only the dynamic prompt goes
to stdin.

Goals:

- Make the Codex model-visible roles match instruction ownership.
- Keep each turn's stdin equal to the dynamic bridge envelope only.
- Preserve bridge behavior for fresh runs, resume, retries, and bot identity.
- Fail visibly when the installed Codex cannot honor developer instructions.

Non-goals:

- Group Prompt or profile-specific persona support.
- Injecting the Bridge Prompt only once per persisted session.
- Changing Claude prompt transport.
- Editing Claude adapter code or restarting the Claude bridge profile.
- Replacing Codex built-in base instructions.
- Migrating the bridge to Codex MCP, app-server, or exec-server protocols.

## Investigation Findings

### Repository findings

- `src/agent/codex/adapter.ts` calls `prefixBridgeSystemPrompt(...)` and writes
  the combined static and dynamic text to stdin.
- `src/agent/claude/adapter.ts` passes the static prompt through
  `--append-system-prompt-file` and writes only the dynamic prompt to stdin.
- `src/agent/bridge-system-prompt.ts` owns the shared prompt text and exposes
  two different operations: `buildBridgeSystemPrompt(...)` constructs the
  contract, while `prefixBridgeSystemPrompt(...)` additionally serializes that
  contract into a user-message-shaped stdin payload.
- `src/agent/capability.ts` currently declares Codex prompt injection as
  `stdin-prefix` and Claude prompt injection as `append-system-prompt`; the
  Codex capability value must change with the transport or repository metadata
  will contradict runtime behavior.
- Fresh and resumed Codex runs both pass through the same argv builder and
  stdin write site, so the new transport can be applied consistently without
  adding prompt state to the bridge session store.

### Codex capability findings

- The installed Codex CLI is `0.144.5`. Its `exec` and `exec resume` commands
  accept configuration overrides through `-c`.
- The current Codex manual defines `developer_instructions` as additional
  instructions injected before `AGENTS.md`.
- A live local `codex debug prompt-input` probe confirmed that a
  `developer_instructions` sentinel appears in a model-visible message with
  role `developer`, while the supplied task remains role `user`.
- `model_instructions_file` overrides Codex built-in base instructions and is
  therefore not an acceptable transport for this feature.

Codex `exec` does not expose a Claude-style
`--append-system-prompt-file` option. The supported additive instruction
surface available to the existing process adapter is the
`developer_instructions` configuration value. Moving to an MCP or app-server
transport could provide a more structured boundary, but would also replace the
current process, streaming, resume, and failure contracts and is not justified
for this fix.

### Claude comparison and non-claims

Claude's existing transport is useful as the semantic reference: static
bridge instructions are not embedded in the user message. It is not evidence
that the prompt is transmitted only once, cached for free, or excluded from
model input accounting. The bridge starts a Claude CLI process for each run and
passes the append-system-prompt file as part of that invocation.

This proposal adopts the same separation of instruction ownership for Codex
while retaining Codex's own supported transport. It does not change, wrap, or
normalize the Claude path.

The remaining unknown is cross-platform argument fidelity for a multiline
TOML string, especially when Codex resolves through a Windows command shim.
That is a validation gate, not an assumed capability.

## `buildBridgeSystemPrompt` Responsibility And Boundary

`buildBridgeSystemPrompt(identity)` is a shared content builder. Its current
contract is:

1. Return the code-owned `BRIDGE_SYSTEM_PROMPT` unchanged when the bot identity
   is not yet available.
2. When `identity.openId` is known, append the concrete self-identity section;
   include the display name when present.
3. Return text only. It does not choose a model role, write stdin, construct
   argv, create a temporary file, manage a Codex thread, or persist session
   state.

The transport boundary begins after this function returns:

```text
buildBridgeSystemPrompt(identity)
                 |
                 +-- ClaudeAdapter -> temporary file
                 |                   -> --append-system-prompt-file
                 |                   -> dynamic prompt on stdin
                 |
                 +-- CodexAdapter  -> developer_instructions  [target]
                                     -> dynamic prompt on stdin
```

`prefixBridgeSystemPrompt(prompt, identity)` is not the shared content
contract. It is a serialization helper for the current Codex transport: it
calls `buildBridgeSystemPrompt(...)`, adds the `## user_message` delimiter, and
concatenates the dynamic prompt. The target Codex path must stop using this
helper; the helper may remain for compatibility unless a separate cleanup is
approved.

For this change, the following are hard boundaries:

- Do not edit `BRIDGE_SYSTEM_PROMPT` content.
- Do not change the signature, output, identity fallback, or identity wording
  of `buildBridgeSystemPrompt(...)`.
- Do not move transport decisions into the shared builder.
- Do not change Claude's call to `buildBridgeSystemPrompt(...)`, temporary-file
  handling, `--append-system-prompt-file`, or stdin behavior.
- Reuse the builder from Codex so the content remains exactly the same; change
  only where the returned text is transported.

This boundary matters because changing the shared prompt text or builder
semantics would affect both Codex and Claude. Reusing the builder without
changing it does not alter Claude behavior.

## Proposed Contract

### Codex-only change boundary

The implementation may change only the Codex adapter, Codex argv construction,
the Codex branch of the shared capability model, Codex-focused tests, and this
documentation. It must not change:

- `src/agent/claude/adapter.ts` or Claude argv behavior;
- the content of the shared `BRIDGE_SYSTEM_PROMPT`;
- Claude profile configuration, session state, service definition, or running
  process;
- shared prompt behavior for any adapter other than Codex.

Using the existing shared `buildBridgeSystemPrompt(...)` function from Codex is
allowed because it changes no shared content or Claude call path. Any broader
shared-helper refactor requires separate approval.

The capability model must add a distinct injection mode such as
`developer-instructions` and return it only from `codexCapability(...)`.
Adding the union member is a type-level extension; the value returned from
`claudeCapability(...)` and all Claude capability assertions must remain
unchanged.

### Model-visible layers

Each Codex invocation must produce these logical layers:

```text
Codex built-in system instructions
Codex developer message:
  shared bridge runtime contract
  runtime bot identity, when known
Codex user message:
  dynamic bridge_context / quoted message / card / attachment envelope
  actual user input
```

The adapter must stop calling `prefixBridgeSystemPrompt` for stdin. It instead
builds the existing static prompt with `buildBridgeSystemPrompt(identity)` and
supplies that value as `developer_instructions`. `opts.prompt` is written to
stdin unchanged.

Fresh and resumed invocations use the same contract. This design intentionally
does not add session prompt hashes or first-turn seeding state: Codex receives
the developer layer on every CLI invocation, but it is no longer appended as a
user turn.

### Codex CLI transport

The first implementation may use the supported config override:

```text
-c developer_instructions=<TOML string>
```

Requirements:

- Encode the value as a single TOML-compatible string; never interpolate it
  through a shell command.
- Pass it through the existing argv-array spawn boundary.
- Never log the encoded value or full argv.
- Treat the Bridge Prompt as code-owned public protocol. This transport is not
  approved for future Group Prompt content, secrets, or private context.
- Verify multiline text, quotes, backticks, XML-like tags, and non-ASCII text.
- If Windows argument fidelity cannot be proven, do not claim Windows support;
  use a bridge-managed Codex config layer in a follow-up before enabling it
  there.

`developer_instructions` is a scalar configuration override. For bridge-spawned
Codex runs it becomes the authoritative developer-instruction value; it may
replace a user-level value configured under the same key. Repository and global
`AGENTS.md` guidance remains a separate Codex instruction layer. This tradeoff
must be explicit in release notes.

### Capability failure

The bridge must not silently fall back to prefixing the static contract onto
the user prompt. An unsupported or rejected `developer_instructions` override
must fail the run with a concise local diagnostic.

Passing an arbitrary `-c` key is not itself a capability check: the current
Codex CLI can exit successfully while tolerating an unknown configuration key.
The Codex adapter must therefore perform a real fail-closed preflight before
the first agent run:

1. Execute `codex debug prompt-input` with a developer sentinel and a distinct
   user sentinel under the same immutable binary, `CODEX_HOME`, and profile
   environment used by that adapter instance.
2. Parse the structured prompt inspection result and require the developer
   sentinel under role `developer` and the user sentinel under role `user`.
3. Cache only a successful result for the lifetime of that adapter instance;
   a new adapter, binary path, profile, or Codex home must probe again.
4. If the command is missing, exits non-zero, cannot be parsed, times out, or
   reports the wrong roles, reject `prepareRun` with a stable diagnostic before
   spawning `codex exec`.

The preflight must not invoke a model, log either sentinel payload as user
content, or modify Codex session state. Unit and process tests must cover probe
success, role mismatch, missing debug support, malformed output, timeout, and
successful-result caching. A version check may improve the diagnostic but may
not replace the behavioral probe.

Before rollout, the supported Codex build must pass a real capability probe
equivalent to:

```text
codex debug prompt-input -c developer_instructions=<sentinel> <user sentinel>
```

The proof requires the first sentinel under role `developer` and the second
under role `user`. Version output alone is insufficient evidence.

## Runtime And Failure Behavior

- Bot identity continues to be late-bound through `setBotIdentity`; subsequent
  invocations must carry the resolved identity in developer instructions.
- Startup retry must reuse the same developer instructions and dynamic prompt
  as the original attempt.
- `/new`, `/reset`, `/resume`, workspace changes, model changes, and bridge
  restarts require no prompt-specific migration state because every invocation
  re-establishes the developer layer.
- Prompt construction or encoding failure rejects before process spawn.
- A Codex non-zero exit remains observable through the existing adapter error
  stream; prompt contents must not be included in the error.
- Resume uses the same global developer override as a fresh run. Because
  `debug prompt-input` does not inspect a persisted thread, runtime acceptance
  for resume is partly indirect and must be reported as such.

## Alternatives

### Inject only on a fresh Codex session

Deferred. It reduces repeated request input but introduces prompt-version
state, legacy-session migration, restart recovery, and partial-first-turn retry
ambiguity. It is not required to fix the incorrect user-role transport.

### Use `model_instructions_file`

Rejected because it replaces Codex built-in base instructions rather than
adding a bridge-owned developer layer.

### Use `AGENTS.md`

Rejected because its scope follows filesystem/workspace hierarchy, not the
bridge runtime, and it would affect non-bridge Codex work in the same workspace.

### Run Codex as an MCP or app server

Deferred. Structured protocols can transport developer instructions without
argv exposure, but replacing the current JSONL process adapter is a materially
larger lifecycle and streaming change.

## Rollout And Rollback

1. Add process-contract tests that prove stdin contains only the dynamic prompt
   and the Codex config override decodes to the existing Bridge Prompt.
2. Cover both fresh and resumed runs, plus resolved bot identity.
3. Add fail-closed capability-preflight tests and run the real local
   model-visible prompt probe without invoking a model turn.
4. Run a fresh Codex canary, then resume that exact thread with a second dynamic
   prompt. Inspect the persisted thread/run evidence to verify that neither new
   user turn contains the Bridge Prompt and that both turns preserve expected
   bridge behavior. The resume result is behavioral and persistence evidence,
   not direct proof of its model-visible developer role unless Codex exposes a
   resume-aware prompt inspector.
5. Run focused process tests, the full test suite, typecheck, and build.
6. Deploy a Codex-scoped artifact or service entry, restart only the Codex
   bridge profile, and start a new group session for runtime acceptance. Do not
   restart, reconfigure, or repoint the Claude service during this rollout.

Rollback restores `prefixBridgeSystemPrompt` and removes the developer override.
No user data or session-file migration is required.

## Acceptance Criteria

- Fresh Codex stdin exactly equals the dynamic prompt supplied by the bridge.
- Resumed Codex stdin exactly equals the new dynamic prompt.
- The decoded developer override contains the complete shared bridge contract,
  CardKit callback rules, lark-channel environment rules, OAuth rules, and the
  resolved bot identity.
- Neither fresh nor resumed user input contains the shared Bridge Prompt.
- The real Codex prompt inspector reports the bridge sentinel as role
  `developer` and the task sentinel as role `user`.
- Unsupported developer-instruction transport fails visibly with no fallback to
  user-prefix injection.
- The capability preflight runs before the first Codex execution, caches only a
  verified success per adapter instance, and blocks execution for missing,
  malformed, timed-out, or role-mismatched probe results.
- Prompt bodies do not appear in bridge logs or error messages.
- `codexCapability(...).promptInjection` reports `developer-instructions`, while
  `claudeCapability(...).promptInjection` remains `append-system-prompt`.
- `src/agent/claude/adapter.ts`, Claude configuration, and Claude service files
  have no diff.
- Existing Claude process-contract tests remain unchanged and pass, proving its
  stdin, `--append-system-prompt-file`, resume, and model argv contracts are
  byte-for-byte unchanged.
- Runtime rollout restarts only the Codex profile; the Claude PID and start time
  remain unchanged across deployment verification.
- A fresh thread and a real resume of that same thread both complete; persisted
  evidence shows no newly added Bridge Prompt in either user turn. Unless a
  resume-aware inspector is available, the resume developer-role claim is
  explicitly labeled indirect rather than model-visible proof.
- Full tests, typecheck, build, and `git diff --check` pass before deployment.

## Decision Requested

Approve or reject the first-version transport choice:

- **Recommended for the current macOS deployment:** per-invocation Codex
  `-c developer_instructions=<encoded Bridge Prompt>`.
- **Stricter cross-platform alternative:** first build a bridge-managed Codex
  config layer and pass only its profile name on argv.

Approval of this Spec does not approve Group Prompt storage or transport.
