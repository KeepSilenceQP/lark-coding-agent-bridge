# Group-scoped System Prompt Spec

Date: 2026-07-18
Status: implemented and verified; runtime content canary pending operator-authored prompt

## Recommendation

Add an optional, operator-managed instruction layer scoped by both the active
bridge profile and the trusted Feishu/Lark group `chatId`.

Use a deterministic live configuration path for the first version:

```text
<profileDir>/prompts/groups/<chatId>.md
```

Pin the resolved content, including an explicit "no prompt" state, when a new
Claude session or Codex thread is created. A resumed session/thread keeps using
that pinned version. Editing the Markdown file requires `/new` before the new
version takes effect; restarting the bridge is not required.

Persist prompt bodies as immutable, content-addressed snapshot files:

```text
<profileDir>/prompts/session-snapshots/<sha256>.md
```

Keep immutable per-agent-session binding records in a separate, versioned
sidecar that old bridge binaries do not read or rewrite:

```text
<profileDir>/prompts/session-bindings.v1.json
<profileDir>/prompts/session-bindings.v1.activated
```

The sidecar is the single commit authority for immutable Session records,
active pointers, reset tombstones, and retirement metadata. The independent
activation marker distinguishes first install from accidental Sidecar loss.
The existing `SessionCatalog` and Claude `SessionStore` become compatibility
mirrors that are repaired from the healthy Sidecar before resume.

A profile remains dormant while both activation files are absent. Dormant
profiles use the existing Session mechanisms unchanged. Activation occurs only
when a fresh eligible group Session finds a valid live Group Prompt; after the
marker commits, the Sidecar remains authoritative for that profile even if all
live Prompt files are later removed.

This design gives the target group a durable role definition without changing
the shared bridge protocol, other groups, p2p chats, or other profiles.

## Background And User Need

The originating request is to give "小P in this group" a durable role,
operating style, and behavioral contract similar to a group-specific `soul.md`.
That role must survive bridge restarts and conversation compaction, but must not
change the same bot profile in another group or in p2p.

The existing instruction surfaces do not satisfy that scope:

- Editing `BRIDGE_SYSTEM_PROMPT` changes a code-owned protocol used across
  profiles and is overwritten by package upgrades.
- Telling the agent once in chat relies on conversation history and disappears
  with a fresh session.
- A profile-wide `SOUL.md` would affect every group and p2p chat served by that
  profile.
- Appending operator configuration to `user_input` would mix trusted runtime
  policy with user-controlled message content and repeat it as user history.

This work is separate from the completed Codex Bridge Prompt transport change.
That earlier change moved the shared bridge instructions out of Codex stdin and
into Codex `developer_instructions`. This spec does not revisit that transport
decision. It introduces an optional group layer on top of the current mainline
behavior.

## Goals

- Let one profile in one Feishu/Lark group use durable operator instructions.
- Preserve the shared bridge protocol and platform instructions as higher
  priority than the group layer.
- Keep one prompt version stable for the lifetime of a logical agent session.
- Allow an operator to edit configuration without rebuilding or restarting the
  bridge; `/new` is the activation boundary.
- Preserve the byte-for-byte adapter instruction string when no group prompt is
  bound, and preserve the complete pre-feature Session path for dormant profiles.
- Make resolution, pinning, and failures observable without logging prompt
  content.

## Non-goals

- A profile-wide `SOUL.md` layer.
- Editing prompts through a Feishu command, card, or ordinary group message.
- Remote prompt distribution, prompt history UI, or access-control UI.
- Automatically replacing instructions inside an already-running session.
- Making Claude and Codex native system-message semantics identical.
- Eliminating the per-invocation token cost of instructions. Session pinning is
  a versioning contract, not a promise that the CLI transmits the prompt only
  once.

## Current Mainline Evidence

The following statements are supported by the current worktree, which starts at
main commit `d853f8a`:

- `src/config/app-paths.ts` resolves a distinct `profileDir` and
  `sessions.json` for each profile. A file under one profile is therefore
  naturally isolated from other profiles.
- `src/agent/bridge-system-prompt.ts` owns `BRIDGE_SYSTEM_PROMPT` and
  `buildBridgeSystemPrompt(identity)`. The builder currently composes the
  shared protocol plus the runtime bot identity and performs no filesystem,
  profile, chat, or session lookup.
- `src/agent/claude/adapter.ts` creates a temporary file from
  `buildBridgeSystemPrompt(...)` on every CLI invocation and passes it via
  `--append-system-prompt-file`, including resumed invocations.
- `src/agent/codex/adapter.ts` creates
  `developer_instructions=buildBridgeSystemPrompt(...)` on every CLI
  invocation. `src/agent/codex/argv.ts` passes the same developer override for
  both fresh `codex exec` and `codex exec resume`.
