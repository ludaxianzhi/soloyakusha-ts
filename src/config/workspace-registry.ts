import { access } from "node:fs/promises";
import { basename } from "node:path";
import { GlobalConfigManager } from "./manager.ts";
import type { WorkspaceEntry } from "./types.ts";

export type ListRegisteredWorkspacesOptions = {
  pruneMissing?: boolean;
  onMissingWorkspace?: (entry: WorkspaceEntry) => void | Promise<void>;
};

export class WorkspaceRegistry {
  constructor(private readonly manager = new GlobalConfigManager()) {}

  async listRegisteredWorkspaces(
    options: ListRegisteredWorkspacesOptions = {},
  ): Promise<WorkspaceEntry[]> {
    const entries = await this.manager.getRecentWorkspaces();
    const { pruneMissing = false, onMissingWorkspace } = options;
    if (!pruneMissing) {
      return entries;
    }

    const validEntries: WorkspaceEntry[] = [];
    for (const entry of entries) {
      try {
        await access(entry.dir);
        validEntries.push(entry);
      } catch {
        if (onMissingWorkspace) {
          await onMissingWorkspace(entry);
        }
        await this.manager.removeRecentWorkspace(entry.dir).catch(() => undefined);
      }
    }

    return validEntries;
  }

  async touchWorkspace(entry: { dir: string; name?: string }): Promise<void> {
    const currentEntries = await this.manager.getRecentWorkspaces();
    const existing = currentEntries.find((item) => item.dir === entry.dir);
    await this.manager.addRecentWorkspace({
      dir: entry.dir,
      name: entry.name?.trim() || existing?.name || basename(entry.dir),
    });
  }

  async removeWorkspace(dir: string): Promise<void> {
    await this.manager.removeRecentWorkspace(dir);
  }
}
