import type { RunState } from "../contracts.js";

export interface StateStore {
  readonly kind: "file" | "convex";
  load(): Promise<RunState>;
  save(state: RunState): Promise<void>;
}
