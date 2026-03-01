import { mkdir } from "node:fs/promises";

import { query, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { SharkConfig } from "../contracts.js";

interface AgentRunResult {
  text: string;
  sessionId?: string;
  turns?: number;
  aborted?: boolean;
}

interface AgentRunOptions {
  maxTurns?: number;
  resume?: boolean;
  lightweight?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export class AnthropicAdapter {
  private lastSessionId?: string;
  private activeAbortController?: AbortController;
  private activeQuery?: ReturnType<typeof query>;

  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.anthropicApiKey);
  }

  async generateText(prompt: string): Promise<string> {
    const result = await this.runAgentPrompt(prompt);
    return result.text;
  }

  async runAgentPrompt(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (!this.config.anthropicApiKey) {
      return {
        text: buildFallbackResponse(prompt),
      };
    }

    await mkdir(this.config.workspaceDir, { recursive: true });
    const retries = Math.max(0, options.retries ?? 1);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const lightweight = options.lightweight === true;
        const abortController = new AbortController();
        const timeoutMs = options.timeoutMs ?? (lightweight ? 45_000 : 300_000);
        const stream = query({
          prompt,
          options: {
            abortController,
            cwd: this.config.workspaceDir,
            executable: "bun",
            model: normalizeModel(this.config.anthropicModel),
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: buildSystemPrompt(),
            },
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: this.config.anthropicApiKey,
              ANTHROPIC_MODEL: this.config.anthropicModel,
              CLAUDE_AGENT_SDK_CLIENT_APP: "shark/0.1.0",
            },
            ...(lightweight
              ? {
                  maxTurns: options.maxTurns ?? 2,
                  resume: undefined,
                }
              : {
                  additionalDirectories: [process.cwd()],
                  tools: {
                    type: "preset" as const,
                    preset: "claude_code" as const,
                  },
                  allowedTools: [
                    "Read",
                    "Write",
                    "Edit",
                    "Bash",
                    "Glob",
                    "Grep",
                    "WebSearch",
                    "WebFetch",
                    "Task",
                  ],
                  permissionMode: "bypassPermissions" as const,
                  allowDangerouslySkipPermissions: true,
                  agents: {
                    researcher: {
                      description: "Focused web and competitive intelligence subagent.",
                      prompt: [
                        "Use web research tools to gather current market context, competitors, positioning, and regulatory context.",
                        "Return concise summaries with practical next actions.",
                      ].join(" "),
                      tools: ["WebSearch", "WebFetch", "Read", "Write"],
                    },
                    builder: {
                      description: "Focused code and shipping subagent.",
                      prompt: [
                        "Use filesystem and shell tools to build artifacts, code, docs, and deployable assets inside the Shark workspace.",
                        "Prefer concrete outputs over abstract plans.",
                      ].join(" "),
                      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
                    },
                  },
                  mcpServers: buildMcpServers(this.config),
                  settingSources: ["project"],
                  maxTurns: options.maxTurns ?? 12,
                  resume: options.resume === false ? undefined : this.lastSessionId,
                }),
          },
        });
        this.activeAbortController = abortController;
        this.activeQuery = stream;
        const timeoutHandle = setTimeout(() => {
          try {
            abortController.abort();
            stream.close();
          } catch {
            // Best-effort timeout cleanup.
          }
        }, timeoutMs);

        let result: AgentRunResult;
        try {
          result = await collectResult(stream, (sessionId) => {
            if (options.resume !== false) {
              this.lastSessionId = sessionId;
            }
          });
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (isNonTextResult(result.text) && attempt < retries) {
          continue;
        }

        return result;
      } catch (error) {
        if (this.activeAbortController?.signal.aborted) {
          return {
            text: "Agent run interrupted by operator",
            aborted: true,
          };
        }

        if (attempt < retries) {
          continue;
        }

        return {
          text: buildFallbackResponse(
            prompt,
            error instanceof Error ? error.message : "Unknown Agent SDK failure",
          ),
        };
      } finally {
        this.activeAbortController = undefined;
        this.activeQuery = undefined;
      }
    }

    return {
      text: buildFallbackResponse(prompt, "Exhausted Agent SDK retries"),
    };
  }

  abortActiveRun(): boolean {
    if (!this.activeAbortController) {
      return false;
    }

    try {
      this.activeAbortController.abort();
      this.activeQuery?.close();
    } catch {
      // Swallow cancellation cleanup failures; the caller only needs a best-effort interrupt.
    }

    return true;
  }
}

