import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { loadConfig, maskSecret } from "./config.js";
import { SlackChatBot } from "./integrations/slack-chat.js";
import { ConvexStateStore } from "./runtime/convex-store.js";
import { SharkEngine } from "./runtime/engine.js";
import { FileStateStore } from "./runtime/file-store.js";
import type { StateStore } from "./runtime/store.js";
import { renderDashboard } from "./server/dashboard.js";

const config = loadConfig();
const store: StateStore = config.convexUrl
  ? new ConvexStateStore(config.convexUrl)
  : new FileStateStore(config.stateFile);
const engine = new SharkEngine(config, store);
const slackBot = new SlackChatBot(
  config,
  (text, source) => engine.enqueueOperatorCommand(text, source),
  () => engine.snapshot(),
);

const args = new Set(process.argv.slice(2));

await engine.init();

if (args.has("--smoke")) {
  const snapshot = await engine.smoke();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  process.exit(0);
}

const server = createServer(async (request, response) => {
  const url = request.url ?? "/";
  const method = request.method ?? "GET";

  if (method === "OPTIONS" && (url.startsWith("/api/") || url.startsWith("/slack/"))) {
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

  if (method === "POST" && url === "/api/command") {
    const body = await readBody(request);
    const payload = body.length > 0 ? (JSON.parse(body) as { text?: string }) : {};
    if (!payload.text) {
      return sendJson(response, 400, { error: "Missing text" });
    }

    await engine.enqueueOperatorCommand(payload.text, "ui");
    return sendJson(response, 200, engine.snapshot());
  }

  if (method === "GET" && url === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(renderDashboard(engine.snapshot()));
    return;
  }

  if (url === "/slack/events") {
    const body = await readBody(request);
    const slackRequest = new Request(`http://localhost:${config.port}${url}`, {
      method,
      headers: normalizeHeaders(request.headers),
      body: method === "GET" ? undefined : body,
    });
    const slackResponse = await slackBot.handleWebhook(slackRequest);
    return sendFetchResponse(response, slackResponse);
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(config.port, () => {
  const summary = [
    `Shark listening on http://localhost:${config.port}`,
    `State file: ${config.stateFile}`,
    `Workspace: ${config.workspaceDir}`,
    `Storage: ${store.kind}`,
    `Slack bot webhook: ${slackBot.isEnabled() ? "/slack/events" : "disabled (missing signing secret)"}`,
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
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  engine.stop();
  server.close(() => process.exit(0));
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

async function sendFetchResponse(
  response: ServerResponse<IncomingMessage>,
  fetchResponse: Response,
): Promise<void> {
  const text = await fetchResponse.text();
  const headers: Record<string, string> = {};
  fetchResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  response.writeHead(fetchResponse.status, {
    ...headers,
    ...corsHeaders(),
  });
  response.end(text);
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

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
    }
  }
  return normalized;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
