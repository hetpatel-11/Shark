import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SharkConfig } from "./contracts.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SharkConfig {
  const mergedEnv = loadEnvFiles(env);

  return {
    anthropicApiKey: mergedEnv.ANTHROPIC_API_KEY,
    anthropicModel: mergedEnv.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
    daytonaApiKey: mergedEnv.DAYTONA_API_KEY,
    supermemoryApiKey: mergedEnv.SUPERMEMORY_API_KEY,
    convexDeployment: mergedEnv.CONVEX_DEPLOYMENT,
    convexUrl: mergedEnv.CONVEX_URL,
    convexDeployKey: mergedEnv.CONVEX_DEPLOY_KEY,
    browserUseApiKey: mergedEnv.BROWSER_USE_API_KEY,
    agentMailApiKey: mergedEnv.AGENTMAIL_API_KEY,
    slackBotToken: mergedEnv.SLACK_BOT_TOKEN,
    slackAppToken: mergedEnv.SLACK_APP_TOKEN,
    slackSigningSecret: mergedEnv.SLACK_SIGNING_SECRET,
    slackChannel: mergedEnv.SLACK_DEFAULT_CHANNEL,
    vercelToken: mergedEnv.VERCEL_TOKEN,
    openAiApiKey: mergedEnv.OPENAI_API_KEY,
    loopIntervalMs: parseInteger(mergedEnv.SHARK_LOOP_INTERVAL_MS, 90_000),
    port: parseInteger(mergedEnv.PORT, 3000),
    stateFile: resolve(mergedEnv.SHARK_STATE_FILE ?? ".shark/state.json"),
    workspaceDir: resolve(mergedEnv.SHARK_WORKSPACE_DIR ?? ".shark/workspace"),
    autoStart: parseBoolean(mergedEnv.SHARK_AUTOSTART, false),
  };
}

export function maskSecret(secret?: string): string {
  if (!secret) {
    return "unset";
  }

  if (secret.length <= 8) {
    return "set";
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
}

function loadEnvFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };

  for (const fileName of [".env", ".env.local"]) {
    const filePath = resolve(fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!(key in merged) || !merged[key]) {
        merged[key] = value;
      }
    }
  }

  return merged;
}