async function collectResult(
  stream: AsyncIterable<SDKMessage>,
  onSession: (sessionId: string) => void,
): Promise<AgentRunResult> {
  let sessionId: string | undefined;
  let turns: number | undefined;
  let resultText = "";
  let assistantText = "";

  for await (const message of stream) {
    if ("session_id" in message && typeof message.session_id === "string") {
      sessionId = message.session_id;
      onSession(sessionId);
    }

    if (message.type === "assistant") {
      assistantText = extractAssistantText(message);
      continue;
    }

    if (message.type === "result" && message.subtype === "success") {
      turns = message.num_turns;
      resultText = message.result?.trim() || assistantText;
    }
  }

  return {
    text: resultText || assistantText || "Agent SDK completed without a textual summary.",
    sessionId,
    turns,
  };
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
        return typeof block.text === "string" ? block.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeModel(model: string): string {
  if (model === "claude-sonnet-4-20250514") {
    return "claude-sonnet-4-6";
  }

  return model;
}

function buildSystemPrompt(): string {
  return [
    "You are Shark, an autonomous founder and operator running inside a controlled production sandbox.",
    "You may read files, edit files, write code, run shell commands, and use web tools autonomously.",
    "Use your tools to produce concrete outputs: code, launch assets, legal docs, research briefs, and deployable artifacts.",
    "Use connected MCP servers directly whenever they are available. Prefer direct MCP tool calls over describing work for the host to perform later.",
    "When an external system is not connected through MCP, fall back to the host-managed integrations for AgentMail, Slack, Vercel, Convex state, and Daytona.",
    "Vercel, Browser Use, Supermemory, and AgentMail may be available directly through MCP depending on current configuration.",
    "Convex is the durable runtime state store in this build. Treat Convex persistence as host-managed rather than assuming direct Convex MCP tool access.",
    "When the prompt includes a 'Relevant memory' section, treat it as retrieved long-term memory and incorporate it before making new plans.",
    "Operator commands may include file or media URLs supplied through Slack. Treat those URLs as operator-provided inputs and use them only for legitimate instructed workflows.",
    "Do not attempt to bypass authentication, evade security controls, break terms of service, or create paid commitments.",
    "If an external action still requires host-managed tooling, describe the best next action clearly so the runtime can invoke the correct integration.",
    "No money-making or billing flows should be created yet. Focus on research, product build-out, operations, legal docs, and distribution setup.",
  ].join(" ");
}

function buildMcpServers(config: SharkConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (config.browserUseApiKey) {
    servers["browser-use"] = {
      type: "http",
      url: "https://api.browser-use.com/mcp",
      headers: {
        "X-Browser-Use-API-Key": config.browserUseApiKey,
      },
    };
  }

  if (config.supermemoryApiKey) {
    servers.supermemory = {
      type: "http",
      url: "https://mcp.supermemory.ai/mcp",
      headers: {
        Authorization: `Bearer ${config.supermemoryApiKey}`,
      },
    };
  }

  if (config.agentMailApiKey) {
    servers.agentmail = {
      type: "stdio",
      command: "npx",
      args: ["-y", "agentmail-mcp"],
      env: {
        ...process.env,
        AGENTMAIL_API_KEY: config.agentMailApiKey,
      },
    };
  }

  if (config.vercelToken) {
    servers.vercel = {
      type: "http",
      url: "https://mcp.vercel.com/",
      headers: {
        Authorization: `Bearer ${config.vercelToken}`,
      },
    };
  }

  return servers;
}

function buildFallbackResponse(prompt: string, reason?: string): string {
  const fallbackReason = reason ?? "Agent runtime unavailable";

  if (prompt.includes("Return only the Slack reply text.")) {
    return "🦈 I hit a brief agent-runtime hiccup, but I captured that instruction and I’m keeping it in the loop.";
  }

  if (prompt.includes("Return only the final Slack message text.")) {
    const update = extractLineValue(prompt, "Internal update:");
    if (update) {
      return `🦈 Quick update: ${update}`;
    }
    return "🦈 Quick update: I hit a brief agent-runtime hiccup while formatting this message, but the run is still active.";
  }

  if (fallbackReason.includes("SIGKILL")) {
    return "The agent runtime was interrupted during this step. Continue from the existing plan and artifacts.";
  }

  return "The agent runtime could not finish this step cleanly. Continue from the existing plan and artifacts.";
}

function isNonTextResult(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized === "" || normalized === "Agent SDK completed without a textual summary.";
}

function extractLineValue(prompt: string, label: string): string | undefined {
  for (const line of prompt.split("\n")) {
    if (line.startsWith(label)) {
      return line.slice(label.length).trim();
    }
  }

  return undefined;
}
