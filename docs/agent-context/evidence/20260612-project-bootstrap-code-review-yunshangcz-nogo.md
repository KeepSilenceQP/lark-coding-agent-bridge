# 云上C总 Code Review

task_id: project-bootstrap-phase2-code-review-unblocked
phase: code_review
source_message_id: om_x100b6d894f8f9ca8c43aa2d93db2dcc
result: NO-GO

## Scope Reviewed

云上C总 pulled `feat/project-bootstrap-phase2` and reviewed `2b01f88..6e7d1ba`, including
`77ffc94` implementation changes.

## Positive Finding

`src/project/bot-registry.ts` pure planning layer is strong:

- slug allowlist;
- NFC exact matching;
- canonical names and aliases;
- ambiguous / identity_changed data shape;
- unit tests.

The failing area is command/dispatch integration.

## B1 Live Discovery Fails

`handleProjectBootstrap` calls:

```ts
rc?.im?.v1?.chat?.members?.(...)
```

Reviewer says the SDK resource name is wrong; existing code uses raw client shapes such as
`rawClient.im.v1.message.get`, and members should not be accessed this way. Also, the target is
bot list discovery (`chat.members bots` semantics), not ordinary human members.

Current implementation swallows errors and turns discovery failure into all bots
`blocked(bot_not_in_group)`, which lies about the failure.

Required:

- Add typed live-discovery seam.
- Use correct SDK/CLI-backed bot discovery.
- On discovery failure, report `blocked(discovery_failed)`.
- Add handler-level integration tests.

## B2 Dispatched `/cd` Command Is Invalid

Dispatch sends:

```text
/cd <path> (taskId)
```

`handleCd` treats the entire args string as a path, so the receiving bot will try to resolve
`<path> (taskId)` and fail.

Required:

- Do not append task id to `/cd` command line.
- Put task id in a separate message or metadata.
- Add cross-command parse test.

## B3 Send Shape / Silent Failure / False Receipt

Dispatch uses:

```ts
channel.send(chatId, { post: ... })
```

Reviewer found no existing `{ post }` usage in the repo, and send failures are swallowed with
`.catch(() => {})`. The receipt marks status `sent` before send succeeds, so
`dispatch_failed` is defined but unreachable.

Required:

- Verify or use a supported send shape.
- Set `sent` only after successful send.
- On send failure, mark `blocked(dispatch_failed)`.

## B4 M1/M2 Lifecycle Missing

Handler passes `pinned: new Map()` each time, so pin-on-first-verify is never persistent and
`identity_changed` is unreachable in production. There is no receipt parsing / acknowledged /
verified state progression.

Required decision:

- Implement minimal receipt ingestion: parse target bot structured @ 小P receipt, match task id,
  advance state, and persist pin; or
- explicitly re-scope Phase 2 to sent/blocked only.

Coordinator default: implement minimal receipt ingestion unless Qin Peng chooses to re-scope.

## B5 Trigger Permission Mismatch

`/project` is in `BOT_ADMIN_COMMANDS`, so `/project bootstrap` is currently botAdmin-callable.
PRD says bootstrap trigger is human-admin only.

Required:

- Inside `handleProjectBootstrap`, require `canRunAdminCommand`.
- Preserve existing `/project start` gate if desired.

## Non-Blocking Notes

- Registry override is read via cast but schema does not declare it; confirm config normalization.
- Alias duplicate handling may misclassify some ambiguity.
- Registry contains 小P itself, so self-dispatch risk exists; exclude coordinator/self.
- `bridge-system-prompt` additions are good.

## Required New Tests

- Handler integration for live discovery with mocked seam.
- Dispatched `/cd` text parses successfully by receiver.
- Send failure -> `blocked(dispatch_failed)`.
- Bootstrap trigger permission: botAdmin rejected, human admin allowed.
