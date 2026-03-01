import { mkdir } from "node:fs/promises";

import { query, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { SharkConfig } from "../contracts.js";

interface AgentRunResult {
  text: string;
  sessionId?: string;
  turns?: number;
}

interface AgentRunOptions {
  maxTurns?: number;
  resume?: boolean;
}

export class AnthropicAdapter {
  private lastSessionId?: string;

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

    try {
      const stream = query({
        prompt,
        options: {
          cwd: this.config.workspaceDir,
          additionalDirectories: [process.cwd()],
          executable: "bun",
          model: normalizeModel(this.config.anthropicModel),
          tools: {
            type: "preset",
            preset: "claude_code",
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
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildSystemPrompt(),
          },
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
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: this.config.anthropicApiKey,
            ANTHROPIC_MODEL: this.config.anthropicModel,
            CLAUDE_AGENT_SDK_CLIENT_APP: "shark/0.1.0",
          },
          settingSources: ["project"],
          maxTurns: options.maxTurns ?? 12,
          resume: options.resume === false ? undefined : this.lastSessionId,
        },
      });

      return await collectResult(stream, (sessionId) => {
        if (options.resume !== false) {
          this.lastSessionId = sessionId;
        }
      });
    } catch (error) {
      return {
        text: buildFallbackResponse(
          prompt,
          error instanceof Error ? error.message : "Unknown Agent SDK failure",
        ),
      };
    }
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
  const suffix = reason ? `\n\nFallback reason: ${reason}` : "";
  return [
    "Startup: AI revenue operations control tower for SMBs",
    "Customer: founder-led SMBs with 5-100 employees",
    "Problem: revenue, hiring, and cash workflows are fragmented across too many tools",
    "Product: one AI-native command center that automates lead routing, collections, onboarding, and back-office follow-up",
    "Why now: agents can now execute across email, browser, and internal tools continuously",
    "Moat: proprietary workflow memory and execution history compound into better operating playbooks",
    `Prompt context: ${prompt.slice(0, 160)}`,
    suffix,
  ].join("\n");
}