- `src/agent/types.ts` has no dedicated group instruction field in
  `AgentRunOptions`; `src/runtime/run-executor.ts` currently forwards only the
  dynamic turn prompt and execution/session settings.
- `src/bot/channel.ts` has trusted `chatId`, `chatType`, resolved chat mode, and
  topic `threadId` before dispatch. Adapters do not need to parse identifiers
  from prompt text.
- `src/bot/scope.ts` uses `chatId` as normal group scope and
  `<chatId>:<threadId>` as topic-group scope. Topics therefore have independent
  sessions even though they resolve configuration from the same parent
  `chatId`.
- `src/session/catalog.ts` persists the active Claude `sessionId` or Codex
  `threadId` under the profile's sessions catalog. Catalog writes are atomic
  and mode `0600`, but entries currently have no prompt binding. Its key is the
  scope/agent/cwd/policy identity rather than the agent session identifier, so a
  later active entry for the same identity replaces the retained map entry.
- `SessionCatalog.load()` currently treats malformed data as an empty catalog,
  and scheduled persistence errors are logged rather than propagated. Claude
  can then fall back to its legacy `SessionStore`; these are current behaviors,
  not acceptable binding guarantees for this feature.
- `src/commands/index.ts` archives the current catalog entry on `/new` and
  clears the legacy session store. The next ordinary message creates a fresh
  agent session/thread.
- The current `/resume` history picker is exposed only in p2p and enumerates
  vendor history by cwd. Its candidate token records the target session/thread
  and the current identity, but not the target's original group/topic scope.

No runtime experiment in this spec proves how either vendor internally accounts
for repeated instructions. The bridge-side fact is narrower: both adapters
resupply their instruction input on every fresh or resumed CLI process.

## Trust And Ownership Boundaries

### Shared Bridge Protocol

`BRIDGE_SYSTEM_PROMPT` remains code-owned and common to the bridge. It defines
message-envelope interpretation, bot-at-bot behavior, OAuth constraints, tool
safety, and other bridge protocol rules. Group configuration cannot replace or
edit it.

### `buildBridgeSystemPrompt`

The builder remains a pure composition boundary. Its target contract may accept
an already-resolved optional group addendum, but it must not:

- read files;
- resolve profile paths;
- inspect `chatId`, `chatType`, or session state;
- parse identifiers from user prompt text; or
- decide whether a group prompt should apply.

Its composition order is:

```text
1. Shared bridge protocol and safety rules
2. Group-scoped operator instructions, when pinned
3. Runtime bot identity
```

The group content is wrapped in an explicit `group_system_prompt` section that
states its lower priority than the shared bridge protocol and higher-priority
platform instructions.

### Dynamic Turn Envelope

The per-turn Feishu/Lark envelope remains the adapter's user prompt. Group
content is never copied into `bridge_context`, `bridge_instructions`,
`quoted_message`, `interactive_card`, or `user_input`.

### Agent Adapters

Adapters only transport the composed instruction string:

- Claude continues using `--append-system-prompt-file`.
- Codex continues using `developer_instructions`.

When no addendum is bound, each adapter must receive exactly the instruction
content it receives before this feature. The target Codex profile is the first
rollout; a dormant Claude profile with no prompt files never activates this
feature and has no Session-path behavior change.

## Configuration Resolution

Only a trusted bridge event with `chatType === "group"` is eligible to trigger
or receive Group Prompt configuration. Once a profile is activated, fresh p2p
Sessions bind the explicit "no group prompt" state; dormant p2p remains on the
existing path without creating Prompt state.

For a fresh eligible session:

1. Take `chatId` from the normalized bridge event, never from message text.
2. Validate it as a single safe filename component. Reject empty values, `.`,
   `..`, path separators, NUL, and values outside the supported identifier
   character/length policy.
3. Resolve `prompts/groups/<chatId>.md` beneath the active `profileDir`.
4. If the groups directory or final file is absent, bind explicit `none`; do not
   attempt to canonicalize a nonexistent final path.
5. For an existing file, validate the already-existing parent chain beneath the
   canonical profile root and reject symlink/reparse-point path components.
6. Open the final file with no-follow semantics. On platforms with
   `O_NOFOLLOW`, use it; otherwise use a tested platform-equivalent primitive or
   reject the file. Path-check-then-ordinary-read is not sufficient.
7. On the same open file descriptor, `fstat`, require a regular file, read no
   more than 64 KiB plus one sentinel byte, and decode UTF-8 in fatal mode.
   Compare identity, size, and modification metadata with a second `fstat`
   after reading; reject empty, oversized, invalid UTF-8, or
   changed-during-read content.
