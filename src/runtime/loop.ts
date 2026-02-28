import type { RunState, SharkMode, Task } from "../contracts.js";
import {
  beginTask,
  blockForApproval,
  completeTask,
  transitionMode,
} from "./state.js";

export interface LoopDecision {
  nextMode: SharkMode;
  selectedTask?: Task;
  requiresApproval?: {
    action: string;
    reason: string;
  };
  summary: string;
}

export function applyDecision(
  state: RunState,
  decision: LoopDecision,
): RunState {
  if (decision.requiresApproval) {
    return blockForApproval(state, {
      id: `approval_${Date.now()}`,
      action: decision.requiresApproval.action,
      reason: decision.requiresApproval.reason,
      riskLevel: "critical",
      status: "pending",
      requestedAt: new Date().toISOString(),
    });
  }

  let next = transitionMode(state, decision.nextMode);

  if (decision.selectedTask) {
    next = beginTask(next, decision.selectedTask);
    next = completeTask(next, decision.summary);
  }

  return next;
}

export function defaultNextMode(state: RunState): SharkMode {
  if (!state.thesis) {
    return "discovery";
  }

  if (state.pendingApproval?.status === "pending") {
    return "blocked";
  }

  if (state.currentTask?.status === "in_progress") {
    return state.currentTask.mode;
  }

  return "planning";
}
