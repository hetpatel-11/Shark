import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RunState } from "../contracts.js";
import type { StateStore } from "./store.js";
import { createInitialRunState } from "./state.js";

export class FileStateStore implements StateStore {
  readonly kind = "file";

  constructor(private readonly filePath: string) {}

  async load(): Promise<RunState> {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as RunState;
      return {
        ...createInitialRunState(parsed.runId),
        ...parsed,
      };
    } catch {
      return createInitialRunState(createRunId());
    }
  }

  async save(state: RunState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}`;
}