8. Hash the exact accepted bytes with SHA-256.
9. Create the immutable snapshot using exclusive create (`wx`) with mode
   `0600`, then fsync the file and parent directory where supported.
10. If the hash-named snapshot already exists, reopen it with no-follow
    semantics and verify regular-file type, exact byte count, and SHA-256 before
    reuse. Any mismatch fails closed.

Topic groups resolve the same live file by parent `chatId`, but each topic scope
pins its own version when that topic's session is created. Two topics created on
opposite sides of an edit may therefore intentionally use different versions.

## Session-pinned Prompt Contract

### Authoritative Ledger And Compatibility Mirrors

The new versioned Sidecar is the single commit authority. It contains immutable
records keyed by the vendor agent session identifier:

```text
claude:<sessionId>
codex:<threadId>
```

Each record contains:

```text
agent id and sessionId/threadId
origin profile
origin source (`im` or `comment`), scopeId, and source-specific identifiers
(chatId/chatType/topic threadId for IM; document/comment thread scope for
comments). Imported `legacy-none` may use `chatType: legacy-unknown` when old
stores prove scope but not chat type.
binding: none | legacy-none | pinned { sha256, byteCount }
provenance: created | imported-active | adopted-legacy
createdAt
```

The same atomic Sidecar document also contains mutable control indexes:

```text
activeByIdentity: identity key -> agent session key
legacyActiveByScopeCwd: scope/agent/cwd key -> agent session key
resetTombstones: identity key -> reset generation and resetAt
retiredAt: agent session key -> retirement timestamp
unreferencedSnapshots: sha256 -> unreferencedAt
schemaVersion, installId, activatedAt, phase: migrating | active, ledgerRevision
```

The identity key uses the existing scope/agent/cwd/policy identity. An active
pointer or reset tombstone in the Sidecar takes precedence over both existing
stores.

Some independent Claude legacy entries lack `policyFingerprint`. Migration
stores them under `legacyActiveByScopeCwd` without inventing one. On the first
legal run for that scope/cwd, the bridge computes the real policy identity from
current trusted inputs and atomically promotes the transitional pointer to
`activeByIdentity`. Conflicting transitional/identity pointers fail closed.

The existing `SessionCatalog` and Claude `SessionStore` remain compatibility
mirrors for current command/runtime surfaces. They are not commit authorities.
On startup and before resume, a healthy Sidecar repairs missing or stale mirror
session identity state where unambiguous; if repair cannot durably complete,
runs remain blocked.

Claude `SessionStore.idleTimeoutMinutes` is an independent user preference and
is not duplicated into the Group Prompt Sidecar. For a healthy, parseable
SessionStore, repair may update only `sessionId` and cwd while preserving the
timeout value. If the whole store is corrupt and the preference cannot be
recovered, the bridge must fail closed and require administrator repair or an
explicitly confirmed preference reset; it must not claim a complete rebuild
from Sidecar.

All Sidecar mutations for one profile share one serialized transaction queue.
The profile-scoped Prompt Session service and its queue are constructed and
loaded once inside the outer profile runtime-lock lifetime, above the channel
connection lifetime. Connect-before-disconnect reconnects reuse that same
service, including its profile-wide run-admission controller and dormant-run
registry; they must not create two ledgers, queues, or admission domains. Every
IM and comment run from every overlapping channel registers through this shared
controller before `RunExecutor.submit(...)`. Per-channel `ActiveRuns` remains
only a local scope/process handle registry and cannot implement the activation
barrier. The process retains the existing profile writer lock for this entire
lifetime, which supplies cross-process single-writer exclusion.

Inside that service, each transaction reads the latest committed in-memory
ledger inside the queue, validates all invariants, builds a new document with
`ledgerRevision + 1`, atomically persists/fsyncs it, and only then publishes
the new in-memory state and releases the queue. Atomic rename is not treated as
concurrency control. A stale expected revision or an unexpected on-disk
revision fails closed and forces reload/reconciliation; it never overwrites a
newer ledger. The existing per-scope active-run exclusion remains useful for
user turns, but it is not relied on to serialize transactions from different
groups, topics, p2p scopes, comments, reset commands, migration, or GC.

`none` is an explicit result for a new eligible session with no live file or a
p2p session. `legacy-none` means the session is proven to predate feature
activation and therefore never had a Group Prompt. `pinned` derives its
snapshot path from the validated SHA-256 value. Prompt bodies are never stored
inline in either catalog.

The activation marker is a separate mode-`0600` file containing the same
`installId` and `activatedAt` as the Sidecar. Marker/Sidecar absence and mismatch
are interpreted as described by the migration contract below.

### Dormant And Activated Profiles

- `marker absent + Sidecar absent` means dormant, not automatically activated.
- A dormant p2p run, a dormant group resume, or a fresh group run with no live
  Prompt uses the pre-feature Session path and creates no Prompt state files.
