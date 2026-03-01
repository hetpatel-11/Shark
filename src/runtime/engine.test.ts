import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunState, SharkConfig } from "../contracts.js";
import { SharkEngine } from "./engine.js";
import type { StateStore } from "./store.js";
import { createInitialRunState } from "./state.js";

class MemoryStore implements StateStore {
  readonly kind = "file" as const;
  state = createInitialRunState("run_test");

  async load(): Promise<RunState> {
    return structuredClone(this.state);
  }

  async save(state: RunState): Promise<void> {
    this.state = structuredClone(state);
  }
}

async function createEngine(): Promise<{
  engine: SharkEngine;
  store: MemoryStore;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "shark-engine-test-"));
  const store = new MemoryStore();
  const config: SharkConfig = {
    anthropicModel: "claude-sonnet-4-20250514",
    loopIntervalMs: 60_000,
    port: 3000,
    stateFile: join(root, "state.json"),
    workspaceDir: join(root, "workspace"),
    autoStart: false,
  };

  const engine = new SharkEngine(config, store);
  await engine.init();

  return {
    engine,
    store,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("direct Slack questions get an immediate answer instead of queueing", async () => {
  const { engine, store, cleanup } = await createEngine();
  try {
    (engine as any).composeSlackQuestionReply = async (text: string) => `answer:${text}`;

    const reply = await engine.handleSlackInstruction("1. what is the vercel deployed link");

    assert.equal(reply, "answer:what is the vercel deployed link");
    assert.equal(store.state.queuedCommands.length, 0);
  } finally {
    await cleanup();
  }
});

test("natural resume phrases resume the loop and keep the remainder as steering input", async () => {
  const { engine, store, cleanup } = await createEngine();
  try {
    let runOnceTrigger: string | undefined;
    (engine as any).start = () => {
      (engine as any).state.isRunning = true;
    };
    (engine as any).runOnce = async (trigger: string) => {
      runOnceTrigger = trigger;
      return engine.snapshot();
    };

    const reply = await engine.handleSlackInstruction("resume and continue with the current plan");

    assert.equal(reply, "🦈 Resumed. I’m back in the run now and I’m using your latest direction.");
    assert.equal(store.state.isRunning, true);
    assert.equal(runOnceTrigger, "interrupt");
    assert.equal(store.state.queuedCommands.length, 1);
    assert.equal(store.state.queuedCommands[0]?.text, "continue with the current plan");
  } finally {
    engine.stop();
    await cleanup();
  }
});

test("ordinary directives get a handled reply and are queued for the live run", async () => {
  const { engine, store, cleanup } = await createEngine();
  try {
    let runOnceTrigger: string | undefined;
    (engine as any).state.isRunning = true;
    (engine as any).runOnce = async (trigger: string) => {
      runOnceTrigger = trigger;
      return engine.snapshot();
    };
    (engine as any).interruptActiveAgentWork = () => false;
    (engine as any).composeSlackHandledReply = async (text: string, actionSummary: string) =>
      `handled:${text}:${actionSummary}`;

    const reply = await engine.handleSlackInstruction("prioritize shipping the auth flow first");

    assert.match(reply, /^handled:prioritize shipping the auth flow first:/);
    assert.equal(runOnceTrigger, "interrupt");
    assert.equal(store.state.queuedCommands.length, 1);
    assert.equal(store.state.queuedCommands[0]?.text, "prioritize shipping the auth flow first");
  } finally {
    await cleanup();
  }
});
