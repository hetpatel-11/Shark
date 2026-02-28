import {
  type ApprovalRequest,
  type RunState,
  SHARK_MODES,
  type SharkEvent,
  type SharkMode,
  type Task,
  type ToolAction,
} from "../contracts.js";

export function createInitialRunState(runId: string): RunState {
  return {
    runId,
    mode: "discovery",
    queuedCommands: [],
    recentEvents: [],
  };
}

export function transitionMode(state: RunState, nextMode: SharkMode): RunState {
  if (!SHARK_MODES.includes(nextMode)) {
    return state;
  }

  return withEvent(state, {
    id: createEventId("mode"),
    kind: "mode_changed",
    message: `Mode changed to ${nextMode}`,
    timestamp: new Date().toISOString(),
    metadata: { nextMode },
  });
}

export function beginTask(state: RunState, task: Task): RunState {
  const next: RunState = {
    ...state,
    currentTask: {
      ...task,
      status: "in_progress",
    },
  };

  return withEvent(next, {
    id: createEventId("task"),
    kind: "task_started",
    message: `Started task: ${task.title}`,
    timestamp: new Date().toISOString(),
    metadata: { taskId: task.id, priority: task.priority },
  });
}

export function completeTask(state: RunState, summary: string): RunState {
  if (!state.currentTask) {
    return state;
  }

  const next: RunState = {
    ...state,
    currentTask: {
      ...state.currentTask,
      status: "completed",
    },
  };

  return withEvent(next, {
    id: createEventId("task"),
    kind: "task_completed",
    message: summary,
    timestamp: new Date().toISOString(),
    metadata: { taskId: state.currentTask.id },
  });
}

export function blockForApproval(
  state: RunState,
  approval: ApprovalRequest,
): RunState {
  const next: RunState = {
    ...state,
    mode: "blocked",
    pendingApproval: approval,
  };

  return withEvent(next, {
    id: createEventId("approval"),
    kind: "approval_requested",
    message: approval.reason,
    timestamp: new Date().toISOString(),
    metadata: { approvalId: approval.id, action: approval.action },
  });
}

export function canExecuteTool(action: ToolAction): boolean {
  return !action.requiresApproval || action.riskLevel !== "critical";
}

export function withEvent(state: RunState, event: SharkEvent): RunState {
  const recentEvents = [event, ...state.recentEvents].slice(0, 50);
  const nextMode = event.kind === "mode_changed"
    ? extractMode(event.metadata?.nextMode)
    : state.mode;

  return {
    ...state,
    mode: nextMode,
    recentEvents,
  };
}

function extractMode(value: unknown): SharkMode {
  if (typeof value === "string" && SHARK_MODES.includes(value as SharkMode)) {
    return value as SharkMode;
  }

  return "discovery";
}

function createEventId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