- Adding a live file does not alter an already-active legacy Session. The
  operator uses `/new`; that command validates the file, activates the profile,
  and commits a durable reset before replying.
- A fresh eligible run that finds an invalid live file fails without activating
  or silently omitting it.
- A fresh eligible run that finds a valid live file must complete profile
  migration and the final `phase: active` Sidecar commit before the run is accepted.
- Once marker plus `phase: active` Sidecar exist, the profile is permanently activated unless an
  explicit administrative reset procedure removes all Prompt state while the
  bridge is stopped. Ordinary file deletion never returns it to dormant mode.

This gate keeps unconfigured Claude and other profiles on their existing
runtime path and failure surface.

### First-install Migration

Before accepting the first activating run:

1. Enter the shared Prompt Session service's profile-wide activation barrier
   before enumerating legacy stores. Close its admission gate across every
   temporarily overlapping channel and track every run admitted while the
   profile was dormant across IM and comment scopes. Wait until each prior run has either
   durably recorded its vendor identifier and mirrors or terminated without an
   identifier. If this cannot complete within the activation deadline, abort
   activation, release the pause, retain dormant behavior, and do not create an
   activation marker or claim `/new` success. Do not stop unrelated runs merely
   to force activation.
2. Interpret `marker absent + Sidecar absent` as dormant until activation is
   triggered. Interpret `marker present + Sidecar absent`,
   version/install-id mismatch, or malformed state as `corrupt` and fail closed.
3. Enumerate every active Catalog entry and every complete independently
   resumable Claude legacy entry (`scopeId`, `sessionId`, and cwd), not only
   entries already matched across both stores.
4. Merge entries only when identical agent session identifiers agree on origin
   scope and cwd. Classify `doc:` scopes as comment; other old scopes may retain
   `legacy-unknown` chat type rather than guessing p2p/group. Any conflict fails
   migration rather than guessing.
5. Build a complete `phase: migrating` Sidecar containing imported immutable
   `legacy-none` records. Catalog entries with full policy identity populate
   `activeByIdentity`; independent Claude legacy entries without a fingerprint
   populate `legacyActiveByScopeCwd`. Do not invent a fingerprint or
   retroactively attach the live group file.
6. Persist/fsync the migrating Sidecar, then exclusively create/fsync the
   activation marker, then atomically persist/fsync `phase: active`. The final
   phase transition is the activation commit point; no bridge run is accepted
   earlier.
7. `phase: migrating + marker absent` is an interrupted pre-marker
   initialization: re-enumerate all current migration sources and rebuild or
   supplement the migration ledger before recreating the marker. `phase:
   migrating + matching marker` is an interrupted post-marker initialization:
   revalidate sources and complete the active-phase commit. `phase: active +
   marker absent` is post-activation marker loss and is always `corrupt`; never
   rebuild an active ledger from legacy sources.
8. A vendor-history candidate with no Sidecar record may be lazily adopted as
   `legacy-none` only when its trusted history timestamp is strictly earlier
   than `activatedAt`. Adoption creates one immutable record bound to the
   current p2p identity with `provenance: adopted-legacy`; it does not claim to
   recover an unknown original scope. A missing record at or after activation
   is unsafe and is rejected.

### Fresh Session Flow

1. The channel resolves the group binding once before submitting the first
   run. For a valid pinned binding, an activated Sidecar must exist before the
   snapshot is created.
2. After exclusive snapshot create/revalidation, and before dispatching the
   agent, one serialized Sidecar transaction registers
   `unreferencedSnapshots[sha256] = unreferencedAt` if the hash has no retained
   record reference. This is the GC grace-period start for a run that never
   returns an agent identifier. Reusing a hash already referenced by any
   retained record does not create an unreferenced marker.
3. The immutable binding, origin context, and optional content travel
   separately from the user prompt through run policy/execution into
   `AgentRunOptions`, using a dedicated field such as
   `systemPromptAddendum`.
4. Startup retry for the same Feishu turn reuses the same in-memory resolution;
   it does not reread the live file.
5. When Claude emits `sessionId` or Codex emits `threadId`, construct one
   Sidecar transaction that inserts the immutable record and changes the
   matching `activeByIdentity` pointer while clearing its reset tombstone and
   any `unreferencedSnapshots` marker for the pinned hash.
6. Atomically persist and fsync that Sidecar transaction. This is the one commit
   point at which the session becomes safely resumable.
7. Only after the commit succeeds, update and await the `SessionCatalog` and
   applicable Claude legacy-store compatibility mirrors. Mirror failure marks
   runtime state degraded and blocks further runs for that identity until a
   repair from Sidecar succeeds; it does not undo or obscure the committed
   authoritative state.
