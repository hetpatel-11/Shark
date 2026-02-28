import type { ProviderHealth, SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";

interface BrowserUseTaskResponse {
  task_id?: string;
  id?: string;
  status?: string;
  live_url?: string;
  liveUrl?: string;
  sessionId?: string;
  error?: string;
}

export class BrowserUseAdapter {
  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.browserUseApiKey);
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.config.browserUseApiKey) {
      return this.health("Missing BROWSER_USE_API_KEY", false);
    }

    return this.health(
      "Configured. Browser Use reachability is validated on the first real task.",
      true,
    );
  }

  async runTask(task: string): Promise<BrowserUseTaskResponse> {
    if (!this.config.browserUseApiKey) {
      return {
        status: "skipped",
      };
    }

    const response = await requestJson<BrowserUseTaskResponse>(
      "https://api.browser-use.com/api/v1/run-task",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.browserUseApiKey}`,
        },
        body: {
          task,
        },
      },
    );

    return response.data ?? { status: response.error ?? "failed" };
  }

  private health(message: string, ok: boolean): ProviderHealth {
    return {
      ok,
      checkedAt: new Date().toISOString(),
      message,
    };
  }
}
