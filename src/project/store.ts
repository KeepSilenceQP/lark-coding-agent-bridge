import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ProjectHumanActor {
  openId: string;
  name?: string;
}

export interface ProjectBotActor {
  botId: string;
  name: string;
}

export interface ProjectRoleAssignment {
  workspace: string;
  decisionOwner: ProjectHumanActor;
  coordinator: ProjectBotActor;
  planWriter: ProjectBotActor;
  implementer: ProjectBotActor;
}

interface ProjectData {
  chats: Record<string, ProjectRoleAssignment>;
  disabledChats: Record<string, string>;
}

const updateQueues = new Map<string, Promise<void>>();

export class ProjectStore {
  private data: ProjectData = { chats: {}, disabledChats: {} };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<ProjectData>;
      this.data = {
        chats: parsed.chats ?? {},
        disabledChats: parsed.disabledChats ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  get(chatId: string): ProjectRoleAssignment | undefined {
    if (chatId in this.data.disabledChats) return undefined;
    const assignment = this.data.chats[chatId];
    return assignment ? normalizeAssignment(assignment) : undefined;
  }

  getState(chatId: string): ProjectRoleAssignmentState {
    const assignment = this.data.chats[chatId];
    const disabledReason = this.data.disabledChats[chatId];
    return {
      assignment: assignment ? normalizeAssignment(assignment) : undefined,
      usable: Boolean(assignment) && disabledReason === undefined,
      ...(disabledReason !== undefined ? { disabledReason } : {}),
    };
  }

  set(chatId: string, assignment: ProjectRoleAssignment): void {
    this.data.chats[chatId] = structuredClone(assignment);
    delete this.data.disabledChats[chatId];
    this.schedulePersist();
  }

  disable(chatId: string, reason: string): void {
    this.data.disabledChats[chatId] = reason;
    this.schedulePersist();
  }

  remove(chatId: string): boolean {
    if (!(chatId in this.data.chats) && !(chatId in this.data.disabledChats)) return false;
    delete this.data.chats[chatId];
    delete this.data.disabledChats[chatId];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      });
  }
}

export interface ProjectRoleAssignmentState {
  assignment?: ProjectRoleAssignment;
  usable: boolean;
  disabledReason?: string;
}

function normalizeAssignment(assignment: ProjectRoleAssignment): ProjectRoleAssignment {
  return {
    workspace: assignment.workspace,
    decisionOwner: {
      openId: assignment.decisionOwner.openId,
      ...(assignment.decisionOwner.name ? { name: assignment.decisionOwner.name } : {}),
    },
    coordinator: { ...assignment.coordinator },
    planWriter: { ...assignment.planWriter },
    implementer: { ...assignment.implementer },
  };
}

export async function readProjectRoleAssignment(
  profileDir: string,
  chatId: string,
): Promise<ProjectRoleAssignment | undefined> {
  const store = new ProjectStore(join(profileDir, 'projects.json'));
  await store.load();
  return store.get(chatId);
}

export async function readProjectRoleAssignmentState(
  profileDir: string,
  chatId: string,
): Promise<ProjectRoleAssignmentState> {
  const store = new ProjectStore(join(profileDir, 'projects.json'));
  await store.load();
  return store.getState(chatId);
}

export async function updateProjectRoleAssignment(
  path: string,
  chatId: string,
  assignment: ProjectRoleAssignment,
): Promise<void> {
  await updateProjectStore(path, (store) => {
    store.set(chatId, assignment);
  });
}

export async function disableProjectRoleAssignment(
  path: string,
  chatId: string,
  reason: string,
): Promise<void> {
  await updateProjectStore(path, (store) => {
    store.disable(chatId, reason);
  });
}

async function updateProjectStore(
  path: string,
  update: (store: ProjectStore) => void,
): Promise<void> {
  const previous = updateQueues.get(path) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const store = new ProjectStore(path);
      await store.load();
      update(store);
      await store.flush();
    });
  updateQueues.set(path, current);
  try {
    await current;
  } finally {
    if (updateQueues.get(path) === current) updateQueues.delete(path);
  }
}