8. No active state is exposed in memory before the Sidecar commit. A failure
   before the agent identifier leaves a snapshot whose persisted
   `unreferencedAt` allows GC to remove it after the grace period.
9. For a fresh activated run, the first vendor identifier event is a delivery
   barrier. The stream consumer awaits the authoritative commit and required
   mirror outcome before delivering substantive output. If commit or required
   mirror repair fails, it marks the run failed, disables startup retry, stops
   and reaps the agent process, discards later events, releases the active
   scope, and returns a stable content-free error on the IM or comment surface.
   It must not continue rendering a run that cannot be resumed safely.

### Automatic Resume Flow

1. Require healthy Sidecar/activation state. `corrupt` state never becomes an
   empty ledger.
2. Resolve the authoritative active pointer and require an exact immutable
   record for its agent/session identifier, current profile, and origin scope.
   A reset tombstone means fresh session even if a mirror still contains an old
   identifier.
3. For `none` or `legacy-none`, compose current bridge instructions without a
   group layer.
4. For `pinned`, securely read and revalidate the content-addressed snapshot and
   use that exact content.
5. Never reread or fall back to `prompts/groups/<chatId>.md` for an existing
   session.
6. A missing record, scope mismatch, unreadable snapshot, or hash mismatch
   fails closed.

Claude legacy fallback is allowed only after the Sidecar confirms the exact
legacy `sessionId` is the authoritative active pointer for the same identity
and origin scope. Mirror corruption, an unknown post-activation session, a
reset tombstone, or an invalid binding disables fallback. A healthy Sidecar may
repair a mirror before the run; it may not infer a binding from that mirror.

The bridge still resupplies the composed instruction string to each new CLI
process because that is how both adapters invoke fresh and resumed runs. The
session contract guarantees that the group portion is the same version; it does
not rely on the vendor retaining or deduplicating it internally.

### Non-IM Comment Sessions

`src/bot/comments.ts` is the other direct agent-execution path. It is not
eligible for Group Prompt content.

- On a dormant profile, comment fresh/resume behavior remains unchanged.
- On an activated profile, every fresh comment Session records explicit `none`
  with `origin source: comment`, its document/comment scope, and the same
  authoritative commit/mirror sequence.
- Comment automatic resume requires an exact comment-origin Sidecar record and
  never consumes an IM group binding.
- First-install migration imports active comment Catalog/legacy entries as
  `legacy-none` under their comment scopes.
- Comment integration tests cover fresh, resume, restart, reset, mirror repair,
  and prove no Group Prompt content reaches the adapter.

`src/commands/index.ts` also calls `RunExecutor.submit(...)` for the sessionless
`/doctor` agent echo. That probe always uses no Group Prompt, creates no vendor
Session binding, and does not participate in dormant-run migration drainage.
Any other future direct submit path requires an explicit activated-profile
binding or sessionless exemption before it can ship.

### `/new`, Restart, And Manual Resume

- On a dormant eligible group, `/new` checks the approved live path. If absent,
  it keeps the existing command path. If invalid, it does not claim a successful
  new Session. If valid, `/new` performs first-install migration and atomically
  commits `phase: active` together with a reset tombstone for the current real
  policy identity while clearing any matching transitional legacy pointer.
  Only then does it reset mirrors and reply. A crash after the reply therefore
  cannot make the next message resume the pre-activation Session.
- `/new` atomically removes the Sidecar active pointer, writes a reset tombstone
  for the identity, and marks the old immutable record retired. That Sidecar
  transaction is the durable reset commit point.
- Only after the reset commit succeeds does `/new` await archive/clear of the
  compatibility mirrors. It replies to the user only after mirrors are either
  durably reset or durably marked degraded for repair. A crash after the commit
  cannot revive the old Session because the tombstone suppresses mirror fallback.
- The next message after `/new` resolves the current live file and creates a new
  record when the vendor returns a new session/thread identifier.
- Editing or deleting the live Markdown does not affect the current active
  session. The change becomes observable only after `/new` or another event
  that genuinely creates a new session/thread.
- A bridge restart loads both stores and the referenced snapshot, so an active
  session keeps its original version across restart.
- Manual `/resume` must look up the selected agent session identifier in the
  Sidecar before changing the active pointer. It must never bind the current
  live file to a historical session.
- An existing `legacy-none` record whose bound identity differs from the current
  p2p identity is hidden and rejected. A pre-activation candidate with no record
  may be adopted once into the current p2p identity under the migration rule;
  after any identity has recorded that vendor session key, it cannot be adopted
  again elsewhere.
- V1 has no manual-resume entry point for `pinned` group/topic Sessions. The p2p
  history UI hides them and direct candidate application rejects them. They can
  continue only through automatic resume while still active in their original
  profile and group/topic scope; after `/new`, they remain retired history until
  retention expiry.
