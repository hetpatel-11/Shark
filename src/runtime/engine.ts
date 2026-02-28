import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DashboardSnapshot,
  OperatorCommand,
  SharkConfig,
  SharkEvent,
  SharkMode,
  RunState,
  Task,
  ToolName,
  VentureThesis,
} from "../contracts.js";
import { AgentMailAdapter } from "../adapters/agentmail.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { BrowserUseAdapter } from "../adapters/browser-use.js";
import { DaytonaExecutor } from "../adapters/daytona.js";
import { SlackAdapter } from "../adapters/slack.js";
import { SupermemoryAdapter } from "../adapters/supermemory.js";
import { VercelAdapter } from "../adapters/vercel.js";
import { defaultNextMode } from "./loop.js";
import type { StateStore } from "./store.js";
import {
  beginTask,
  clearCommands,
  completeTask,
  createInitialRunState,
  enqueueCommand,
  queueTask,
  setProviderHealth,
  transitionMode,
  withEvent,
} from "./state.js";

export class SharkEngine {
  private state = createInitialRunState("boot");
  private timer?: NodeJS.Timeout;

  private readonly anthropic: AnthropicAdapter;
  private readonly browserUse: BrowserUseAdapter;
  private readonly supermemory: SupermemoryAdapter;
  private readonly slack: SlackAdapter;
  private readonly agentMail: AgentMailAdapter;
  private readonly daytona: DaytonaExecutor;
  private readonly vercel: VercelAdapter;

  constructor(
    private readonly config: SharkConfig,
    private readonly store: StateStore,
  ) {
    this.anthropic = new AnthropicAdapter(config);
    this.browserUse = new BrowserUseAdapter(config);
    this.supermemory = new SupermemoryAdapter(config);
    this.slack = new SlackAdapter(config);
    this.agentMail = new AgentMailAdapter(config);
    this.daytona = new DaytonaExecutor();
    this.vercel = new VercelAdapter(config, this.daytona);
  }

