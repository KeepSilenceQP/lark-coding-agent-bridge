# 小P Local Implementation Review

task_id: project-bootstrap-phase2-implementation-xiaoc
phase: implementation_review
result: CHANGES_REQUESTED

## Verification

Commands run locally:

```bash
npm test -- --run tests/unit/project/bot-registry.test.ts tests/unit/project/dispatch.test.ts
npm test -- --run tests/integration/commands/commands-v1.test.ts
```

Results:

- project unit tests: 22/22 passed
- commands integration tests: 30/30 passed

Passing tests are not sufficient. Manual review found blocking behavioral gaps.

## Blocking Findings

### B1. `/project bootstrap` does not dispatch anything

`handleProjectBootstrap` calls `planBootstrap`, renders a receipt, and logs. It does not send:

- bridge bot `/cd <path>`;
- bridge bot `/invite group`;
- non-bridge workspace context packet.

This makes the receipt misleading: statuses are `sent` even though no outbound command/context
was sent. Phase 2 requires bootstrap execution, not only planning.

### B2. Pin-on-first-verify is implemented as pin-on-plan/sent

`handleProjectBootstrap` pins every non-blocked result immediately after rendering the receipt:

```ts
if (result.status !== 'blocked') {
  const live = liveMembers.find((m) => m.name === result.botName);
  if (live) pinBinding(...)
}
```

This violates M1. Pinning must happen only after a structured verified receipt from the target
bot, not after planning or local receipt rendering.

### B3. Live duplicate-name ambiguity is not detected

`planBootstrap` builds:

```ts
const liveMap = new Map<string, LiveBotMember>();
for (const m of input.liveMembers) liveMap.set(m.name.normalize('NFC'), m);
```

Duplicate live names overwrite each other before ambiguity can be detected. The M1 requirement
is: same-name zero or more-than-one matches must hard-fail as `blocked(ambiguous_name)`.

### B4. Coordinator identity in non-bridge packet is wrong for human-triggered commands

`handleProjectBootstrap` passes:

```ts
coordinatorOpenId: ctx.msg.senderId
```

If Qin Peng triggers `@小P /project bootstrap ...`, `ctx.msg.senderId` is the human sender, not
小P's bot identity. Non-bridge packets would contain the wrong coordinator id.

### B5. Devbox workspace alias mismatch remains unresolved

Default registry uses:

```text
/home/qinpeng.bobo/repo/lark-channel-bridge-fork
```

云上小C reported the actual devbox repo is:

```text
/home/qinpeng.bobo/repo/lark-coding-agent-bridge
```

The implementation needs an alias/config surface or a corrected default before devbox targets
can receive useful `/cd` paths.

## Required Fixes Before Code Review

1. Either implement actual dispatch in `/project bootstrap`, or rename/status the feature as a
   dry-run planner. Current `sent` wording is not acceptable.
2. Move pinning to structured verified receipt handling; do not pin on plan or send.
3. Preserve duplicate live matches and return `blocked(ambiguous_name)`.
4. Use the receiving bot identity for coordinator fields, not human sender id.
5. Fix or configure devbox workspace aliases.
6. Add tests that fail on B1-B4.
