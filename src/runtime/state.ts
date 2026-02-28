import {
  type ApprovalRequest,
  type ProviderHealth,
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
    tasks: [],
    queuedCommands: [],
    recentEvents: [],
    providerHealth: {},
    isRunning: false,
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
  const updatedAt = new Date().toISOString();
  const next: RunState = {
    ...state,
    currentTask: {
      ...task,
      status: "in_progress",
      updatedAt,
    },
    tasks: state.tasks.map((item) =>
      item.id === task.id
        ? {
            ...item,
            status: "in_progress",
            updatedAt,
          }
        : item,
    ),
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

  const updatedAt = new Date().toISOString();
  const next: RunState = {
    ...state,
    currentTask: {
      ...state.currentTask,
      status: "completed",
      output: summary,
      updatedAt,
    },
    tasks: state.tasks.map((item) =>
      item.id === state.currentTask?.id
        ? {
            ...item,
            status: "completed",
            output: summary,
            updatedAt,
          }
        : item,
    ),
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

export function queueTask(state: RunState, task: Task): RunState {
  return {
    ...state,
    tasks: [...state.tasks, task].sort((left, right) => right.priority - left.priority),
  };
}

export function setProviderHealth(
  state: RunState,
  tool: ToolAction["tool"],
  health: ProviderHealth,
): RunState {
  return {
    ...state,
    providerHealth: {
      ...state.providerHealth,
      [tool]: health,
    },
  };
}

export function enqueueCommand(
  state: RunState,
  command: RunState["queuedCommands"][number],
): RunState {
  return {
    ...state,
    queuedCommands: [...state.queuedCommands, command],
  };
}

export function clearCommands(state: RunState): RunState {
  return {
    ...state,
    queuedCommands: [],
  };
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
    lastIterationAt: event.timestamp,
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
