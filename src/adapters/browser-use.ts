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
  detail?: string;
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
      "Configured. Browser Use v2 reachability is validated on the first real task.",
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
      "https://api.browser-use.com/api/v2/tasks",
      {
        method: "POST",
        headers: {
          "X-Browser-Use-API-Key": this.config.browserUseApiKey,
        },
        body: {
          task,
          maxSteps: 20,
        },
      },
    );

    if (!response.ok) {
      return {
        status: "failed",
        error: response.data?.detail ?? response.error ?? "Browser Use request failed",
      };
    }

    if (!response.data?.id && !response.data?.task_id) {
      return {
        status: "failed",
        error: response.data?.detail ?? "Browser Use did not return a task id",
      };
    }

    return {
      ...response.data,
      status: response.data.status ?? "queued",
    };
  }

  private health(message: string, ok: boolean): ProviderHealth {
    return {
      ok,
      checkedAt: new Date().toISOString(),
      message,
    };
  }
}
