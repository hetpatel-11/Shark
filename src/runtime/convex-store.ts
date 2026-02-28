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

  constructor(private readonly deploymentUrl: string) {
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
      return createInitialRunState(createRunId());
    }

    return createInitialRunState(createRunId());
  }

  async save(state: RunState): Promise<void> {
    await (this.client as any).mutation("state:upsert", {
      payload: JSON.stringify(state),
    });
  }
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}`;
}
