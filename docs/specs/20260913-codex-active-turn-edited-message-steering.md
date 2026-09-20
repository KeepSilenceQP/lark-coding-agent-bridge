# Codex Edited-Message Correct-and-Restart Spec

Date: 2026-09-13
Revised: 2026-09-14
Status: Confirmed by Decision Owner
Scope: `lark-channel-bridge`, Codex only

## 1. Decision

When a user notices ASR errors in the single Feishu message that started the
currently active Codex run, they may edit that message and add the `[喇叭]`
Reaction. The bridge fetches the latest message, stops the active Codex run,
waits for it to exit, and directly starts a new turn in the same Codex session
using the corrected full text.

The verified Feishu Reaction type is:

```text
UI label: [喇叭]
emojiType: Loudspeaker
```

This replaces the earlier App Server `turn/steer` design. The implementation
continues to use the existing `codex exec` transport and therefore does not
depend on Codex App Server or its configuration-isolation limitations.

## 2. User Problem

Long speech-to-text messages may contain ASR mistakes that are only noticed
after Codex has started working. Sending a short correction lets Codex see the
new information, but it may continue from reasoning already based on the wrong
text.

The desired lightweight behavior is equivalent to interrupting an active CLI
run and immediately entering the corrected full instruction again.

## 3. Guarantees and Limits

The feature guarantees that, after the correction is accepted, the old run no
longer continues and a new Codex turn receives the latest edited full text.

It does not guarantee transactional rollback:

- the erroneous user message remains in the Codex session history;
- commands, file edits, messages, or other side effects completed before the
  stop may remain;
- the replacement turn runs against the workspace state left by the stopped
  turn;
- the bridge must not claim that earlier effects were reversed.

The corrected input explicitly states that it supersedes the earlier ASR
version. Restarting the turn clears the old in-flight reasoning/tool loop, but
does not erase history or external effects.

## 4. First-Version Scope

Supported:

- Codex profiles using the existing exec transport;
- one currently active run in the same chat/topic scope;
- a run triggered by exactly one accepted human Feishu message;
- `text` and `post` messages without attachments;
- Reaction `added` with exact `emojiType=Loudspeaker`;
- the Reaction operator is the original message author.

Not supported in the first version:

- Claude;
- completed, stopped, timed-out, or historical runs;
- merged/batched runs containing more than one accepted inbound message;
- messages with images, files, cards, merge-forward content, or other
  attachments;
- editing without the explicit `[喇叭]` Reaction;
- polling Feishu for changes;
- automatic rollback of earlier side effects;
- starting a fresh Codex thread that discards all prior session context;
- persistence of edit eligibility across Bridge restart.

Unsupported cases fail visibly for the authorized original author and do not
stop or replace the current run.

## 5. Eligibility

Before stopping anything, the bridge must verify all of the following:

1. The event is an `added` Reaction with exact type `Loudspeaker`.
2. The target is a human message previously accepted by this Bridge process.
3. The target is the sole inbound message that triggered the current active
   Codex run for the exact scope.
4. The Reaction operator equals the target message author.
5. The current active-run handle is the same run registered for that message.
6. Current DM/group access still permits the operator.
7. The latest target can be fetched exactly once from the expected chat/topic.
8. Its type is supported and its normalized text differs from the last
   delivered revision.

The Reaction itself does not need a new `@bot` mention. It continues the
authorization of an already accepted message; it cannot activate a previously
ignored message.

## 6. Runtime Flow

```text
Reaction added: Loudspeaker
        |
        v
resolve registered target + active run
        |
        v
fetch latest message once
        |
        v
validate author / scope / type / changed revision
        |
        v
reserve direct replacement for this scope
        |
        v
revalidate exact active-run ownership
        |
        v
stop active run and wait for confirmed exit
        |
        v
start corrected turn directly in the same Codex session
        |
        v
release replacement reservation; resume ordinary queue handling
```

The direct-replacement reservation is control-plane state, not a pending user
message. It exists only to prevent the ordinary pending queue from taking the
scope between the old run exiting and the corrected run starting.

If ordinary messages were already pending, the corrected turn starts first;
existing pending messages retain their relative order afterward.

## 7. Corrected Input Contract

The replacement turn receives a normal Bridge user prompt containing:

- current chat/topic/sender context;
- the latest normalized full body of the edited message;
- original Feishu message ID and latest revision metadata;
- an explicit statement that this full text supersedes the earlier ASR version;
- a warning that already-completed effects may remain and should be checked
  before continuing when the stopped run had started any tool.

