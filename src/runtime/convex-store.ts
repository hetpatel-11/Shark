import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ConvexHttpClient } from "convex/browser";

import type { RunState } from "../contracts.js";
import type { StateStore } from "./store.js";
import { createInitialRunState } from "./state.js";

interface ConvexStoredState {
  payload?: string;
}

export class ConvexStateStore implements StateStore {
  readonly kind = "convex";
  private readonly client: ConvexHttpClient;

  constructor(
    private readonly deploymentUrl: string,
    private readonly backupPath: string,
  ) {
    this.client = new ConvexHttpClient(deploymentUrl);
  }

  async load(): Promise<RunState> {
    try {
      const result = await (this.client as any).query("state:get", {});
      if (result && typeof result === "object" && "payload" in result) {
        const payload = (result as ConvexStoredState).payload;
        if (payload) {
          const parsed = JSON.parse(payload) as RunState;
          return {
            ...createInitialRunState(parsed.runId),
            ...parsed,
          };
        }
      }
    } catch {
      return this.loadBackup();
    }

    return this.loadBackup();
  }

  async save(state: RunState): Promise<void> {
    await this.saveBackup(state);

    try {
      await (this.client as any).mutation("state:upsert", {
        payload: JSON.stringify(state),
      });
    } catch (error) {
      warn(
        `Convex save failed; continuing with local backup only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadBackup(): Promise<RunState> {
    await mkdir(dirname(this.backupPath), { recursive: true });

    try {
      const raw = await readFile(this.backupPath, "utf8");
      const parsed = JSON.parse(raw) as RunState;
      return {
        ...createInitialRunState(parsed.runId),
        ...parsed,
      };
    } catch {
      return createInitialRunState(createRunId());
    }
  }

  private async saveBackup(state: RunState): Promise<void> {
    await mkdir(dirname(this.backupPath), { recursive: true });
    await writeFile(this.backupPath, JSON.stringify(state, null, 2));
  }
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}`;
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}
