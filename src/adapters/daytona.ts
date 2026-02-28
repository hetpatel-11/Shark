import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export class DaytonaExecutor {
  async run(command: string, cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        env: process.env,
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          code: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      child.on("error", (error) => {
        resolve({
          ok: false,
          code: 1,
          stdout,
          stderr: error.message,
        });
      });
    });
  }
}
