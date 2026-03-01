import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { loadConfig, maskSecret } from "./config.js";
import { SlackChatBot } from "./integrations/slack-chat.js";
import { ConvexStateStore } from "./runtime/convex-store.js";
import { SharkEngine } from "./runtime/engine.js";
import { FileStateStore } from "./runtime/file-store.js";
import type { StateStore } from "./runtime/store.js";

const config = loadConfig();
const store: StateStore = config.convexUrl
  ? new ConvexStateStore(config.convexUrl, config.stateFile)
  : new FileStateStore(config.stateFile);
const engine = new SharkEngine(config, store);
const slackBot = new SlackChatBot(
  config,
  (text) => engine.handleSlackInstruction(text),
);

const args = new Set(process.argv.slice(2));

await engine.init();
await slackBot.start();

if (args.has("--smoke")) {
  const snapshot = await engine.smoke();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  process.exit(0);
}

const server = createServer(async (request, response) => {
  const url = request.url ?? "/";
  const method = request.method ?? "GET";

  if (
    method === "OPTIONS"
    && (url.startsWith("/api/") || url.startsWith("/agentmail/"))
  ) {
    return sendEmpty(response, 204);
  }

  if (method === "GET" && url === "/healthz") {
    return sendJson(response, 200, {
      ok: true,
      mode: engine.snapshot().mode,
      runId: engine.snapshot().runId,
    });
  }

  if (method === "GET" && url === "/api/state") {
    return sendJson(response, 200, engine.snapshot());
  }

  if (method === "POST" && url === "/api/run-once") {
    const snapshot = await engine.runOnce("manual");
    return sendJson(response, 200, snapshot);
  }

  if (method === "POST" && url === "/api/start") {
    engine.start();
    return sendJson(response, 200, engine.snapshot());
  }

  if (method === "POST" && url === "/api/stop") {
    engine.stop();
    return sendJson(response, 200, engine.snapshot());
  }

  if (method === "POST" && url === "/agentmail/webhooks") {
    const body = await readBody(request);
    let payload: unknown;
    try {
      payload = body.length > 0 ? JSON.parse(body) : {};
    } catch {
      return sendJson(response, 400, { error: "Invalid JSON" });
    }

    void engine.ingestInboundEmail(payload as Parameters<SharkEngine["ingestInboundEmail"]>[0]).catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`AgentMail webhook processing failed: ${message}\n`);
    });

    return sendJson(response, 200, { ok: true });
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(config.port, () => {
  const summary = [
    `Shark listening on http://localhost:${config.port}`,
    `State file: ${config.stateFile}`,
    `Workspace: ${config.workspaceDir}`,
    `Storage: ${store.kind}`,
    `Slack control: ${slackBot.isEnabled() ? "Socket Mode enabled" : "disabled (missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN)"}`,
    "AgentMail webhook: /agentmail/webhooks",
    `Anthropic: ${maskSecret(config.anthropicApiKey)}`,
    `Supermemory: ${maskSecret(config.supermemoryApiKey)}`,
    `Browser Use: ${maskSecret(config.browserUseApiKey)}`,
    `AgentMail: ${maskSecret(config.agentMailApiKey)}`,
    `Slack: ${maskSecret(config.slackBotToken)}`,
    `Vercel: ${maskSecret(config.vercelToken)}`,
  ].join("\n");
  process.stdout.write(`${summary}\n`);

  if (config.autoStart) {
    engine.start();
    void engine.runOnce("startup");
  }
});

process.on("SIGINT", () => {
  engine.stop();
  void slackBot.stop().finally(() => {
    server.close(() => process.exit(0));
  });
});

process.on("SIGTERM", () => {
  engine.stop();
  void slackBot.stop().finally(() => {
    server.close(() => process.exit(0));
  });
});

function sendJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendEmpty(
  response: ServerResponse<IncomingMessage>,
  status: number,
): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
