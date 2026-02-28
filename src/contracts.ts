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

export const TASK_KINDS = [
  "research",
  "memory",
  "messaging",
  "deployment",
  "operations",
  "artifact",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

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
  anthropicApiKey?: string;
  anthropicModel: string;
  daytonaApiKey?: string;
  supermemoryApiKey?: string;
  convexDeployment?: string;
  convexUrl?: string;
  convexDeployKey?: string;
  browserUseApiKey?: string;
  agentMailApiKey?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackChannel?: string;
  vercelToken?: string;
  openAiApiKey?: string;
  loopIntervalMs: number;
  port: number;
  stateFile: string;
  workspaceDir: string;
  autoStart: boolean;
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
  kind: TaskKind;
  mode: Exclude<SharkMode, "blocked">;
  priority: number;
  blockedByApproval: boolean;
  status: "pending" | "in_progress" | "completed" | "failed";
  output?: string;
  updatedAt: string;
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
  mailboxAddress?: string;
  tasks: Task[];
  queuedCommands: OperatorCommand[];
  recentEvents: SharkEvent[];
  providerHealth: Partial<Record<ToolName, ProviderHealth>>;
  lastSummary?: string;
  isRunning: boolean;
  lastIterationAt?: string;
}

export interface ToolAction {
  tool: ToolName;
  action: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface ProviderHealth {
  ok: boolean;
  checkedAt: string;
  message: string;
}

export interface DashboardSnapshot {
  runId: string;
  mode: SharkMode;
  isRunning: boolean;
  thesis?: VentureThesis;
  mailboxAddress?: string;
  currentTask?: Task;
  pendingTasks: Task[];
  pendingApproval?: ApprovalRequest;
  providerHealth: Partial<Record<ToolName, ProviderHealth>>;
  queuedCommands: OperatorCommand[];
  lastSummary?: string;
  recentEvents: SharkEvent[];
  lastIterationAt?: string;
  storage: "file" | "convex";
}