  async init(): Promise<void> {
    this.state = await this.store.load();
    this.state.isRunning = false;
    this.state = this.seedStaticHealth(this.state);
    await this.save();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.state.isRunning = true;
    void this.save();
    this.timer = setInterval(() => {
      void this.runOnce("interval");
    }, this.config.loopIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.state.isRunning = false;
    void this.save();
  }

  async enqueueOperatorCommand(text: string, source: OperatorCommand["source"]): Promise<void> {
    this.state = enqueueCommand(this.state, {
      id: `cmd_${Date.now().toString(36)}`,
      source,
      text,
      createdAt: new Date().toISOString(),
    });
    this.state = withEvent(this.state, this.event("operator_command", `Operator command received: ${text}`));
    await this.save();
  }

  async runOnce(trigger: "manual" | "interval" | "startup" = "manual"): Promise<DashboardSnapshot> {
    await mkdir(this.config.workspaceDir, { recursive: true });
    await this.processCommands();

    const mode = this.state.mode === "blocked" && this.state.pendingApproval?.status === "pending"
      ? "blocked"
      : defaultNextMode(this.state);

    this.state = transitionMode(this.state, mode);
    this.state = withEvent(this.state, this.event("status_update", `Running ${mode} iteration via ${trigger}`));

    if (mode === "blocked") {
      this.state.lastSummary = "Waiting for operator approval";
      await this.notify(`Shark is blocked awaiting approval: ${this.state.pendingApproval?.reason ?? "unknown action"}`);
      await this.save();
      return this.snapshot();
    }

    if (mode === "discovery") {
      await this.runDiscovery();
    } else if (mode === "planning") {
      await this.runPlanning();
    } else if (mode === "building") {
      await this.runBuilding();
    } else {
      await this.runOperating();
    }

    this.state.lastIterationAt = new Date().toISOString();
    await this.save();
    return this.snapshot();
  }

  snapshot(): DashboardSnapshot {
    return {
      runId: this.state.runId,
      mode: this.state.mode,
      isRunning: this.state.isRunning,
      thesis: this.state.thesis,
      mailboxAddress: this.state.mailboxAddress,
      currentTask: this.state.currentTask,
      pendingTasks: this.state.tasks.filter((task) => task.status === "pending"),
      pendingApproval: this.state.pendingApproval,
      providerHealth: this.state.providerHealth,
      queuedCommands: this.state.queuedCommands,
      lastSummary: this.state.lastSummary,
      recentEvents: this.state.recentEvents,
      lastIterationAt: this.state.lastIterationAt,
      storage: this.store.kind,
    };
  }

  async smoke(): Promise<DashboardSnapshot> {
    await this.init();
    await this.refreshProviderHealth();
    return this.snapshot();
  }

  private async runDiscovery(): Promise<void> {
    await this.refreshProviderHealth();

    const researchTask = "Research venture-scale AI startup opportunities that can be built and operated autonomously. Focus on markets with painful recurring workflows and clear distribution.";
    const browserTask = await this.browserUse.runTask(researchTask);

    const prompt = [
      "You are Shark, a founder agent selecting one venture-scale AI startup to pursue.",
      "Pick one startup idea after considering market pain, execution feasibility, AI leverage, and defensibility.",
      "Reply in labeled lines: Startup, Customer, Problem, Product, Why now, Moat.",
      (browserTask.liveUrl ?? browserTask.live_url)
        ? `Browser live URL: ${browserTask.liveUrl ?? browserTask.live_url}`
        : (browserTask.task_id ?? browserTask.id)
          ? `Browser task created: ${browserTask.task_id ?? browserTask.id}`
          : "Browser run started or skipped.",
    ].join("\n");

    const synthesis = await this.anthropic.generateText(prompt);
    const thesis = parseThesis(synthesis);

    this.state.thesis = thesis;
    this.state.lastSummary = `Selected startup thesis: ${thesis.headline}`;
    this.state = withEvent(this.state, this.event("status_update", this.state.lastSummary));

    const memoryResult = await this.supermemory.addMemory(
      JSON.stringify(thesis),
      "shark_venture_thesis",
    );
    this.state = withEvent(
      this.state,
      this.event(
        "tool_called",
        `Stored thesis in Supermemory (${memoryResult.status ?? "unknown"})`,
        { tool: "supermemory" },
      ),
    );

    await this.writeArtifact("venture-thesis.md", renderThesis(thesis, synthesis));
    await this.notify(`Shark selected a startup thesis: ${thesis.headline}`);
    this.state = transitionMode(this.state, "planning");
  }

  private async runPlanning(): Promise<void> {
    if (!this.state.thesis) {
      this.state = transitionMode(this.state, "discovery");
      return;
    }

    const existingPending = this.state.tasks.some((task) => task.status === "pending");
    if (!existingPending) {
      for (const task of createPlanTasks(this.state.thesis)) {
        this.state = queueTask(this.state, task);
      }
    }

    this.state.lastSummary = `Planned ${this.state.tasks.filter((task) => task.status === "pending").length} pending tasks`;
    this.state = withEvent(this.state, this.event("status_update", this.state.lastSummary));
    this.state = transitionMode(this.state, "building");
  }

  private async runBuilding(): Promise<void> {
    const nextTask = this.state.tasks
      .filter((task) => task.status === "pending")
      .sort((left, right) => right.priority - left.priority)[0];

    if (!nextTask) {
      this.state = transitionMode(this.state, "operating");
      return;
    }

    this.state = beginTask(this.state, nextTask);
    const output = await this.executeTask(nextTask);
    this.state = completeTask(this.state, output);
    this.state.currentTask = undefined;
    this.state.lastSummary = output;
    await this.notify(`Task completed: ${nextTask.title}`);

    if (!this.state.tasks.some((task) => task.status === "pending")) {
      this.state = transitionMode(this.state, "operating");
    } else {
      this.state = transitionMode(this.state, "planning");
    }
  }

  private async runOperating(): Promise<void> {
    await this.refreshProviderHealth();

    const checks = [
      `Current thesis: ${this.state.thesis?.headline ?? "not selected"}`,
      `Pending tasks: ${this.state.tasks.filter((task) => task.status === "pending").length}`,
      `Mailbox: ${this.state.mailboxAddress ?? "not provisioned"}`,
    ].join(" | ");

    const summary = `Operating check complete. ${checks}`;
    this.state.lastSummary = summary;
    this.state = withEvent(this.state, this.event("status_update", summary));
    await this.notify(summary);
    this.state = transitionMode(this.state, "planning");
  }

  private async executeTask(task: Task): Promise<string> {
    switch (task.id) {
      case "create-thesis-dossier":
        await this.writeArtifact("startup-dossier.md", renderStartupDossier(this.state.thesis));
        return "Wrote startup dossier artifact";
      case "create-agentmail-inbox": {
        const mailbox = await this.agentMail.createMailbox();
        if (mailbox.address) {
          this.state.mailboxAddress = mailbox.address;
          await this.writeArtifact("agentmail-inbox.md", `Inbox: ${mailbox.address}\nCreated: ${mailbox.created_at ?? "unknown"}`);
          return `Provisioned AgentMail inbox ${mailbox.address}`;
        }

        return mailbox.error ?? "AgentMail inbox provisioning skipped";
      }
      case "sync-thesis-memory": {
        const result = await this.supermemory.addMemory(
          `Startup thesis: ${JSON.stringify(this.state.thesis)}`,
          "shark_venture_thesis",
        );
        return `Supermemory sync result: ${result.status ?? "unknown"}`;
      }
      case "browser-market-research": {
        const result = await this.browserUse.runTask(
          `Research competitors and go-to-market tactics for ${this.state.thesis?.headline ?? "the selected startup"} and summarize the most actionable insights.`,
        );
        await this.writeArtifact(
          "browser-research.md",
          [
            `Status: ${result.status ?? "unknown"}`,
            `Task ID: ${result.task_id ?? result.id ?? "unknown"}`,
            `Session ID: ${result.sessionId ?? "n/a"}`,
            `Live URL: ${result.liveUrl ?? result.live_url ?? "n/a"}`,
          ].join("\n"),
        );
        return `Browser Use task started: ${result.task_id ?? result.id ?? "unknown"}`;
      }
      case "publish-slack-brief": {
        const text = [
          `Shark startup thesis: ${this.state.thesis?.headline ?? "unknown"}`,
          `Customer: ${this.state.thesis?.targetCustomer ?? "unknown"}`,
          `Problem: ${this.state.thesis?.problem ?? "unknown"}`,
        ].join("\n");
        const result = await this.slack.postMessage(text);
        return result.ok ? "Posted startup brief to Slack" : `Slack post skipped: ${result.error ?? "unknown error"}`;
      }
      case "probe-vercel": {
        const projects = await this.vercel.listProjects();
        await this.writeArtifact("vercel-projects.md", projects.length > 0 ? projects.join("\n") : "No Vercel projects returned");
        return `Vercel probe complete (${projects.length} projects visible)`;
      }
      case "run-smoke-checks": {
        const result = await this.daytona.run("npm run typecheck", process.cwd());
        await this.writeArtifact(
          "smoke-checks.txt",
          [result.stdout, result.stderr].filter(Boolean).join("\n\n") || "No output",
        );
        return result.ok ? "Typecheck succeeded" : `Typecheck failed: ${result.stderr || result.stdout}`;
      }
      default:
        return "No task handler implemented";
    }
  }

  private async processCommands(): Promise<void> {
    if (this.state.queuedCommands.length === 0) {
      return;
    }

    const commands = [...this.state.queuedCommands];
    this.state = clearCommands(this.state);

    for (const command of commands) {
      const normalized = command.text.trim().toLowerCase();
      if (normalized === "approve" && this.state.pendingApproval) {
        this.state.pendingApproval.status = "approved";
        this.state.pendingApproval = undefined;
        this.state = transitionMode(this.state, "planning");
        this.state = withEvent(this.state, this.event("status_update", "Approval granted by operator"));
      } else if (normalized === "reject" && this.state.pendingApproval) {
        this.state.pendingApproval.status = "rejected";
        this.state.pendingApproval = undefined;
        this.state = transitionMode(this.state, "planning");
        this.state = withEvent(this.state, this.event("status_update", "Approval rejected by operator"));
      } else if (normalized === "pause") {
        this.stop();
        this.state = withEvent(this.state, this.event("status_update", "Loop paused by operator"));
      } else if (normalized === "resume") {
        this.start();
        this.state = withEvent(this.state, this.event("status_update", "Loop resumed by operator"));
      } else {
        this.state = queueTask(
          this.state,
          createOperatorTask(command.text),
        );
        this.state = withEvent(
          this.state,
          this.event("status_update", `Queued operator-directed task: ${command.text}`),
        );
      }
    }
  }

  private async refreshProviderHealth(): Promise<void> {
    this.state = setProviderHealth(this.state, "slack", this.slack.health());
    this.state = setProviderHealth(this.state, "supermemory", this.supermemory.health());
    this.state = setProviderHealth(this.state, "agentmail", this.agentMail.health());
    this.state = setProviderHealth(this.state, "vercel", this.vercel.health());
    this.state = setProviderHealth(this.state, "browser-use", await this.browserUse.healthCheck());
    this.state = setProviderHealth(this.state, "anthropic", {
      ok: this.anthropic.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.anthropic.isConfigured() ? "Ready" : "Missing ANTHROPIC_API_KEY",
    });
    this.state = setProviderHealth(this.state, "daytona", {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "Command execution available in current runtime",
    });
  }

  private seedStaticHealth(state: RunState): RunState {
    let next = state;
    next = setProviderHealth(next, "slack", this.slack.health());
    next = setProviderHealth(next, "supermemory", this.supermemory.health());
    next = setProviderHealth(next, "agentmail", this.agentMail.health());
    next = setProviderHealth(next, "vercel", this.vercel.health());
    next = setProviderHealth(next, "anthropic", {
      ok: this.anthropic.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.anthropic.isConfigured() ? "Ready" : "Missing ANTHROPIC_API_KEY",
    });
    next = setProviderHealth(next, "daytona", {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "Command execution available in current runtime",
    });
    return next;
  }

  private async writeArtifact(name: string, contents: string): Promise<void> {
    const artifactsDir = join(this.config.workspaceDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, name), contents);
  }

