import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  failTask,
  queueTask,
  setProviderHealth,
  transitionMode,
  withEvent,
} from "./state.js";

const RUNTIME_PLAN_FILE = "IMPLEMENTATION_PLAN.md";

interface PlanTaskEntry {
  task: Task;
  preferredTool: string;
}

interface BuildSelection {
  taskId?: string;
  action: string;
  reason: string;
  raw: string;
}

interface AgentMailWebhookPayload {
  event_type?: string;
  event_id?: string;
  message?: {
    from_?: string[];
    organization_id?: string;
    inbox_id?: string;
    thread_id?: string;
    message_id?: string;
    labels?: string[];
    timestamp?: string;
    reply_to?: string[];
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    preview?: string;
    text?: string;
    html?: string;
    attachments?: Array<{
      attachment_id?: string;
      filename?: string;
      content_type?: string;
      size?: number;
      inline?: boolean;
    }>;
    in_reply_to?: string;
    references?: string[];
    sort_key?: string;
    updated_at?: string;
    created_at?: string;
  };
}

export class SharkEngine {
  private state = createInitialRunState("boot");
  private timer?: NodeJS.Timeout;
  private activeCycle?: Promise<DashboardSnapshot>;
  private pendingCycleTrigger?: "manual" | "interval" | "startup" | "interrupt";

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
    if (!this.state.startedAt) {
      this.state.startedAt = deriveRunStartedAt(this.state);
    }
    if (typeof this.state.totalAgentTurns !== "number" || Number.isNaN(this.state.totalAgentTurns)) {
      this.state.totalAgentTurns = 0;
    }
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
    this.state = withEvent(this.state, this.event("operator_command", `Operator command received: ${text}`, {
      source,
    }));
    await this.save();
  }

  async handleSlackInstruction(text: string): Promise<string> {
    const normalized = text.trim().toLowerCase();

    if (normalized === "pause") {
      this.stop();
      this.state = withEvent(this.state, this.event("status_update", "Loop paused by operator", {
        source: "slack",
      }));
      await this.save();
      return this.composeSlackAcknowledgement(text);
    }

    if (normalized === "resume") {
      if (!this.state.isRunning) {
        this.start();
      }
      this.state = withEvent(this.state, this.event("status_update", "Loop resumed by operator", {
        source: "slack",
      }));
      await this.save();
      void this.runOnce("interrupt");
      return this.composeSlackAcknowledgement(text);
    }

    await this.enqueueOperatorCommand(text, "slack");

    if (this.state.isRunning) {
      void this.runOnce("interrupt");
    }

    return this.composeSlackAcknowledgement(text);
  }

  async ingestInboundEmail(payload: AgentMailWebhookPayload): Promise<void> {
    if (payload.event_type !== "message.received" || !payload.message) {
      this.state = withEvent(
        this.state,
        this.event("status_update", `Ignored unsupported AgentMail event: ${payload.event_type ?? "unknown"}`, {
          surface: "agentmail",
        }),
      );
      await this.save();
      return;
    }

    const email = payload.message;
    const subject = email.subject?.trim() || "No subject";
    const sender = joinAddresses(email.from_);
    const threadId = email.thread_id ?? "unknown-thread";
    const messageId = email.message_id ?? `msg_${Date.now().toString(36)}`;

    await this.writeArtifact(
      `agentmail-inbound-${sanitizeFileFragment(messageId)}.md`,
      renderInboundEmailArtifact(payload),
    );

    this.state = enqueueCommand(this.state, {
      id: `cmd_${Date.now().toString(36)}`,
      source: "email",
      text: buildInboundEmailDirective(payload),
      createdAt: new Date().toISOString(),
    });
    this.state = withEvent(
      this.state,
      this.event("operator_command", `Inbound email queued for review: ${subject}`, {
        source: "email",
        threadId,
        inboxId: email.inbox_id ?? "unknown",
      }),
    );
    this.state = withEvent(
      this.state,
      this.event("status_update", `Inbound email received from ${sender}: ${subject}`, {
        surface: "agentmail",
        eventType: payload.event_type,
        threadId,
        messageId,
      }),
    );
    await this.save();
  }

  async runOnce(trigger: "manual" | "interval" | "startup" | "interrupt" = "manual"): Promise<DashboardSnapshot> {
    if (this.activeCycle) {
      if (!this.pendingCycleTrigger || trigger !== "interval") {
        this.pendingCycleTrigger = trigger;
      }
      return this.activeCycle;
    }

    this.activeCycle = this.runCycle(trigger);

    try {
      return await this.activeCycle;
    } finally {
      this.activeCycle = undefined;
      const nextTrigger = this.pendingCycleTrigger;
      this.pendingCycleTrigger = undefined;
      if (nextTrigger) {
        void this.runOnce(nextTrigger);
      }
    }
  }

  private async runCycle(trigger: "manual" | "interval" | "startup" | "interrupt"): Promise<DashboardSnapshot> {
    await mkdir(this.config.workspaceDir, { recursive: true });
    const entries = await this.readPlanEntries();
    if (entries.length > 0) {
      this.syncTasksFromPlan(entries);
    } else if (this.state.thesis) {
      this.state.tasks = [];
      this.state.currentTask = undefined;
    }
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
    const recentTasks = [...this.state.tasks]
      .filter((task) => task.status !== "pending")
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 6);

    return {
      runId: this.state.runId,
      startedAt: this.state.startedAt,
      totalAgentTurns: this.state.totalAgentTurns,
      mode: this.state.mode,
      isRunning: this.state.isRunning,
      thesis: this.state.thesis,
      mailboxAddress: this.state.mailboxAddress,
      currentTask: this.state.currentTask,
      pendingTasks: this.state.tasks.filter((task) => task.status === "pending"),
      recentTasks,
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
    const memoryContext = await this.recallMemoryContext(
      "previous startup ideas, venture thesis decisions, customer pain points, and operator preferences",
    );

    const prompt = [
      "You are Shark, a founder agent selecting one venture-scale AI startup to pursue.",
      "Pick one startup idea after considering market pain, execution feasibility, AI leverage, and defensibility.",
      "You have access to a tool surface and should pick an idea that can actually be executed with the available tools.",
      "Search and reuse relevant memory before repeating past work. If prior memory is included below, use it.",
      "Reply in labeled lines: Startup, Customer, Problem, Product, Why now, Moat.",
      "",
      "Relevant memory:",
      memoryContext,
      "",
      "Available tools:",
      this.renderToolCatalog(),
      (browserTask.liveUrl ?? browserTask.live_url)
        ? `Browser live URL: ${browserTask.liveUrl ?? browserTask.live_url}`
        : (browserTask.task_id ?? browserTask.id)
          ? `Browser task created: ${browserTask.task_id ?? browserTask.id}`
          : "Browser run started or skipped.",
    ].join("\n");

    const result = await this.anthropic.runAgentPrompt(prompt);
    this.markAgentTurns(result.turns);
    const thesis = parseThesis(result.text);

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

    await this.writeArtifact("venture-thesis.md", renderThesis(thesis, result.text));
    await this.notify(`Shark selected a startup thesis: ${thesis.headline}`);
    this.state = transitionMode(this.state, "planning");
  }

  private async runPlanning(): Promise<void> {
    if (!this.state.thesis) {
      this.state = transitionMode(this.state, "discovery");
      return;
    }

    const thesis = this.state.thesis;
    const directives = this.recentOperatorDirectives();
    const memoryContext = await this.recallMemoryContext(
      [
        thesis.headline,
        thesis.targetCustomer,
        thesis.problem,
        ...directives,
      ].join(" | "),
    );
    const result = await this.anthropic.runAgentPrompt(
      [
        "Planning mode only. Update ./IMPLEMENTATION_PLAN.md in the current working directory.",
        "Do not implement product code in this step.",
        "Rewrite the plan so it is the single source of truth for the next build iterations.",
        "Before planning, search relevant long-term memory and use it to avoid redoing solved work.",
        `Startup thesis: ${thesis.headline}`,
        `Customer: ${thesis.targetCustomer}`,
        `Problem: ${thesis.problem}`,
        `Product: ${thesis.productShape}`,
        "",
        "Relevant memory:",
        memoryContext,
        "",
        "Use this exact task line format for every task:",
        "- [ ] task-id | tool | title | description",
        "- [x] task-id | tool | title | description",
        "",
        "Rules:",
        "- Use stable lowercase-hyphenated task ids.",
        "- Allowed tool values: sdk, browser-use, supermemory, agentmail, vercel, slack, daytona, human.",
        "- Prefer sdk whenever the task can be completed through Claude's built-in tools or connected MCP servers.",
        "- Only use browser-use, supermemory, agentmail, or vercel directly when the host runtime must perform a specific fallback action itself.",
        "- Reserve slack, daytona, and human for host-managed side effects or integrations the host must own.",
        "- Highest priority tasks must appear first.",
        "- Keep tasks concrete and execution-ready.",
        "- Include tasks for research, product build-out, legal docs, launch assets, and operational setup when relevant.",
        "- No money-making, billing, or paid commitments.",
        "",
        "Available tools:",
        this.renderToolCatalog(),
        "",
        directives.length > 0
          ? `Recent operator directives:\n${directives.map((directive) => `- ${directive}`).join("\n")}`
          : "No recent operator directives.",
        "",
        "Create the file if it does not exist, or fully rewrite it if it is stale.",
        "After updating the file, return a short summary of the planning changes.",
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    let entries = await this.readPlanEntries();
    if (entries.length === 0) {
      await this.writeFallbackPlan(thesis);
      entries = await this.readPlanEntries();
    }

    this.syncTasksFromPlan(entries);
    await this.writeArtifact(
      "planning-brief.md",
      [
        `Session ID: ${result.sessionId ?? "unknown"}`,
        `Turns: ${result.turns ?? "unknown"}`,
        "",
        result.text,
      ].join("\n"),
    );
    this.state = withEvent(this.state, this.event("tool_called", "Claude rewrote the runtime implementation plan", {
      tool: "anthropic",
    }));

    this.state.lastSummary = `Planned ${this.state.tasks.filter((task) => task.status === "pending").length} pending tasks from runtime plan`;
    this.state = withEvent(this.state, this.event("status_update", this.state.lastSummary));
    this.state = transitionMode(this.state, "building");
  }

  private async runBuilding(): Promise<void> {
    let entries = await this.readPlanEntries();
    if (entries.length === 0) {
      this.state = transitionMode(this.state, "planning");
      return;
    }

    this.syncTasksFromPlan(entries);
    const pendingEntries = entries.filter((entry) => entry.task.status === "pending");

    if (pendingEntries.length === 0) {
      this.state = transitionMode(this.state, "operating");
      return;
    }

    const selection = await this.selectPlannedTask(pendingEntries);
    const selectedEntry = pendingEntries.find((entry) => entry.task.id === selection.taskId) ?? pendingEntries[0];

    this.state = beginTask(this.state, selectedEntry.task);
    await this.writeArtifact(
      `task-brief-${sanitizeFileFragment(selectedEntry.task.id)}.md`,
      selection.raw,
    );
    const output = await this.executePlannedTask(selectedEntry, selection.action);
    const failed = isFailureSummary(output);
    if (!failed) {
      await this.markPlanTaskCompleted(selectedEntry.task.id);
      this.state = completeTask(this.state, output);
    } else {
      this.state = failTask(this.state, output);
    }
    const friendlySummary = renderOperatorSummary(selectedEntry.task, output, failed, selection.reason);
    this.state.currentTask = undefined;
    this.state.lastSummary = friendlySummary;
    entries = await this.readPlanEntries();
    this.syncTasksFromPlan(entries);
    this.state = withEvent(this.state, this.event("status_update", friendlySummary));
    await this.notify(friendlySummary);

    this.state = transitionMode(
      this.state,
      this.state.tasks.some((task) => task.status === "pending") ? "planning" : "operating",
    );
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

  private async selectPlannedTask(entries: PlanTaskEntry[]): Promise<BuildSelection> {
    const memoryContext = await this.recallMemoryContext(
      entries
        .slice(0, 5)
        .map((entry) => `${entry.task.title}: ${entry.task.description}`)
        .join(" | "),
    );
    const result = await this.anthropic.runAgentPrompt(
      [
        "Building mode. Read ./IMPLEMENTATION_PLAN.md and choose exactly one unchecked task to execute next.",
        "Do not rewrite the full plan in this step.",
        "Prefer the highest-impact unchecked task that unblocks downstream work.",
        "Search relevant memory before choosing so repeated or already-solved work is deprioritized.",
        "",
        "Relevant memory:",
        memoryContext,
        "",
        "Unchecked tasks currently visible:",
        ...entries.map((entry) =>
          `- ${entry.task.id} | ${entry.preferredTool} | ${entry.task.title} | ${entry.task.description}`,
        ),
        "",
        "Reply in labeled lines only:",
        "TaskId: <task-id>",
        "Action: <specific action to execute now>",
        "Reason: <why this is the highest-value next step>",
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    const fields = parseLabeledLines(result.text);
    return {
      taskId: fields.taskid,
      action: fields.action ?? entries[0]?.task.description ?? "Execute the next task",
      reason: fields.reason ?? "No reason provided",
      raw: result.text,
    };
  }

  private async executePlannedTask(entry: PlanTaskEntry, hostAction: string): Promise<string> {
    switch (entry.preferredTool) {
      case "sdk":
        return this.runWorkspaceAutonomyTask(
          entry.task,
          [
            `Implement the task "${entry.task.title}".`,
            entry.task.description,
            "Use built-in Claude Agent SDK tools and connected MCP servers directly when they help.",
            "Prefer real execution over describing what the host should do next.",
            "If Browser Use, Supermemory, Convex, Vercel, or AgentMail MCP tools are available, use them directly instead of deferring the task.",
            "Create or edit concrete files in the current workspace when that is part of the task.",
            `Before finishing, update ./${RUNTIME_PLAN_FILE} and mark task ${entry.task.id} as complete.`,
            "Do not create billing or monetization flows.",
          ].join(" "),
        );
      case "browser-use": {
        const result = await this.browserUse.runTask(hostAction);
        await this.writeArtifact(
          `browser-task-${sanitizeFileFragment(entry.task.id)}.md`,
          [
            `Task ID: ${result.task_id ?? result.id ?? "unknown"}`,
            `Status: ${result.status ?? "unknown"}`,
            `Live URL: ${result.liveUrl ?? result.live_url ?? "n/a"}`,
            `Action: ${hostAction}`,
            `Error: ${result.error ?? "n/a"}`,
          ].join("\n"),
        );
        const browserTaskId = result.task_id ?? result.id;
        if (!browserTaskId) {
          return `Browser Use failed: ${result.error ?? result.status ?? "missing task id"}`;
        }

        return `Browser Use task started: ${browserTaskId}`;
      }
      case "supermemory": {
        const result = await this.supermemory.addMemory(
          `Plan task ${entry.task.id}: ${hostAction}`,
          "shark_runtime_plan",
        );
        return `Supermemory sync result: ${result.status ?? "unknown"}`;
      }
      case "agentmail": {
        if (!this.state.mailboxAddress) {
          const mailbox = await this.agentMail.createMailbox();
          if (mailbox.address) {
            this.state.mailboxAddress = mailbox.address;
            return `Provisioned AgentMail inbox ${mailbox.address}`;
          }

          return mailbox.error ?? "AgentMail inbox provisioning skipped";
        }

        await this.writeArtifact(
          `agentmail-task-${sanitizeFileFragment(entry.task.id)}.md`,
          [
            `Mailbox: ${this.state.mailboxAddress}`,
            `Action: ${hostAction}`,
            "Current host integration supports mailbox provisioning. Additional mail actions must be implemented separately.",
          ].join("\n"),
        );
        return `Prepared AgentMail action note for ${this.state.mailboxAddress}`;
      }
      case "vercel": {
        if (hostAction.toLowerCase().includes("list") || hostAction.toLowerCase().includes("probe")) {
          const projects = await this.vercel.listProjects();
          await this.writeArtifact(
            `vercel-task-${sanitizeFileFragment(entry.task.id)}.md`,
            projects.join("\n") || "No Vercel projects returned",
          );
          return `Vercel probe complete (${projects.length} projects visible)`;
        }

        const result = await this.vercel.deploy(this.config.workspaceDir);
        await this.writeArtifact(
          `vercel-deploy-${sanitizeFileFragment(entry.task.id)}.txt`,
          [result.stdout, result.stderr].filter(Boolean).join("\n\n") || "No output",
        );
        return result.ok ? "Vercel deploy triggered" : `Vercel deploy failed: ${result.stderr || result.stdout}`;
      }
      case "slack": {
        const result = await this.slack.postMessage(hostAction);
        return result.ok ? "Posted plan update to Slack" : `Slack post skipped: ${result.error ?? "unknown error"}`;
      }
      case "daytona": {
        const result = await this.daytona.run(hostAction, this.config.workspaceDir);
        await this.writeArtifact(
          `daytona-task-${sanitizeFileFragment(entry.task.id)}.txt`,
          [result.stdout, result.stderr].filter(Boolean).join("\n\n") || "No output",
        );
        return result.ok ? "Executed plan task in Daytona runtime" : `Daytona command failed: ${result.stderr || result.stdout}`;
      }
      case "human":
        return "Task requires a human-managed integration or approval";
      default:
        return this.runWorkspaceAutonomyTask(entry.task, `${hostAction} Mark ${entry.task.id} complete in ./${RUNTIME_PLAN_FILE}.`);
    }
  }

  private async readPlanEntries(): Promise<PlanTaskEntry[]> {
    let raw = "";
    try {
      raw = await readFile(this.runtimePlanPath(), "utf8");
    } catch {
      return [];
    }

    const parsed = raw
      .split(/\r?\n/)
      .map((line) => parsePlanLine(line))
      .filter((entry): entry is Omit<PlanTaskEntry, "task"> & {
        checked: boolean;
        id: string;
        preferredTool: string;
        title: string;
        description: string;
      } => entry !== null);

    return parsed.map((entry, index) => ({
      preferredTool: entry.preferredTool,
      task: {
        id: entry.id,
        title: entry.title,
        description: entry.description,
        kind: taskKindForTool(entry.preferredTool),
        mode: "building",
        priority: Math.max(1, 100 - index),
        blockedByApproval: entry.preferredTool === "human",
        status: entry.checked ? "completed" : "pending",
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  private syncTasksFromPlan(entries: PlanTaskEntry[]): void {
    const previous = new Map(this.state.tasks.map((task) => [task.id, task]));
    this.state.tasks = entries.map((entry) => {
      const existing = previous.get(entry.task.id);
      const nextTask = existing
        ? {
            ...entry.task,
            output: existing.output,
          }
        : entry.task;

      if (this.state.currentTask?.id === nextTask.id && nextTask.status === "pending") {
        return {
          ...nextTask,
          status: "in_progress" as const,
        };
      }

      return nextTask;
    });
  }

  private async markPlanTaskCompleted(taskId: string): Promise<void> {
    let raw = "";
    try {
      raw = await readFile(this.runtimePlanPath(), "utf8");
    } catch {
      return;
    }

    let updated = false;
    const next = raw
      .split(/\r?\n/)
      .map((line) => {
        const parsed = parsePlanLine(line);
        if (!parsed || parsed.id !== taskId || parsed.checked) {
          return line;
        }

        updated = true;
        return line.replace("- [ ]", "- [x]");
      })
      .join("\n");

    if (updated) {
      await writeFile(this.runtimePlanPath(), next);
    }
  }

  private async applyOperatorDirectiveToPlan(text: string): Promise<void> {
    const result = await this.anthropic.runAgentPrompt(
      [
        "Planning mode only. Update ./IMPLEMENTATION_PLAN.md.",
        "Do not implement code in this step.",
        "Fold the operator directive into the plan by inserting, reordering, or clarifying tasks as needed.",
        "Keep the exact task line format:",
        "- [ ] task-id | tool | title | description",
        "- [x] task-id | tool | title | description",
        "",
        `Operator directive: ${text}`,
        "",
        "After updating the file, return a short summary of the plan changes.",
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    const entries = await this.readPlanEntries();
    if (entries.length > 0) {
      this.syncTasksFromPlan(entries);
    }

    await this.writeArtifact(
      `operator-plan-${Date.now().toString(36)}.md`,
      [
        `Session ID: ${result.sessionId ?? "unknown"}`,
        `Turns: ${result.turns ?? "unknown"}`,
        "",
        result.text,
      ].join("\n"),
    );
  }

  private async writeFallbackPlan(thesis: VentureThesis): Promise<void> {
    const lines = [
      `# Runtime Plan for ${thesis.headline}`,
      "",
      "These tasks are the canonical shared state for Shark build iterations.",
      "",
      ...createPlanTasks(thesis).map((task) => {
        const tool = fallbackToolForTask(task.id);
        return `- [ ] ${task.id} | ${tool} | ${task.title} | ${task.description}`;
      }),
      "",
    ];
    await writeFile(this.runtimePlanPath(), lines.join("\n"));
  }

  private runtimePlanPath(): string {
    return join(this.config.workspaceDir, RUNTIME_PLAN_FILE);
  }

  private recentOperatorDirectives(): string[] {
    return this.state.recentEvents
      .filter((event) => event.kind === "operator_command")
      .slice(0, 5)
      .map((event) => event.message.replace(/^Operator command received:\s*/, ""));
  }

  private async executeTask(task: Task): Promise<string> {
    if (task.id.startsWith("operator_")) {
      return this.executeOperatorDirective(task);
    }

    switch (task.id) {
      case "create-thesis-dossier":
        await this.writeArtifact("startup-dossier.md", renderStartupDossier(this.state.thesis));
        return "Wrote startup dossier artifact";
      case "build-startup-foundation":
        return this.runWorkspaceAutonomyTask(
          task,
          [
            "Build the initial startup workspace foundation for the selected venture inside the current working directory.",
            "Create a deployable static product concept in ./startup-site with at least index.html, styles.css, and app.js.",
            "The product must be AI-native and aligned with the selected thesis.",
            "Include a clear auth surface in the UI and document a practical auth integration plan in ./startup-site/AUTH_IMPLEMENTATION.md.",
            "Do not add billing, monetization, or paid flows yet.",
            "End by summarizing exactly what files you created.",
          ].join(" "),
        );
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
      case "draft-legal-documents":
        return this.runWorkspaceAutonomyTask(
          task,
          [
            "Create legal starter documents for the selected startup.",
            "Write ./legal/TERMS.md and ./legal/PRIVACY.md.",
            "Make them practical startup drafts, but clearly mark any sections that need jurisdiction-specific legal review.",
            "Do not fabricate regulatory compliance claims.",
            "End by listing the files written.",
          ].join(" "),
        );
      case "draft-launch-assets":
        return this.runWorkspaceAutonomyTask(
          task,
          [
            "Create launch materials for the selected startup.",
            "Write ./launch/X_POSTS.md, ./launch/LINKEDIN_POST.md, and ./launch/VC_OUTREACH.md.",
            "Focus on product positioning, launch copy, and outreach drafts only.",
            "Do not actually post anywhere or send messages.",
            "End by listing the files written.",
          ].join(" "),
        );
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
        return this.runWorkspaceAutonomyTask(
          task,
          [
            `Handle this Shark task autonomously: ${task.title}.`,
            task.description,
            "Use the available Claude Agent SDK tools to create concrete outputs in the workspace when appropriate.",
            "If you cannot safely complete the task, write a concise execution brief explaining the blocker and the next action.",
          ].join(" "),
        );
    }
  }

  private async executeOperatorDirective(task: Task): Promise<string> {
    const routing = await this.selectToolForDirective(task.description);
    const selectedTool = normalizeToolName(routing.tool);

    this.state = withEvent(
      this.state,
      this.event("tool_called", `Claude routed operator task to ${selectedTool ?? "anthropic"}`, {
        tool: selectedTool ?? "anthropic",
      }),
    );

    switch (selectedTool) {
      case "browser-use": {
        const result = await this.browserUse.runTask(routing.action);
        await this.writeArtifact(
          `operator-${sanitizeFileFragment(task.id)}-browser.txt`,
          [
            `Action: ${routing.action}`,
            `Reason: ${routing.reason}`,
            `Task ID: ${result.task_id ?? result.id ?? "unknown"}`,
            `Status: ${result.status ?? "unknown"}`,
            `Live URL: ${result.liveUrl ?? result.live_url ?? "n/a"}`,
          ].join("\n"),
        );
        return `Operator directive sent to Browser Use (${result.task_id ?? result.id ?? "unknown"})`;
      }
      case "supermemory": {
        const result = await this.supermemory.addMemory(
          `Operator directive memory: ${task.description}`,
          "shark_operator_directives",
        );
        return `Operator directive stored in Supermemory (${result.status ?? "unknown"})`;
      }
      case "agentmail": {
        if (!this.state.mailboxAddress) {
          const mailbox = await this.agentMail.createMailbox();
          if (mailbox.address) {
            this.state.mailboxAddress = mailbox.address;
            return `Provisioned AgentMail inbox ${mailbox.address} for operator-directed work`;
          }

          return mailbox.error ?? "AgentMail mailbox provisioning failed";
        }

        await this.writeArtifact(
          `operator-${sanitizeFileFragment(task.id)}-agentmail.md`,
          [
            `Mailbox: ${this.state.mailboxAddress}`,
            `Requested action: ${routing.action}`,
            `Reason: ${routing.reason}`,
            "Current AgentMail adapter only provisions inboxes; outbound mail drafting remains a next integration step.",
          ].join("\n"),
        );
        return `Prepared AgentMail work note for ${this.state.mailboxAddress}`;
      }
      case "vercel": {
        const result = await this.vercel.deploy(process.cwd());
        await this.writeArtifact(
          `operator-${sanitizeFileFragment(task.id)}-vercel.txt`,
          [result.stdout, result.stderr].filter(Boolean).join("\n\n") || "No output",
        );
        return result.ok ? "Operator directive triggered Vercel deploy" : `Vercel deploy failed: ${result.stderr || result.stdout}`;
      }
      case "slack": {
        const result = await this.slack.postMessage(
          `Operator directive relayed by Shark:\n${task.description}`,
        );
        return result.ok ? "Relayed operator directive to Slack" : `Slack relay failed: ${result.error ?? "unknown error"}`;
      }
      case "daytona": {
        const result = await this.daytona.run(routing.action, process.cwd());
        await this.writeArtifact(
          `operator-${sanitizeFileFragment(task.id)}-daytona.txt`,
          [result.stdout, result.stderr].filter(Boolean).join("\n\n") || "No output",
        );
        return result.ok ? "Operator directive executed in Daytona runtime" : `Daytona command failed: ${result.stderr || result.stdout}`;
      }
      default:
        await this.writeArtifact(
          `operator-${sanitizeFileFragment(task.id)}-brief.md`,
          [
            `Fallback tool: ${routing.tool}`,
            `Suggested action: ${routing.action}`,
            `Reason: ${routing.reason}`,
            "",
            "No direct adapter path exists for the selected tool yet. The directive was preserved as an execution brief.",
          ].join("\n"),
        );
        return `Prepared execution brief for operator directive using ${routing.tool}`;
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
        if (this.state.thesis) {
          await this.applyOperatorDirectiveToPlan(command.text);
          this.state = withEvent(
            this.state,
            this.event("status_update", `Folded operator directive into runtime plan: ${command.text}`),
          );
        } else {
          this.state = withEvent(
            this.state,
            this.event("status_update", `Saved operator directive for the next planning cycle: ${command.text}`),
          );
        }
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

  private async recallMemoryContext(query: string): Promise<string> {
    if (!this.supermemory.isConfigured()) {
      return "No Supermemory context available.";
    }

    const snippets = [
      ...(await this.supermemory.recallSnippets(query, "shark_venture_thesis", 2)),
      ...(await this.supermemory.recallSnippets(query, "shark_runtime_plan", 2)),
    ]
      .map((snippet) => snippet.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (snippets.length === 0) {
      return "No relevant memory found.";
    }

    return Array.from(new Set(snippets))
      .slice(0, 4)
      .map((snippet) => `- ${snippet}`)
      .join("\n");
  }

  private async notify(message: string): Promise<void> {
    const slackMessage = await this.composeSlackStatusUpdate(message);
    const result = await this.slack.postMessage(slackMessage);
    const eventMessage = result.ok ? `Slack notified: ${message}` : `Slack notification skipped: ${result.error ?? "not configured"}`;
    this.state = withEvent(this.state, this.event("status_update", eventMessage, {
      surface: "slack",
      delivered: result.ok,
    }));
  }

  private markAgentTurns(turns?: number): void {
    if (typeof turns !== "number" || Number.isNaN(turns) || turns <= 0) {
      return;
    }

    this.state.totalAgentTurns += turns;
  }

  private formatSlackUpdateText(message: string): string {
    const headline = this.state.thesis?.headline ?? "No thesis selected yet";
    const pendingCount = this.state.tasks.filter((task) => task.status === "pending").length;
    const currentTask = this.state.currentTask?.title ?? "No active task";
    const statusLabel = classifySlackStatus(message);
    const tone = classifySlackTone(message);
    const elapsed = formatElapsed(this.state.startedAt);
    const turnLabel = `${this.state.totalAgentTurns} turn${this.state.totalAgentTurns === 1 ? "" : "s"}`;
    const opener = buildSlackOpener(tone, statusLabel);
    const messageBody = formatSlackBody(message);

    return [
      opener,
      "",
      messageBody,
      "",
      `• Runtime: ${elapsed}`,
      `• Agent turns: ${turnLabel}`,
      `• Mode: ${this.state.mode}`,
      `• Pending tasks: ${pendingCount}`,
      `• Current focus: ${currentTask}`,
      `• Thesis: ${headline}`,
      `• Run: ${this.state.runId}`,
    ].join("\n");
  }

  private async composeSlackStatusUpdate(message: string): Promise<string> {
    const elapsed = formatElapsed(this.state.startedAt);
    const currentTask = this.state.currentTask?.title ?? "No active task";
    const pendingCount = this.state.tasks.filter((task) => task.status === "pending").length;
    const result = await this.anthropic.runAgentPrompt(
      [
        "Rewrite this internal Shark status update into a natural Slack message from the agent to its operator.",
        "Sound like a capable founder giving a live update, not a dashboard.",
        "Vary the wording and structure from message to message.",
        "Use 1 or 2 fitting emojis.",
        "Mention what changed and what Shark is doing next.",
        "Do not use rigid labels like Mode:, Pending tasks:, Run:, or Current focus: as standalone field headers.",
        "Keep it concise and readable in Slack.",
        "",
        `Internal update: ${message}`,
        `Current mode: ${this.state.mode}`,
        `Pending tasks: ${pendingCount}`,
        `Current focus: ${currentTask}`,
        `Runtime so far: ${elapsed}`,
        `Agent turns so far: ${this.state.totalAgentTurns}`,
        `Current thesis: ${this.state.thesis?.headline ?? "No thesis selected yet"}`,
        "",
        "Return only the final Slack message text.",
      ].join("\n"),
      {
        maxTurns: 2,
        resume: false,
      },
    );
    this.markAgentTurns(result.turns);

    const text = result.text.trim();
    return text || this.formatSlackUpdateText(message);
  }

  private async composeSlackAcknowledgement(text: string): Promise<string> {
    const pendingCount = this.state.tasks.filter((task) => task.status === "pending").length;
    const result = await this.anthropic.runAgentPrompt(
      [
        "You are Shark replying in Slack to a human operator who just gave you an instruction.",
        "Acknowledge the instruction naturally and sound like a competent autonomous founder.",
        "Be warm, concise, and specific.",
        "Vary the phrasing. Do not use a canned template.",
        "Use 1 fitting emoji.",
        "If the loop is paused, say you captured it and are ready to act the moment the run resumes.",
        "If the loop is running, say you are folding it into the live run now.",
        "Never say 'manual run'.",
        "Do not claim work is complete yet.",
        "",
        `Instruction: ${text}`,
        `Loop running: ${this.state.isRunning ? "yes" : "no"}`,
        `Current mode: ${this.state.mode}`,
        `Pending tasks: ${pendingCount}`,
        `Latest summary: ${this.state.lastSummary ?? "No completed work yet."}`,
        "",
        "Return only the Slack reply text.",
      ].join("\n"),
      {
        maxTurns: 2,
        resume: false,
      },
    );
    this.markAgentTurns(result.turns);

    const reply = result.text.trim();
    if (reply) {
      return reply;
    }

    if (this.state.isRunning) {
      return "🦈 I picked that up and I’m folding it into the live run now.";
    }

    return "🦈 I’ve got it and I’m holding it until you tell me to resume.";
  }

  private async createExecutionBrief(task: Task): Promise<string> {
    const result = await this.anthropic.runAgentPrompt(
      [
        "You are Shark's control brain deciding which tool should be used for a single task.",
        "Choose from the available tools only.",
        "Prefer sdk whenever Claude can complete the work directly through built-in tools or connected MCP servers.",
        "Keep recommendations grounded in actual host-managed fallback capabilities when you do not choose sdk.",
        `Task ID: ${task.id}`,
        `Task: ${task.title}`,
        `Description: ${task.description}`,
        `Kind: ${task.kind}`,
        "",
        "Available tools:",
        this.renderToolCatalog(),
        "",
        "Reply in labeled lines: Tool, Action, Reason, Fallback.",
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    const parsed = parseLabeledLines(result.text);
    const selectedTool = normalizeToolName(parsed.tool);
    this.state = withEvent(
      this.state,
      this.event("tool_called", `Claude selected ${selectedTool ?? "anthropic"} for ${task.title}`, {
        tool: selectedTool ?? "anthropic",
      }),
    );

    return result.text;
  }

  private async runWorkspaceAutonomyTask(task: Task, instruction: string): Promise<string> {
    const memoryContext = await this.recallMemoryContext(
      [
        task.title,
        task.description,
        this.state.thesis?.headline ?? "",
        this.state.thesis?.problem ?? "",
      ].join(" | "),
    );
    const result = await this.anthropic.runAgentPrompt(
      [
        "You are Shark executing a real founder task.",
        "Before acting, search relevant memory and reuse prior decisions, artifacts, and constraints whenever possible.",
        `Task title: ${task.title}`,
        `Task type: ${task.kind}`,
        `Startup thesis: ${this.state.thesis?.headline ?? "Not selected yet"}`,
        `Customer: ${this.state.thesis?.targetCustomer ?? "Unknown"}`,
        `Problem: ${this.state.thesis?.problem ?? "Unknown"}`,
        "",
        "Relevant memory:",
        memoryContext,
        "",
        instruction,
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    await this.writeArtifact(
      `agent-run-${sanitizeFileFragment(task.id)}.md`,
      [
        `Session ID: ${result.sessionId ?? "unknown"}`,
        `Turns: ${result.turns ?? "unknown"}`,
        "",
        result.text,
      ].join("\n"),
    );

    return result.text;
  }

  private async selectToolForDirective(text: string): Promise<{
    tool: string;
    action: string;
    reason: string;
  }> {
    const result = await this.anthropic.runAgentPrompt(
      [
        "You are Shark's tool router for an operator directive.",
        "Pick the single best tool that should handle this request first.",
        "Only choose a tool whose available actions match the request.",
        "",
        "Available tools:",
        this.renderToolCatalog(),
        "",
        `Directive: ${text}`,
        "",
        "Reply in labeled lines: Tool, Action, Reason.",
      ].join("\n"),
    );
    this.markAgentTurns(result.turns);

    const fields = parseLabeledLines(result.text);
    return {
      tool: fields.tool ?? "anthropic",
      action: fields.action ?? text,
      reason: fields.reason ?? "No reason provided",
    };
  }

  private renderToolCatalog(): string {
    return this.availableTools()
      .map((tool) => [
        `- ${tool.name} (${tool.status})`,
        `  Purpose: ${tool.purpose}`,
        `  Actions: ${tool.actions.join(", ")}`,
      ].join("\n"))
      .join("\n");
  }

  private availableTools(): Array<{
    name: ToolName;
    status: "ready" | "unconfigured";
    purpose: string;
    actions: string[];
  }> {
    return [
      {
        name: "supermemory",
        status: this.supermemory.isConfigured() ? "ready" : "unconfigured",
        purpose: "Persist and retrieve long-term founder memory.",
        actions: ["add memory", "search memory"],
      },
      {
        name: "browser-use",
        status: this.browserUse.isConfigured() ? "ready" : "unconfigured",
        purpose: "Run browser research and web workflows.",
        actions: ["run browser task"],
      },
      {
        name: "agentmail",
        status: this.agentMail.isConfigured() ? "ready" : "unconfigured",
        purpose: "Provision and manage the agent inbox surface.",
        actions: ["create mailbox", "ingest inbound email webhook"],
      },
      {
        name: "vercel",
        status: this.vercel.isConfigured() ? "ready" : "unconfigured",
        purpose: "Inspect projects and trigger deployments.",
        actions: ["list projects", "deploy current workspace"],
      },
      {
        name: "slack",
        status: this.slack.isConfigured() ? "ready" : "unconfigured",
        purpose: "Notify the operator and mirror important progress.",
        actions: ["post message"],
      },
      {
        name: "daytona",
        status: "ready",
        purpose: "Execute shell commands inside the current runtime context.",
        actions: ["run shell command"],
      },
      {
        name: "anthropic",
        status: this.anthropic.isConfigured() ? "ready" : "unconfigured",
        purpose: "Reason about planning, routing, and task execution.",
        actions: ["generate execution brief", "choose tool"],
      },
      {
        name: "convex",
        status: this.config.convexUrl ? "ready" : "unconfigured",
        purpose: "Persist runtime state and operator telemetry.",
        actions: ["store run state"],
      },
    ];
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
      id: "build-startup-foundation",
      title: "Build startup foundation",
      description: "Use the Agent SDK to create the initial startup workspace and product foundation",
      kind: "artifact",
      mode: "building",
      priority: 85,
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
      id: "draft-legal-documents",
      title: "Draft legal documents",
      description: "Create initial terms and privacy policy drafts in the workspace",
      kind: "artifact",
      mode: "building",
      priority: 58,
      blockedByApproval: false,
      status: "pending",
      updatedAt: now,
    },
    {
      id: "draft-launch-assets",
      title: "Draft launch assets",
      description: "Create initial launch copy for X, LinkedIn, and VC outreach",
      kind: "artifact",
      mode: "building",
      priority: 54,
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

function classifySlackStatus(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("blocked") || lower.includes("approval")) {
    return "Needs Attention";
  }

  if (lower.includes("selected startup thesis")) {
    return "Venture Locked";
  }

  if (lower.includes("task completed")) {
    return "Task Complete";
  }

  if (lower.includes("wrapped up")) {
    return "Progress Report";
  }

  if (lower.includes("operating check")) {
    return "Ops Pulse";
  }

  return "Update";
}

function classifySlackTone(message: string): "success" | "attention" | "neutral" {
  const lower = message.toLowerCase();
  if (lower.includes("blocked") || lower.includes("approval") || lower.includes("failed")) {
    return "attention";
  }

  if (lower.includes("wrapped up") || lower.includes("completed") || lower.includes("selected startup thesis")) {
    return "success";
  }

  return "neutral";
}

function buildSlackOpener(tone: "success" | "attention" | "neutral", statusLabel: string): string {
  if (tone === "attention") {
    return "⚠️ I need your attention on this step.";
  }

  if (tone === "success") {
    return `✅ ${statusLabel}`;
  }

  return `🦈 ${statusLabel}`;
}

function formatSlackBody(message: string): string {
  const cleaned = message.trim();
  const parts = cleaned.split(/(?:\s+Why now:\s*|\s+Result:\s*)/i);

  if (parts.length >= 3) {
    const [summary, whyNow, ...rest] = parts;
    const result = rest.join(" Result: ");
    return [
      `I just finished: ${escapeSlackMrkdwn(summary.trim().replace(/\.$/, ""))}`,
      "",
      "Why this mattered:",
      `• ${escapeSlackMrkdwn(whyNow.trim().replace(/\.$/, ""))}`,
      "",
      "What happened:",
      `• ${escapeSlackMrkdwn(result.trim())}`,
    ].join("\n");
  }

  const taskCompleteMatch = cleaned.match(/^Task completed:\s*(.+)$/i);
  if (taskCompleteMatch) {
    return [
      `I just finished: ${escapeSlackMrkdwn(taskCompleteMatch[1]?.trim() ?? cleaned)}`,
      "",
      "What happens next:",
      "• I will keep moving through the highest-leverage pending task unless you redirect me.",
    ].join("\n");
  }

  return escapeSlackMrkdwn(cleaned);
}

function formatElapsed(startedAt: string): string {
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) {
    return "unknown";
  }

  const elapsedMs = Math.max(0, Date.now() - startMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

function deriveRunStartedAt(state: RunState): string {
  const candidates = [
    state.thesis?.selectedAt,
    ...state.recentEvents.map((event) => event.timestamp),
    state.lastIterationAt,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const sorted = candidates
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((item) => !Number.isNaN(item.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);

  return sorted[0]?.value ?? new Date().toISOString();
}

function isFailureSummary(summary: string): boolean {
  const lower = summary.toLowerCase();
  return [
    "failed",
    "error",
    "blocked",
    "skipped",
    "requires a human-managed",
  ].some((token) => lower.includes(token));
}

function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parsePlanLine(line: string): {
  checked: boolean;
  id: string;
  preferredTool: string;
  title: string;
  description: string;
} | null {
  const match = line.match(/^- \[( |x)\] ([a-z0-9-]+) \| ([a-z0-9-]+) \| ([^|]+) \| (.+)$/);
  if (!match) {
    return null;
  }

  return {
    checked: match[1] === "x",
    id: match[2].trim(),
    preferredTool: match[3].trim(),
    title: match[4].trim(),
    description: match[5].trim(),
  };
}

function taskKindForTool(tool: string): Task["kind"] {
  switch (tool) {
    case "browser-use":
      return "research";
    case "supermemory":
      return "memory";
    case "slack":
      return "messaging";
    case "vercel":
      return "deployment";
    case "sdk":
      return "artifact";
    default:
      return "operations";
  }
}

function fallbackToolForTask(taskId: string): string {
  switch (taskId) {
    case "create-thesis-dossier":
    case "build-startup-foundation":
    case "draft-legal-documents":
    case "draft-launch-assets":
      return "sdk";
    case "create-agentmail-inbox":
      return "agentmail";
    case "sync-thesis-memory":
      return "sdk";
    case "browser-market-research":
      return "sdk";
    case "publish-slack-brief":
      return "slack";
    case "probe-vercel":
      return "vercel";
    case "run-smoke-checks":
      return "daytona";
    default:
      return "sdk";
  }
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

function normalizeToolName(value: string | undefined): ToolName | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
    case "daytona":
    case "supermemory":
    case "convex":
    case "browser-use":
    case "agentmail":
    case "slack":
    case "vercel":
      return normalized;
    default:
      return undefined;
  }
}

function sanitizeFileFragment(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function joinAddresses(value?: string[]): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "Unknown";
  }

  return value.join(", ");
}

function renderInboundEmailArtifact(payload: AgentMailWebhookPayload): string {
  const email = payload.message;
  if (!email) {
    return "# Inbound Email\n\nNo message payload received.";
  }

  const attachments = email.attachments ?? [];

  return [
    "# Inbound Email",
    "",
    `Event: ${payload.event_type ?? "unknown"}`,
    `Event ID: ${payload.event_id ?? "unknown"}`,
    `Thread ID: ${email.thread_id ?? "unknown"}`,
    `Message ID: ${email.message_id ?? "unknown"}`,
    `Inbox ID: ${email.inbox_id ?? "unknown"}`,
    `From: ${joinAddresses(email.from_)}`,
    `To: ${joinAddresses(email.to)}`,
    `CC: ${joinAddresses(email.cc)}`,
    `Reply-To: ${joinAddresses(email.reply_to)}`,
    `Subject: ${email.subject ?? "No subject"}`,
    `Preview: ${email.preview ?? "n/a"}`,
    `Timestamp: ${email.timestamp ?? email.created_at ?? "unknown"}`,
    `In-Reply-To: ${email.in_reply_to ?? "n/a"}`,
    "",
    "## Labels",
    ...(email.labels?.length ? email.labels.map((label) => `- ${label}`) : ["- none"]),
    "",
    "## Attachments",
    ...(attachments.length
      ? attachments.map((attachment) => [
        `- ${attachment.filename ?? attachment.attachment_id ?? "unnamed attachment"}`,
        `  Type: ${attachment.content_type ?? "unknown"}`,
        `  Size: ${attachment.size ?? 0}`,
        `  Inline: ${attachment.inline ? "yes" : "no"}`,
      ].join("\n"))
      : ["- none"]),
    "",
    "## Text Body",
    email.text?.trim() || email.preview?.trim() || "No text body provided.",
    "",
    "## HTML Body",
    email.html?.trim() || "No HTML body provided.",
  ].join("\n");
}

function buildInboundEmailDirective(payload: AgentMailWebhookPayload): string {
  const email = payload.message;
  if (!email) {
    return "Review the inbound AgentMail event and decide if action is needed.";
  }

  const attachments = email.attachments ?? [];

  return [
    "A new inbound email arrived. Review it and decide the next highest-leverage follow-up.",
    `From: ${joinAddresses(email.from_)}`,
    `To: ${joinAddresses(email.to)}`,
    `Subject: ${email.subject ?? "No subject"}`,
    `Thread ID: ${email.thread_id ?? "unknown"}`,
    `Message ID: ${email.message_id ?? "unknown"}`,
    email.in_reply_to ? `In reply to: ${email.in_reply_to}` : "This may start a new thread.",
    "",
    "Email preview:",
    email.preview?.trim() || "No preview provided.",
    "",
    "Email body:",
    email.text?.trim() || "No text body provided.",
    "",
    "Attachments:",
    ...(attachments.length
      ? attachments.map((attachment) =>
        `- ${attachment.filename ?? attachment.attachment_id ?? "unnamed attachment"} (${attachment.content_type ?? "unknown"})`,
      )
      : ["- none"]),
    "",
    "Use the current workspace, memory, and available tools to decide whether to reply, update the plan, or wait for operator direction.",
  ].join("\n");
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

function renderOperatorSummary(task: Task, rawOutput: string, failed: boolean, reason: string): string {
  const normalized = rawOutput.trim();
  const sentences = normalized
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const conciseDetail = (sentences[0] ?? normalized ?? "No additional detail.").slice(0, 220);

  if (failed) {
    return [
      `I hit a blocker while working on ${task.title}.`,
      `Reason: ${reason}.`,
      `Current issue: ${conciseDetail}`,
      "I left the task open so I can retry or adjust the plan next turn.",
    ].join(" ");
  }

  return [
    `I wrapped up ${task.title}.`,
    `Why now: ${reason}.`,
    `Result: ${conciseDetail}`,
    "I am moving straight to the next highest-leverage task.",
  ].join(" ");
}
