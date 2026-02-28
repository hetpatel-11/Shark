import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, posix, relative } from "node:path";

import { CodeLanguage, Daytona } from "@daytonaio/sdk";

import { loadConfig } from "../config.js";
import { deployVercelUi } from "./vercel-ui.js";

const config = loadConfig();
const deploymentEnv = loadDeploymentEnv();

if (!deploymentEnv.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required to deploy Shark into Daytona.");
}

const daytona = new Daytona({
  apiKey: deploymentEnv.DAYTONA_API_KEY,
  apiUrl: deploymentEnv.DAYTONA_API_URL ?? "https://app.daytona.io/api",
  target: deploymentEnv.DAYTONA_TARGET ?? "us",
});

const sandbox = await daytona.create({
  name: `shark-${Date.now().toString(36)}`,
  language: CodeLanguage.TYPESCRIPT,
  envVars: collectRuntimeEnv(),
  public: true,
  autoStopInterval: 0,
  autoDeleteInterval: -1,
  labels: {
    project: "shark",
    role: "control-plane",
  },
});

const remoteRoot = "shark";

await sandbox.fs.createFolder(remoteRoot, "755");
await uploadPath(sandbox, "src", remoteRoot);

for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
  await sandbox.fs.uploadFile(file, posix.join(remoteRoot, basename(file)));
}

process.stdout.write(`Created sandbox ${sandbox.id}\n`);
process.stdout.write("Installing dependencies in Daytona...\n");
await runRemoteCommand(sandbox, "npm install", remoteRoot, 900);

process.stdout.write("Building Shark in Daytona...\n");
await runRemoteCommand(sandbox, "npm run build", remoteRoot, 900);

process.stdout.write("Starting Shark control plane in Daytona...\n");
await runRemoteCommand(
  sandbox,
  "nohup npm start > shark.log 2>&1 &",
  remoteRoot,
  60,
);

await sleep(5000);
const preview = await sandbox.getPreviewLink(config.port);

process.stdout.write(`Sandbox ID: ${sandbox.id}\n`);
process.stdout.write(`Preview URL: ${preview.url}\n`);
process.stdout.write(`Preview Token: ${preview.token}\n`);

if (config.vercelToken) {
  process.stdout.write("Deploying operator UI to Vercel...\n");
  const uiUrl = await deployVercelUi(preview.url, config.vercelToken);
  process.stdout.write(`Vercel UI URL: ${uiUrl}\n`);
}

process.stdout.write("Shark is now running remotely inside Daytona.\n");

async function uploadPath(
  sandboxRef: typeof sandbox,
  localPath: string,
  remoteRootDir: string,
): Promise<void> {
  const entries = await readdir(localPath, { withFileTypes: true });
  const baseDir = basename(localPath);
  const remoteBase = posix.join(remoteRootDir, baseDir);

  await sandboxRef.fs.createFolder(remoteBase, "755");

  for (const entry of entries) {
    const absoluteLocal = join(localPath, entry.name);
    const relativeLocal = relative(localPath, absoluteLocal);
    const remotePath = posix.join(remoteBase, relativeLocal.replaceAll("\\", "/"));

    if (entry.isDirectory()) {
      await uploadNestedDirectory(sandboxRef, absoluteLocal, remotePath);
      continue;
    }

    await sandboxRef.fs.uploadFile(absoluteLocal, remotePath);
  }
}

async function uploadNestedDirectory(
  sandboxRef: typeof sandbox,
  localDir: string,
  remoteDir: string,
): Promise<void> {
  await sandboxRef.fs.createFolder(remoteDir, "755");
  const entries = await readdir(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const absoluteLocal = join(localDir, entry.name);
    const remotePath = posix.join(remoteDir, entry.name);

    if (entry.isDirectory()) {
      await uploadNestedDirectory(sandboxRef, absoluteLocal, remotePath);
    } else {
      await sandboxRef.fs.uploadFile(absoluteLocal, remotePath);
    }
  }
}

function collectRuntimeEnv(): Record<string, string> {
  const runtimeEnv: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(config.port),
    SHARK_AUTOSTART: "true",
    SHARK_LOOP_INTERVAL_MS: String(config.loopIntervalMs),
    SHARK_STATE_FILE: ".shark/state.json",
    SHARK_WORKSPACE_DIR: ".shark/workspace",
  };

  addIfPresent(runtimeEnv, "ANTHROPIC_API_KEY", config.anthropicApiKey);
  addIfPresent(runtimeEnv, "ANTHROPIC_MODEL", config.anthropicModel);
  addIfPresent(runtimeEnv, "SUPERMEMORY_API_KEY", config.supermemoryApiKey);
  addIfPresent(runtimeEnv, "CONVEX_DEPLOYMENT", config.convexDeployment);
  addIfPresent(runtimeEnv, "CONVEX_URL", config.convexUrl);
  addIfPresent(runtimeEnv, "CONVEX_DEPLOY_KEY", config.convexDeployKey);
  addIfPresent(runtimeEnv, "BROWSER_USE_API_KEY", config.browserUseApiKey);
  addIfPresent(runtimeEnv, "AGENTMAIL_API_KEY", config.agentMailApiKey);
  addIfPresent(runtimeEnv, "SLACK_BOT_TOKEN", config.slackBotToken);
  addIfPresent(runtimeEnv, "SLACK_APP_TOKEN", config.slackAppToken);
  addIfPresent(runtimeEnv, "SLACK_SIGNING_SECRET", config.slackSigningSecret);
  addIfPresent(runtimeEnv, "SLACK_DEFAULT_CHANNEL", config.slackChannel);
  addIfPresent(runtimeEnv, "VERCEL_TOKEN", config.vercelToken);
  addIfPresent(runtimeEnv, "OPENAI_API_KEY", config.openAiApiKey);

  return runtimeEnv;
}

function addIfPresent(target: Record<string, string>, key: string, value?: string): void {
  if (value) {
    target[key] = value;
  }
}

async function runRemoteCommand(
  sandboxRef: typeof sandbox,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<void> {
  const result = await sandboxRef.process.executeCommand(
    command,
    cwd,
    undefined,
    timeoutSeconds,
  );

  if (result.exitCode !== 0) {
    const details = [
      `Command failed: ${command}`,
      `Exit code: ${result.exitCode}`,
      result.result ? `Output:\n${result.result}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    throw new Error(details);
  }
}

function loadDeploymentEnv(): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }

  for (const fileName of [".env", ".env.local"]) {
    if (!existsSync(fileName)) {
      continue;
    }

    const contents = readFileSync(fileName, "utf8");
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
      if (!merged[key]) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