- A proven pre-feature `legacy-none` session may resume without a group prompt.
  The operator must use `/new` in the target group to adopt its configured
  prompt.
- The live file hash is not part of `policyFingerprint`; editing configuration
  must not silently force a new session.

## Persistence And Garbage Collection

Do not add Prompt binding fields to the existing `SessionCatalog` JSON. Its
current normalizer drops unknown fields, so an older binary would erase them on
its next persist. The separate `session-bindings.v1.json` Sidecar is the binding
and active/reset authority and has its own strict schema, health state, atomic
mode-`0600` persistence, and awaited flush contract.

Record retention is explicit:

- A record referenced by `activeByIdentity` is never retired or deleted.
- `/new` and a later active replacement atomically add `retiredAt` for the old
  record without mutating the immutable record itself.
- Retired records are retained for 90 days, matching the existing archived
  Session Catalog retention window. V1 manual resume does not revive retired
  pinned group/topic records.
- After 90 days, one atomic Sidecar commit removes eligible retired records and
  their retirement metadata. From that commit onward, corresponding vendor
  history is hidden or rejected as an unknown post-activation Session.
- In that same record-removal transaction, each pinned hash that has no other
  retained record reference is added to
  `unreferencedSnapshots[sha256] = unreferencedAt`. If a new retained record
  references the hash before deletion, the transaction atomically removes that
  unreferenced marker.
- `none` and `legacy-none` records follow the same record-retention rule even
  though they reference no snapshot.

Snapshot creation and reference commits use the same serialized Sidecar
transaction service as records, reset, migration, and GC. Normally a newly
created, not-yet-referenced hash is registered in `unreferencedSnapshots`
before agent dispatch, and the record-plus-active-pointer commit atomically
clears that marker. If the process crashes after exclusive file creation but
before marker persistence, the next healthy startup/GC pass inventories the
snapshot directory only after loading the complete authoritative ledger. A
regular, hash-valid snapshot absent from every retained record and from the GC
map is adopted into the map with `unreferencedAt = detection time`; file mtime
is not used to shorten the seven-day safety window. A `phase: migrating`
recovery performs the same inventory before the final active-phase commit.

Snapshot files are immutable and content-addressed. Snapshot GC must:

- derive reachability from every retained immutable Sidecar Session record;
- run only after healthy Sidecar/activation load and mirror reconciliation;
- retain snapshots referenced by active or retained historical records;
- remove only unreferenced regular files on a later GC pass at least seven days
  after the persisted `unreferencedAt` value;
- use no-follow reads and verify a candidate before deletion; and
- tolerate interrupted writes without deleting a referenced valid snapshot.

Deletion order is therefore record retirement, 90-day record retention, atomic
record removal plus `unreferencedAt`, seven-day continuously-unreferenced grace,
verified snapshot deletion, then removal of the GC metadata after successful
deletion. A crash at any boundary may retain extra data but must not delete a
reachable snapshot.

## Failure And Observability

On a dormant profile, an absent live file means "feature not activated" and the
existing Session path remains unchanged. On an activated profile, absence on
fresh-session creation binds `none`. A present but invalid live file fails
closed: the bridge must not create a new session that silently omits configured
instructions.

A damaged pinned snapshot also fails closed. The bridge must not substitute the
current live file because doing so would violate session version stability.

The Sidecar and activation marker expose `dormant`, `activating`, `healthy`,
`incomplete-initialization`, and `corrupt` outcomes. Malformed JSON, invalid
records, unexpected schema versions/install IDs, marker-without-Sidecar, read
errors, or loss after activation are `corrupt`. Corrupt authoritative state
blocks fresh binding, automatic resume, manual resume, and Claude legacy
fallback until an administrator repairs or deliberately resets it.

Compatibility mirrors expose `missing`, `healthy`, `stale`, and `corrupt`.
Healthy authoritative state may repair them; failed repair blocks that identity
without changing the committed Sidecar state.

Authoritative Sidecar persistence failure is a run failure, not a log-only
warning. A newly observed session/thread must not be published to any active or
legacy resume surface before the Sidecar transaction commits. Mirror failure
after that commit is a degraded repair condition. Logs distinguish config
resolution, snapshot validation, activation/Sidecar health, mirror health,
commit failure, and repair failure.

For a fresh activated run, identifier persistence failure also stops and reaps
the current process, disables startup retry, discards later output, releases
the active scope through the normal executor cleanup path, and emits only a
stable content-free IM/comment failure. The bridge must not continue streaming
content from a run it cannot safely resume.

Structured logs may record:

