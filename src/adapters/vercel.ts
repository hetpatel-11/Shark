import type { ProviderHealth, SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";
import { DaytonaExecutor, type CommandResult } from "./daytona.js";

interface VercelProjectsResponse {
  projects?: Array<{ id: string; name: string }>;
  error?: { message?: string };
}

export class VercelAdapter {
  constructor(
    private readonly config: SharkConfig,
    private readonly executor: DaytonaExecutor,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.vercelToken);
  }

  async listProjects(): Promise<string[]> {
    if (!this.config.vercelToken) {
      return [];
    }

    const response = await requestJson<VercelProjectsResponse>(
      "https://api.vercel.com/v9/projects",
      {
        headers: {
          Authorization: `Bearer ${this.config.vercelToken}`,
        },
      },
    );

    if (!response.ok) {
      return [];
    }

    return response.data?.projects?.map((project) => project.name) ?? [];
  }

  async deploy(cwd: string): Promise<CommandResult> {
    if (!this.config.vercelToken) {
      return {
        ok: false,
        code: 1,
        stdout: "",
        stderr: "Vercel is not configured",
      };
    }

    return this.executor.run(
      `npx vercel deploy --yes --prod --token ${this.config.vercelToken}`,
      cwd,
    );
  }

  health(): ProviderHealth {
    return {
      ok: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.isConfigured() ? "Ready" : "Missing VERCEL_TOKEN",
    };
  }
}
