import { describe, expect, it } from 'vitest';
import { runMixedVersionMigrationAcceptance } from '../../../tools/mixed-version-migration-acceptance.mjs';

describe('mixed-version installation migration acceptance', () => {
  it('proves new install, coordinated upgrade, and rollback-to-re-upgrade in isolated child processes', async () => {
    const evidence = await runMixedVersionMigrationAcceptance();

    expect(evidence.evidenceBoundary).toMatchObject({
      oldArtifact: 'historical-source-build',
      historicalSourceRef: 'f666689',
      publishedOldBinaryTested: false,
    });
    expect(evidence.isolation).toEqual({
      temporaryRootOnly: true,
      inheritedBridgeEnvironmentCleared: true,
      serviceManagerCalls: 0,
      globalPackageMutations: 0,
      userConfigReads: 0,
    });

    expect(evidence.paths.newInstall).toEqual({
      emptyRegistryCreated: true,
      singleNewWriterStarted: true,
      selfRegistrationPersisted: true,
      explicitOtherEntryPersisted: true,
      readbackEntryCount: 2,
    });
    expect(evidence.paths.upgrade).toMatchObject({
      gateBlockedBeforeOldStop: true,
      historicalSaveDroppedRegistry: true,
      allOldWritersStoppedBeforeUpgradeWrite: true,
      oldPidConfirmedExited: true,
      newWriterReadbackEntryCount: 2,
      noOldOverwriteAfterUpgrade: true,
    });
    expect(evidence.paths.rollbackReupgrade).toMatchObject({
      allNewWritersStoppedBeforeRollback: true,
      oldCompatibleConfigDroppedRegistry: true,
      registryRemainedInBackup: true,
      reupgradeBlockedUntilOldStop: true,
      oldPidConfirmedExitedBeforeRestore: true,
      backupRestoredRegistry: true,
      activeProfileRestored: true,
      finalReadbackEntryCount: 2,
    });
    const expectedBackupMode = process.platform === 'win32'
      ? 'owner-only-requested-platform-limited'
      : '600/600';
    expect(evidence.paths.upgrade.backupMode).toBe(expectedBackupMode);
    expect(evidence.paths.rollbackReupgrade.rollbackBackupMode)
      .toBe(expectedBackupMode);

    expect(evidence.writerEvidence).toHaveLength(7);
    for (const writer of evidence.writerEvidence) {
      expect(writer.pid).toBeTypeOf('number');
      expect(writer.pid).toBeGreaterThan(0);
      expect(writer.artifact).toBe('writer.cjs');
      expect(writer.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(writer.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(writer.sourceRef).toMatch(/^[0-9a-f]{7,40}$/);
    }
    expect(evidence.artifacts.old.artifactSha256)
      .not.toBe(evidence.artifacts.new.artifactSha256);
  }, 30_000);
});
