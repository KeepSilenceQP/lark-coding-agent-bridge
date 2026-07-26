export interface MigrationArtifactEvidence {
  artifact: string;
  artifactSha256: string;
  sourceRef: string;
  version: string;
}

export interface MigrationWriterEvidence extends MigrationArtifactEvidence {
  phase: string;
  generation: 'old' | 'new';
  pid: number;
}

export interface MixedVersionMigrationEvidence {
  evidenceBoundary: {
    oldArtifact: 'historical-source-build';
    historicalSourceRef: string;
    publishedOldBinaryTested: false;
    note: string;
  };
  isolation: {
    temporaryRootOnly: true;
    inheritedBridgeEnvironmentCleared: true;
    serviceManagerCalls: 0;
    globalPackageMutations: 0;
    userConfigReads: 0;
  };
  artifacts: {
    old: MigrationArtifactEvidence;
    new: MigrationArtifactEvidence;
  };
  writerEvidence: MigrationWriterEvidence[];
  paths: {
    newInstall: {
      emptyRegistryCreated: true;
      singleNewWriterStarted: true;
      selfRegistrationPersisted: true;
      explicitOtherEntryPersisted: true;
      readbackEntryCount: number;
    };
    upgrade: {
      gateBlockedBeforeOldStop: boolean;
      historicalSaveDroppedRegistry: true;
      allOldWritersStoppedBeforeUpgradeWrite: true;
      oldPidConfirmedExited: true;
      backupMode: string;
      newWriterReadbackEntryCount: number;
      noOldOverwriteAfterUpgrade: true;
    };
    rollbackReupgrade: {
      allNewWritersStoppedBeforeRollback: true;
      rollbackBackupMode: string;
      oldCompatibleConfigDroppedRegistry: true;
      registryRemainedInBackup: true;
      reupgradeBlockedUntilOldStop: boolean;
      oldPidConfirmedExitedBeforeRestore: true;
      backupRestoredRegistry: true;
      activeProfileRestored: true;
      finalReadbackEntryCount: number;
    };
  };
}

export function runMixedVersionMigrationAcceptance(
  options?: { repositoryRoot?: string },
): Promise<MixedVersionMigrationEvidence>;