- profile name;
- chat scope and fresh/resume state;
- binding state;
- applied/not-applied state;
- byte count and SHA-256 for pinned content; and
- resolution/failure category.

Logs, cards, replies, errors, and telemetry must not contain the prompt body.
The user-facing error states only that the group's prompt configuration or
session snapshot is invalid and requires an administrator; local logs retain
the detailed filesystem reason.

## Alternatives Considered

### Reread The Markdown On Every Turn

Rejected. It provides immediate hot reload but allows one logical session to
observe multiple conflicting role definitions. It also makes a bridge restart
or startup retry a possible semantic boundary. `/new` is a clearer activation
contract.

### Store Prompt Content Inline In `SessionCatalog`

Rejected. The catalog is useful operational metadata and may be inspected by
status/debugging paths. Keeping prompt bodies in separate mode-`0600` snapshots
reduces accidental exposure and allows content-addressed reuse.

### Add Binding Metadata To Existing `SessionCatalog` Entries

Rejected. The catalog key represents the current scope identity rather than an
immutable vendor session identifier, so a later active session replaces the
retained entry for that identity. Older binaries also normalize away unknown
fields on persist. A versioned sidecar preserves history and makes rollback
behavior explicit.

### Add A `profiles.<name>.prompts.groups` Root-config Mapping

Deferred. It supports aliases and arbitrary paths but adds schema migration,
normalization, persistence, and configuration UI work without improving the
first use case. The deterministic profile-local convention is sufficient.

### Append Group Content To The Turn Envelope

Rejected. It would mix trusted operator configuration with user-controlled
content, repeat it as user history, and bypass Claude's existing system-prompt
transport.

### Hard-code The Current Group In Source

Rejected. It couples a deployment-specific identifier to package code, changes
upgrade behavior, and cannot scale to another profile or group.

## Rollout And Rollback

1. Ship resolver, immutable snapshots, versioned Sidecar/activation marker,
   migration, pass-through contract, adapter composition, and tests with no
   group prompt files present.
2. Verify profiles with no live file remain dormant across normal runs and
   restart: no Sidecar/marker, migration, or Session-path change occurs.
3. Add the Markdown file only under the target Codex profile and target group,
   then use `/new` so the next eligible run is fresh.
4. Before dispatching that run, initialize the Sidecar, import every Catalog and
   independently resumable Claude legacy active entry as `legacy-none`, and
   commit the activation marker. Do not accept the run if migration cannot commit.
5. Verify restart recovery, legacy adoption, Sidecar corruption, mirror repair,
   and persistence-failure behavior on the activated profile.
6. Verify a harmless prompt-specific
   behavior, origin scope, sidecar record, and snapshot hash.
7. Verify isolation in another group, another profile, p2p, and topic scopes.

Configuration rollback removes the live Markdown and uses `/new`; existing
pinned sessions intentionally retain their immutable record and snapshot until
retention expiry.

While a profile is still dormant, code rollback may remove the new binary
without a state migration. After profile activation, an older binary is not a
safe rollback target: it neither updates the authoritative ledger nor knows
which vendor history requires a Group Prompt. V1 therefore supports
configuration rollback and roll-forward code recovery, not arbitrary binary
downgrade after activation.

For an emergency code fault after profile activation, stop the bridge, retain the
Sidecar/snapshots, and deploy a Sidecar-aware fix. Do not start an old binary
against the same profile. Supporting downgrade would require a separately
designed quarantine of every pinned Claude transcript and Codex thread history;
that capability is outside V1 and must not be implied by operational prose.

## Acceptance Criteria

- A fresh target-group session under the configured target profile receives
  the configured group instructions.
- The same profile in another group does not receive them.
- Another profile in the same group does not receive them unless that profile
  has its own file.
- On an activated profile, a fresh p2p Session binds `none`; dormant p2p stays
  on the existing Session path without creating Prompt state.
- A profile with no activation marker/Sidecar and no valid live Prompt remains
  dormant: no migration runs, no Prompt state files are created, and its
  pre-feature Session behavior/failure surface remains unchanged.
- A valid live Prompt activates the profile either through activation-aware
  `/new` beside an active legacy Session or before dispatch of an already-fresh
  eligible group run. The `/new` path commits migration plus reset tombstone
  before reply, so a crash cannot revive the legacy Session.
- Each topic uses the parent group's live source but pins independently at
  topic-session creation.
- Editing or deleting the live file does not change an active session.
- After `/new`, the next message uses the latest valid file or binds `none` if
  the file is absent.
- Restarting the bridge does not change the group prompt version of an active
  session.
- Startup retry for one turn uses the same resolved binding.
- First-install migration records currently active sessions as `legacy-none`
  before accepting runs.