  private async notify(message: string): Promise<void> {
    const result = await this.slack.postMessage(message);
    const eventMessage = result.ok ? `Slack notified: ${message}` : `Slack notification skipped: ${result.error ?? "not configured"}`;
    this.state = withEvent(this.state, this.event("status_update", eventMessage));
  }

  private event(
    kind: SharkEvent["kind"],
    message: string,
    metadata?: Record<string, string | number | boolean>,
  ): SharkEvent {
    return {
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };
  }

  private async save(): Promise<void> {
    await this.store.save(this.state);
  }
}

function parseThesis(raw: string): VentureThesis {
  const fields = parseLabeledLines(raw);
  const now = new Date().toISOString();

  return {
    id: `thesis_${Date.now().toString(36)}`,
    headline: fields.startup ?? "AI revenue operations control tower for SMBs",
    targetCustomer: fields.customer ?? "founder-led SMBs",
    problem: fields.problem ?? "critical operating workflows are fragmented",
    productShape: fields.product ?? "an AI-native operating system for repetitive company operations",
    whyNow: fields["why now"] ?? "agents can now execute continuously across tools",
    moatHypothesis: fields.moat ?? "compounding operational memory",
    score: {
      marketSize: 9,
      speedToLaunch: 8,
      defensibility: 7,
      aiLeverage: 9,
      distributionPotential: 7,
      composite: 8,
    },
    selectedAt: now,
  };
}

