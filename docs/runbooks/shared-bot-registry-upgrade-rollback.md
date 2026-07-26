# Shared Bot Registry Coordinated Upgrade And Rollback

This runbook applies when an installation first enables the installation-level
shared Bot Registry. It is an installation-level atomic migration. It is not a
rolling upgrade.

The compatibility boundary is important: `schemaVersion: 2` means that the new
bridge can read an older Root Config. It does not mean that an old process can
safely save a Root Config containing `botRegistry`. An old writer normalizes
unknown fields away.

## Hard gates

- One `LARK_CHANNEL_HOME` must never have old and new writers running together.
- Do not add, self-register, restore, or otherwise modify `botRegistry` while
  any old writer is alive or any enabled service definition can relaunch one.
- Inventory every foreground process and every profile service before changing
  the package or config. Record profile, PID, process-registry version, service
  definition, resolved artifact path, artifact version, and artifact hash.
- Stop and disable every old writer, then independently verify both PID exit
  and artifact/service-definition state. A successful stop command alone is
  not sufficient evidence.
- Back up both `config.json` and `active-profile` with owner-only permissions.
  Never print Root Config contents or secrets into the maintenance log.
- If inventory is incomplete, a PID cannot be proved dead, an artifact cannot
  be identified, a backup cannot be verified, or config readback fails, abort.

Run this procedure from an external maintenance shell. Do not ask a profile to
restart or stop itself while it is serving the current conversation.

## Variables and protected evidence directory

Set explicit paths for the installation being migrated:

```bash
export BRIDGE_ROOT='/absolute/path/to/lark-channel-state'
export OLD_BRIDGE='/absolute/path/to/old/lark-channel-bridge'
export NEW_BRIDGE='/absolute/path/to/new/lark-channel-bridge'
export MIGRATION_EVIDENCE='/absolute/protected/path/bridge-migration-YYYYMMDD-HHMMSS'

umask 077
mkdir -p "$MIGRATION_EVIDENCE"
chmod 700 "$MIGRATION_EVIDENCE"
```

Do not use an unresolved variable, home-directory shorthand, or a broad
directory as a copy/remove target. Confirm each absolute path before
continuing. All bridge CLI reads in this runbook must be pinned to the intended
installation:

```bash
export LARK_CHANNEL_HOME="$BRIDGE_ROOT"
```

## 1. Inventory every writer and artifact

Capture configured profiles and the process registry:

```bash
"$OLD_BRIDGE" profile list | tee "$MIGRATION_EVIDENCE/profiles.before.txt"
"$OLD_BRIDGE" ps | tee "$MIGRATION_EVIDENCE/processes.before.txt"
```

For every profile returned by `profile list`, capture:

```bash
"$OLD_BRIDGE" status --profile '<profile>'
```

Record the service definition and resolve its bridge entry path:

| Platform | Service identity / artifact evidence |
| --- | --- |
| macOS | `~/Library/LaunchAgents/ai.lark-channel-bridge.bot.<profile>.plist`; record `ProgramArguments`, then run the resolved bridge entry with `--version` and hash the entry |
| Linux | `~/.config/systemd/user/lark-channel-bridge.bot.<profile>.service` (or the configured XDG path); record `ExecStart`, then run the resolved bridge entry with `--version` and hash it |
| Windows | Task `LarkChannelBridge.Bot.<profile>` plus `$BRIDGE_ROOT/daemon/<profile>/launcher.cmd`; record the launcher command, version, and file hash |

The process-registry version is useful but not authoritative by itself. Two
artifacts can report the same package version while containing different
serializer code. The resolved artifact path and hash are mandatory evidence.

Reconcile the three views:

1. every live `ps` entry has a PID, profile, version, and config path under
   `BRIDGE_ROOT`;
2. every running service has a matching live PID;
3. every service definition resolves to an identified old artifact;
4. any foreground writer not owned by a service is still included in the stop
   list.

Do not continue if any writer or service definition is unaccounted for.

## 2. Stop and disable all old writers

Stop every profile service explicitly:

```bash
"$OLD_BRIDGE" stop --profile '<profile>'
```

For each remaining foreground entry from `ps`, stop it by its exact bridge ID:

```bash
"$OLD_BRIDGE" kill '<bridge-process-id>'
```

Then repeat the full inventory. The gate opens only when all of the following
are true:

- `"$OLD_BRIDGE" ps` reports no writer for `BRIDGE_ROOT`;
- every `status --profile` reports stopped;
- every recorded old PID is absent from the OS process table;
- autostart is disabled, so login or service-manager recovery cannot relaunch
  an old artifact;
- no service definition points at an unidentified artifact.

If a stale process-registry entry disagrees with the OS PID check or a lock is
uncertain, treat the writer as live and abort. Do not start the new version to
"see what happens."

## 3. Back up the old-compatible state

Only after the stop-all gate is proven:

```bash
umask 077
mkdir -p "$MIGRATION_EVIDENCE/pre-upgrade"
chmod 700 "$MIGRATION_EVIDENCE/pre-upgrade"
cp "$BRIDGE_ROOT/config.json" "$MIGRATION_EVIDENCE/pre-upgrade/config.json"
cp "$BRIDGE_ROOT/active-profile" "$MIGRATION_EVIDENCE/pre-upgrade/active-profile"
chmod 600 \
  "$MIGRATION_EVIDENCE/pre-upgrade/config.json" \
  "$MIGRATION_EVIDENCE/pre-upgrade/active-profile"
```

