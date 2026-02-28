import type { ProviderHealth, SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";

interface SupermemoryAddResponse {
  id?: string;
  status?: string;
}

interface SupermemorySearchResponse {
  total?: number;
  results?: Array<Record<string, unknown>>;
}

export class SupermemoryAdapter {
  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.supermemoryApiKey);
  }

  async addMemory(content: string, containerTag: string): Promise<SupermemoryAddResponse> {
    if (!this.config.supermemoryApiKey) {
      return {
        status: "skipped",
      };
    }

    const response = await requestJson<SupermemoryAddResponse>(
      "https://api.supermemory.ai/v3/memories",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.supermemoryApiKey}`,
        },
        body: {
          content,
          containerTag,
        },
      },
    );

    return response.data ?? { status: response.error ?? "failed" };
  }

  async search(q: string, containerTag: string): Promise<SupermemorySearchResponse> {
    if (!this.config.supermemoryApiKey) {
      return {
        total: 0,
        results: [],
      };
    }

    const response = await requestJson<SupermemorySearchResponse>(
      "https://api.supermemory.ai/v3/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.supermemoryApiKey}`,
        },
        body: {
          q,
          containerTag,
          searchMode: "hybrid",
          limit: 5,
        },
      },
    );

    return response.data ?? { total: 0, results: [] };
  }

  health(): ProviderHealth {
    return {
      ok: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.isConfigured() ? "Ready" : "Missing SUPERMEMORY_API_KEY",
    };
  }
}
