import type { ProviderHealth, SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";

interface AgentMailMailboxResponse {
  address?: string;
  created_at?: string;
  error?: string;
}

export class AgentMailAdapter {
  private readonly baseUrl = "https://api.agentmail.email/v1";

  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.agentMailApiKey);
  }

  async createMailbox(): Promise<AgentMailMailboxResponse> {
    if (!this.config.agentMailApiKey) {
      return {
        error: "AgentMail is not configured",
      };
    }

    const response = await requestJson<AgentMailMailboxResponse>(
      `${this.baseUrl}/mailboxes`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.agentMailApiKey}`,
        },
        body: {},
      },
    );

    return response.data ?? { error: response.error ?? "Mailbox creation failed" };
  }

  health(): ProviderHealth {
    return {
      ok: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.isConfigured() ? "Ready" : "Missing AGENTMAIL_API_KEY",
    };
  }
}
