# Unit 9 Mixed-Version Migration Acceptance

Date: 2026-07-26

Scope: DD10 only. This evidence does not cover final code review, live Lark
acceptance, publication, or remote-history remediation.

## Evidence boundary

The controlled old artifact was built at runtime from the actual pre-Registry
serializer source at rewritten commit `fd872acea804be938a87e0a16089cb7084dfb97d`.
The new artifact was built from the
current serializer source at baseline
`525dd27532b25dc1d3b74021b18fc748b6c3d58b`.

This is historical-source compatibility evidence, not proof from a previously
published old npm binary. Both sources declare the same package version, so the
acceptance records source ref and artifact hash in addition to version. It does
not infer writer generation from version text alone.

| Generation | Source ref | Declared version | Controlled artifact SHA-256 |
| --- | --- | --- | --- |
| Old | `fd872acea804be938a87e0a16089cb7084dfb97d` | `0.5.9-qp.5` | `8e81d9a9c212dfb6401c0ee97fcb1025dc6afb1aebe93a3f6389c6205719040e` |
| New | `525dd27532b25dc1d3b74021b18fc748b6c3d58b` | `0.5.9-qp.5` | `850988ee2f995fd4189a92a9e5d4b32d01b9031c1c7369a2abf9eaba1ea88019` |

## Isolation

`tools/mixed-version-migration-acceptance.mjs` creates one `mkdtemp` root and
keeps all generated sources, artifacts, Root Configs, active-profile markers,
backups, and child working directories below it.

Before each child spawn, the runner removes every inherited
`LARK_CHANNEL_*` variable and `LARKSUITE_CLI_CONFIG_DIR`, then supplies only
isolated fixture paths and a non-live channel marker. It asserts those paths
remain inside the temporary root.

The run used only fictional profiles, Bot names, App IDs, and secret text. It
made:

- 0 service-manager calls;
- 0 global package mutations;
- 0 user-config reads;
- 0 real bridge restart/stop/kill actions.

All seven child writers exited normally, and the temporary root was removed.

## Controlled child-process evidence

The successful run captured PID, generation, source ref, declared version,
artifact basename, and full artifact hash for every child:

| Path / phase | Generation | PID | Result |
| --- | --- | ---: | --- |
| New install | New | 52067 | Empty Registry created; self entry then explicit other entry persisted |
| Upgrade inventory | Old | 52068 | Upgrade write gate rejected while PID was alive; PID exited before new write |
| Upgrade hazard probe | Old | 52069 | Actual historical load/save dropped the unknown Registry field |
| Upgrade write | New | 52070 | Two entries persisted and remained stable after the old PIDs exited |
| Pre-rollback | New | 52073 | New writer stopped before rollback backup and old artifact restore |
| Rollback | Old | 52074 | Old-compatible save dropped Registry; Registry remained in protected backup |
| Re-upgrade | New | 52075 | Re-upgrade was blocked until old PID exit; restored backup rebuilt two entries |

The exact PID values are run-specific. Their purpose is to prove that the gate
tracked concrete child processes and confirmed exit, rather than treating an
artifact label or a successful stop request as process-liveness evidence.

## Three-path result

### New install

- initial shared Registry was empty;
- exactly one new writer started;
- the fictional local profile self entry was written and read back;
- a fictional non-local entry was added explicitly;
- final readback contained two entries.

### Upgrade

- a live old PID caused the upgrade write boundary to reject;
- the historical serializer's real load/save behavior dropped an injected
  Registry in a separate isolated hazard copy;
- all old child writers stopped and their PIDs were absent before backup or new
  writes;
- Root Config and active-profile backup modes were `0600/0600`;
- one new writer wrote the self entry, then the explicit other entry;
- a delayed second readback still contained both entries, proving no old child
  remained to overwrite the file.

### Rollback and re-upgrade

- all new writers stopped before the rollback backup;
- Root Config and active-profile rollback backup modes were `0600/0600`;
- the restored historical serializer produced an old-compatible active config
  without Registry while the backup retained both entries;
- re-upgrade rejected while the rollback old PID remained alive;
- after old PID exit, the protected Root Config and active-profile backup were
  restored;
- one new writer saved and read back both restored entries.

## Runner corrections

The first artifact build failed safely before any child started:

1. the CJS build rejected top-level await;
2. the extracted historical source could not resolve its package dependencies
   from the temporary directory.

The writer entry was wrapped in an async main, and the existing repository
dependency directory was supplied only as the build resolver root. Generated
source, compiled artifacts, configs, and writes remained inside `mkdtemp`.
The corrected run and its integration test passed.

## Verification

| Gate | Result |
| --- | --- |
| Controlled runner | Passed |
| Targeted integration test | 1 passed |
| `git diff --check` | Passed |
| Typecheck | Passed |
| `pnpm ci:local` | 143 files; 1478 passed, 33 skipped; typecheck and build passed |
| Unit 7 tracked tree / dist / actual tgz | Complete denylist: 0 findings on all three surfaces |
| Same scanned tgz clean install | Passed, including CLI and bundled dependency verification |