Record hashes and verify both files are mode `0600` (owner-only ACL on
Windows). Keep the backup outside directories modified by the package upgrade.
Do not copy its contents into logs or source control.

## 4. Upgrade the artifact and every service definition

Install the approved new artifact using the installation's normal package or
deployment mechanism. Do not start a profile yet.

For installations using a stable global bridge entry path, verify that every
stopped service definition resolves through that path to the new artifact. For
versioned release directories, atomically repoint every stopped service
definition to the new absolute entry path using the deployment mechanism.

Record for every profile:

- resolved new artifact path;
- `--version` output;
- artifact hash;
- stopped/disabled service state.

If the deployment mechanism cannot update or verify a definition without
re-enabling an old artifact, abort and restore the pre-upgrade artifact. Never
leave a mixture of old and new service definitions enabled.

Repeat the PID check immediately before the first Registry-capable writer
starts. No recorded old PID may exist, and no enabled definition may resolve
to an old artifact.

## 5. Start one new profile and complete Registry setup

Start exactly one selected new profile:

```bash
"$NEW_BRIDGE" start --profile '<first-profile>'
"$NEW_BRIDGE" status --profile '<first-profile>'
"$NEW_BRIDGE" ps
"$NEW_BRIDGE" bot-registry list
```

Wait for the successful connection evidence produced by `start`. Confirm that
the process PID, version, resolved artifact, and hash are all new. The selected
profile's observed Bot identity must appear exactly once in the shared
Registry.

Add non-local or not-yet-started Bots explicitly. Use real approved values only
in the protected maintenance shell, never in this runbook or its committed
evidence:

```bash
"$NEW_BRIDGE" bot-registry add \
  --name '<canonical-bot-name>' \
  --app-id '<approved-app-id>' \
  --alias '<optional-exact-alias>'
```

Read back and verify:

```bash
"$NEW_BRIDGE" bot-registry list
```

Confirm that canonical names, aliases, and App IDs match the approved inventory
exactly, `active-profile` is unchanged, `config.json` remains mode `0600`, and
no profile-local copy of the Registry exists. Only after this readback may the
remaining profiles be started with the new bridge.

## 6. Post-upgrade acceptance

For every started profile, capture `status` and `ps` again. The final evidence
must show:

- no old PID is alive;
- no enabled service definition resolves to an old artifact;
- all live entries report the intended new artifact version and hash;
- the selected profile self-registered;
- explicitly added entries survived Root Config readback;
- a second readback after a stability window is identical.

Run the repository-controlled process acceptance when validating a source
checkout:

```bash
pnpm verify:migration
```

That command is a no-network, no-service-manager harness. It creates only
temporary state and controlled child writers. Its evidence boundary is
historical serializer source plus current serializer source; it does not claim
to test a previously published binary.

## Rollback

Rollback is also stop-all, not rolling.

### 1. Stop every new writer

Inventory all new services and foreground processes with the same PID,
artifact, version, and hash procedure. Stop and disable every new profile
service, stop remaining foreground entries, and prove every recorded new PID
has exited.

### 2. Back up the Registry-capable state

Create a separate protected backup after all new writers stop:

```bash
umask 077
mkdir -p "$MIGRATION_EVIDENCE/pre-rollback"
chmod 700 "$MIGRATION_EVIDENCE/pre-rollback"
cp "$BRIDGE_ROOT/config.json" "$MIGRATION_EVIDENCE/pre-rollback/config.json"
cp "$BRIDGE_ROOT/active-profile" "$MIGRATION_EVIDENCE/pre-rollback/active-profile"
chmod 600 \
  "$MIGRATION_EVIDENCE/pre-rollback/config.json" \
  "$MIGRATION_EVIDENCE/pre-rollback/active-profile"
```

Verify both hashes and permissions. This backup is now the only authoritative
Registry-bearing rollback evidence.

### 3. Restore the old artifact and old-compatible config

Restore the approved old artifact and ensure every enabled service definition
resolves to it. Restore `pre-upgrade/config.json` and
`pre-upgrade/active-profile`, not the Registry-bearing `pre-rollback` copy.
Apply mode `0600` and verify hashes before starting any old profile.

The active old config intentionally has no usable shared Registry. During the
rollback period, Registry data exists only in the protected `pre-rollback`
backup. Do not copy `botRegistry` into the old config: an old save will discard
it.

Start old profiles only after artifact and config compatibility are verified.

## Re-upgrade after rollback

1. inventory, stop, and disable every old writer again;
2. prove every old PID is absent and no old artifact can autostart;
3. back up the current old-compatible Root Config and `active-profile`;
4. install and verify the new artifact and all service definitions;
5. restore the protected `pre-rollback/config.json` and `active-profile`;
6. apply mode `0600`, then use the new CLI to run `bot-registry list` before
   starting a profile;
7. start one new profile, verify its PID/artifact/version/hash, and read back
   the Registry again.

If the restored Registry fails validation, stop. Do not normalize it to empty,
do not start an old writer, and do not overwrite the protected backup.

## Evidence and failure boundary

Keep these artifacts in the protected evidence directory:

- before/after profile and process inventories;
- service-definition snapshots;
- PID exit checks;
- old/new artifact paths, versions, and hashes;
- hashes and permission checks for each backup;
- Registry entry counts and validation result, without secrets;
- the exact failed step when the gate aborts.

A successful package install is not proof of a successful migration. Completion
requires stopped-old-writer proof, new-writer connection and self-registration,
explicit-entry readback, and post-write stability evidence.