function parseLabeledLines(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const [label, ...rest] = line.split(":");
    if (!label || rest.length === 0) {
      continue;
    }

    fields[label.trim().toLowerCase()] = rest.join(":").trim();
  }

  return fields;
}

function createPlanTasks(thesis: VentureThesis): Task[] {
  const now = new Date().toISOString();
  return [
    {
      id: "create-thesis-dossier",
      title: "Create startup dossier",
      description: `Write a durable dossier for ${thesis.headline}`,
      kind: "artifact",
      mode: "building",
      priority: 100,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "create-agentmail-inbox",
      title: "Provision agent inbox",
      description: "Create the inbox Shark will use for outreach and auth",
      kind: "operations",
      mode: "building",
      priority: 90,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "sync-thesis-memory",
      title: "Persist startup thesis in memory",
      description: "Store the selected startup thesis in Supermemory",
      kind: "memory",
      mode: "building",
      priority: 80,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "browser-market-research",
      title: "Run browser market research",
      description: "Kick off a Browser Use research task for competitor discovery",
      kind: "research",
      mode: "building",
      priority: 70,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "publish-slack-brief",
      title: "Send startup brief to Slack",
      description: "Notify the operator of the chosen thesis and next actions",
      kind: "messaging",
      mode: "building",
      priority: 60,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "probe-vercel",
      title: "Probe Vercel projects",
      description: "Verify deployment access to Vercel",
      kind: "deployment",
      mode: "building",
      priority: 50,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "run-smoke-checks",
      title: "Run runtime smoke checks",
      description: "Typecheck the current control plane",
      kind: "operations",
      mode: "building",
      priority: 40,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
  ];
}

function createOperatorTask(text: string): Task {
  return {
    id: `operator_${Date.now().toString(36)}`,
    title: `Operator directive: ${text}`,
    description: text,
    kind: "operations",
    mode: "building",
    priority: 120,
    blockedByApproval: false,
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
}

function renderThesis(thesis: VentureThesis, raw: string): string {
  return [
    `# ${thesis.headline}`,
    "",
    `Selected: ${thesis.selectedAt}`,
    `Customer: ${thesis.targetCustomer}`,
    `Problem: ${thesis.problem}`,
    `Product: ${thesis.productShape}`,
    `Why now: ${thesis.whyNow}`,
    `Moat: ${thesis.moatHypothesis}`,
    "",
    "## Raw synthesis",
    "",
    raw,
  ].join("\n");
}

function renderStartupDossier(thesis?: VentureThesis): string {
  if (!thesis) {
    return "# Startup Dossier\n\nNo thesis available.";
  }

  return [
    `# ${thesis.headline}`,
    "",
    "## ICP",
    thesis.targetCustomer,
    "",
    "## Core Problem",
    thesis.problem,
    "",
    "## Product",
    thesis.productShape,
    "",
    "## Timing",
    thesis.whyNow,
    "",
    "## Moat Hypothesis",
    thesis.moatHypothesis,
  ].join("\n");
}