- Activation pauses new admission and drains every already-admitted dormant IM
  and comment run to either a durably mirrored identifier or identifier-free
  termination before migration enumeration. Timeout aborts activation without
  stopping unrelated runs or creating authoritative Prompt state.
- First-install imports complete Claude legacy entries even when no matching
  active Catalog entry exists. Entries without policy fingerprint use a
  policy-agnostic scope/agent/cwd transitional pointer and promote only under a
  real current policy identity; conflicts fail migration/promotion.
- Activation marker and Sidecar loss/mismatch cases are distinguishable and
  tested. Interrupted initialization re-enumerates all current migration sources
  and rebuilds/supplements the complete Sidecar before marker commit.
- A history candidate older than activation can be lazily recorded as
  one-time `adopted-legacy` under the current p2p identity; a candidate already
  recorded under another identity and any unknown candidate at or after
  activation are rejected.
- A pinned group/topic session is hidden from or rejected by p2p manual resume
  and has no V1 manual-resume path. While active it automatically resumes only
  in its original profile and scope.
- On an activated profile, comment Sessions bind explicit `none`, use
  comment-origin records, participate in migration/commit/resume/repair, and
  never receive Group Prompt content. Dormant comment behavior is unchanged.
- Missing live configuration preserves current behavior.
- Final-file symlink, parent symlink/reparse point, traversal, invalid UTF-8,
  non-regular, changed-during-read, empty, and oversized live files reject
  fresh-session creation without leaking content.
- Secure-open tests prove validation and bounded reading use the same file
  descriptor rather than a check-then-read path.
- Snapshot exclusive-create races converge on one valid file; an existing
  symlink, non-regular file, wrong-sized file, or hash-mismatched snapshot fails
  closed.
- Missing or hash-mismatched pinned snapshots reject resume without falling
  back to the live file.
- `phase: active` with missing marker is corrupt; only `phase: migrating` may
  complete interrupted initialization, and no run is accepted before the final
  active-phase commit.
- Malformed Sidecar/marker state, invalid binding schema, and missing
  post-activation records fail closed. Corrupt compatibility mirrors are
  repaired from the Sidecar or block the affected identity; they cannot
  silently enter Claude legacy fallback.
- Claude SessionStore repair preserves `idleTimeoutMinutes` when the store is
  parseable. Whole-store corruption that makes the preference unknowable blocks
  automatic repair until administrator repair or explicit preference reset.
- A new session becomes resumable at the atomic Sidecar record-plus-active
  pointer commit. Compatibility mirrors update afterward and failed repair
  blocks further runs without losing the authoritative commit.
- Fresh activated runs do not deliver substantive output before identifier
  persistence succeeds. Commit failure stops/reaps the run, disables retry,
  discards later output, releases the scope, and emits a redacted IM/comment
  failure.
- Concurrent transactions from different scopes cannot lose updates: record
  versus record, `/new` versus identifier commit, legacy promotion versus
  reset, and GC versus re-reference are serialized under one profile queue and
  monotonically increasing `ledgerRevision`. Stale-revision writes fail closed.
- Connect-before-disconnect reconnect reuses one profile-scoped Prompt Session
  service, transaction queue, admission controller, and dormant-run registry
  created inside the outer runtime-lock lifetime; overlapping channels cannot
  create competing ledgers or bypass an activation pause.
- `/new` atomically writes an authoritative reset tombstone and retirement
  metadata before awaiting mirror reset; a crash cannot revive the old Session.
- Active records are never retired; retired records remain 90 days; snapshots
  remain continuously unreferenced for at least seven more days after persisted
  `unreferencedAt`. Re-reference clears that marker atomically; successful
  snapshot deletion clears the GC metadata. Vendor history whose
  post-activation record expired is hidden or rejected.
- A snapshot created before an agent identifier is returned has a persisted GC
  start. A hash referenced within seven days atomically loses that marker; an
  orphan still unreferenced after seven days is deleted. Crash-gap snapshots
  first detected during a complete healthy-ledger inventory receive a fresh
  seven-day window from detection.
- Claude receives the composed layer through its existing appended
  system-prompt file; Codex receives it through its existing developer
  instructions. It never appears inside `user_input`.
- With no bound group prompt, both adapters receive the same bridge instruction
  string as before the feature.
- Logs expose binding state and content hash but never the prompt body.
- Sidecar migration/persistence, activation marker, mirror repair, `/new`,
  manual-resume rejection, retention/GC, roll-forward recovery, unit/integration
  tests, build, and typecheck pass.

## Approved Configuration Decision

The first version uses the convention-based live configuration contract:

```text
<profileDir>/prompts/groups/<chatId>.md
```

This convention is profile-local, deterministic, and does not add a root-config
schema migration. A root-config mapping remains a deferred alternative for a
future version that needs aliases, arbitrary sources, or management UI.