Conceptually:

```xml
<bridge_context source="message_edit_restart" ... />

<corrected_message message_id="om_xxx" revision="...">
  This is the corrected full version of the earlier ASR message and supersedes
  that version. Re-evaluate the task from this text. Previously completed side
  effects, if any, have not been rolled back.

  修改后的最新正文
</corrected_message>
```

The concrete serializer must reuse existing prompt escaping and developer/user
role separation. Raw Feishu content cannot break the metadata boundary.

## 8. Ordering and Idempotency

The logical correction key is the target `message_id` plus its normalized
latest revision/fingerprint.

- Duplicate delivery of the same Reaction/revision causes at most one restart.
- Removing and re-adding `[喇叭]` without another edit does not restart again.
- A no-change result does not stop the active run.
- Only one correction transaction may own a scope at a time.
- After stop begins, duplicate triggers join or observe the same result; they
  do not start another replacement.
- The corrected message never enters `PendingQueue` or its barrier queue.

## 9. Race and Failure Behavior

- If the active run completes before the final ownership check, do not restart;
  tell the user the correction window has closed.
- If stopping the active run fails or its exit cannot be confirmed, do not
  start a concurrent corrected run.
- If the old run exits but the corrected run fails to start, release the
  reservation, report the failure, and do not silently enqueue it.
- If a different run now owns the scope, never stop or replace it.
- If message fetch, parsing, authorization, type, or revision validation fails,
  leave the active run unchanged.
- Removing `[喇叭]` never cancels or rolls back an accepted correction.

## 10. User Feedback

On success, acknowledge only that the old run was stopped and the corrected
full message was started. If the old run had started a tool, add a clear warning
that earlier side effects may remain.

Failures must distinguish at least:

- no actual edit detected;
- original run already ended;
- message is not the sole trigger of the current run;
- unsupported message type or attachment;
- latest message could not be read;
- stop was not confirmed;
- corrected run failed to start.

Access denial, another user's Reaction, and unregistered targets should remain
silent when replying would disclose eligibility or authorization state.

## 11. Security and Privacy

- Existing access policy remains authoritative.
- Only the original author may correct their own accepted message.
- Exact message-to-active-run ownership must be checked before fetch and again
  before stop.
- Edited content is untrusted input and uses existing normalization/escaping.
- Logs may contain bounded outcome/reason codes and redacted identifiers, but
  not full message bodies or prompts by default.
- No authentication, profile, sandbox, approval, or Codex configuration change
  is required by this feature.

## 12. Acceptance Criteria

- A supported edited message plus `[喇叭]` performs one latest-message fetch.
- The exact registered active Codex run is stopped and its exit is confirmed.
- The corrected full text starts as a new turn in the same Codex session.
- The correction does not create a pending-queue entry.
- Existing pending messages cannot run between the stopped and corrected turns.
- The replacement prompt clearly supersedes the earlier ASR text.
- Duplicate/no-change Reactions cause no additional stop or turn.
- A completion race does not restart or target a newer run.
- Another user or unregistered/unsupported message cannot stop a run.
- User feedback warns about possible prior side effects when any tool started.
- Ordinary messages, existing queue ordering, stop control, Claude behavior,
  and Codex exec isolation remain unchanged outside this flow.

Required tests cover eligibility, exact Reaction mapping, single fetch,
revision deduplication, stop/exit/start ordering, replacement reservation,
completion and startup races, pending-queue exclusion, prompt escaping, tool
side-effect warning, and Codex/Claude regressions.

## 13. Rollout and Rollback

Ship behind a Codex-only feature flag that defaults off. Enable on one Bridge
profile after automated tests and a live canary.

The live canary must demonstrate:

1. an active long-text Codex run;
2. edit followed by `[喇叭]`;
3. old run exit before corrected turn start;
4. corrected full input in the same session;
5. no ordinary pending entry;
6. duplicate/no-change and completion-race behavior;
7. visible side-effect warning after a tool has started.

Rollback disables the feature flag. The existing Codex exec transport and
ordinary queue remain the unchanged fallback behavior; no App Server migration
or profile conversion is involved.

## 14. Superseded Design

The previously proposed long-lived Codex App Server and `turn/steer` migration
is no longer part of this requirement. Its Gate 1 investigation remains useful
historical evidence but is not an implementation dependency for this revised
Spec. The existing Implementation Plan must be rewritten and independently
reviewed before implementation begins.
