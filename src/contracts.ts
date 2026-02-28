export const SHARK_MODES = [
  "discovery",
  "planning",
  "building",
  "operating",
  "blocked",
] as const;

export type SharkMode = (typeof SHARK_MODES)[number];

export const RISK_LEVELS = ["low", "medium", "critical"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export type ToolName =
  | "anthropic"
  | "daytona"
  | "supermemory"
  | "convex"
  | "browser-use"
  | "agentmail"
  | "slack"
  | "vercel";

export interface SharkConfig {
  anthropicApiKey: string;
  daytonaApiKey: string;
  supermemoryApiKey: string;
  convexDeployment: string;
  convexUrl: string;
  browserUseApiKey: string;
  agentMailApiKey: string;
  slackBotToken: string;
  slackAppToken: string;
  vercelToken: string;
  openAiApiKey: string;
}

export interface OpportunityScore {
  marketSize: number;
  speedToLaunch: number;
  defensibility: number;
  aiLeverage: number;
  distributionPotential: number;
  composite: number;
}

export interface VentureThesis {
  id: string;
  headline: string;
  targetCustomer: string;
  problem: string;
  productShape: string;
  whyNow: string;
  moatHypothesis: string;
  score: OpportunityScore;
  selectedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  mode: Exclude<SharkMode, "blocked">;
  priority: number;
  blockedByApproval: boolean;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface ApprovalRequest {
  id: string;
  action: string;
  reason: string;
  riskLevel: Extract<RiskLevel, "critical">;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
}

export interface OperatorCommand {
  id: string;
  source: "slack" | "ui";
  text: string;
  createdAt: string;
}

export interface SharkEvent {
  id: string;
  kind:
    | "mode_changed"
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "tool_called"
    | "deployment"
    | "public_post"
    | "approval_requested"
    | "operator_command"
    | "status_update";
  message: string;
  timestamp: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface RunState {
  runId: string;
  mode: SharkMode;
  thesis?: VentureThesis;
  currentTask?: Task;
  pendingApproval?: ApprovalRequest;
  queuedCommands: OperatorCommand[];
  recentEvents: SharkEvent[];
}

export interface ToolAction {
  tool: ToolName;
  action: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}
