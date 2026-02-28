import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../config.js";

export async function deployVercelUi(
  runtimeUrl: string,
  vercelToken: string,
): Promise<string> {
  await mkdir("ui", { recursive: true });
  await mkdir(join("ui", "api", "_lib"), { recursive: true });
  await writeFile(
    join("ui", "runtime-config.js"),
    `window.SHARK_RUNTIME_URL = ${JSON.stringify(runtimeUrl)};\n`,
  );
  await writeFile(
    join("ui", "api", "_lib", "runtime-target.ts"),
    `export const SHARK_RUNTIME_URL = ${JSON.stringify(runtimeUrl)};\n`,
  );

  const output = await runCommand("npx", [
    "vercel",
    "deploy",
    "ui",
    "--yes",
    "--prod",
    "--token",
    vercelToken,
  ]);

  const match = output.match(/https:\/\/[^\s]+/g);
  const url = match?.at(-1);
  if (!url) {
    throw new Error(`Unable to determine Vercel UI URL.\n${output}`);
  }

  return url;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtimeUrl = process.argv[2];
  const vercelToken = loadConfig().vercelToken;

  if (!runtimeUrl) {
    throw new Error("Usage: tsx src/deploy/vercel-ui.ts <runtime-url>");
  }

  if (!vercelToken) {
    throw new Error("VERCEL_TOKEN is required");
  }

  const url = await deployVercelUi(runtimeUrl, vercelToken);
  process.stdout.write(`${url}\n`);
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });

    let combined = "";

    child.stdout.on("data", (chunk) => {
      combined += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      combined += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve(combined);
        return;
      }

      reject(new Error(combined || `Command failed with exit code ${code ?? 1}`));
    });
  });
}
