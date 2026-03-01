import type { ProviderHealth, SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";

interface SlackPostResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

type SlackBlock =
  | {
      type: "header";
      text: SlackTextObject;
    }
  | {
      type: "section";
      text: SlackTextObject;
      fields?: SlackTextObject[];
    }
  | {
      type: "context";
      elements: SlackTextObject[];
    }
  | {
      type: "divider";
    };

interface SlackMessageOptions {
  blocks?: SlackBlock[];
}

export class SlackAdapter {
  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.slackBotToken && this.config.slackChannel);
  }

  async postMessage(text: string, options: SlackMessageOptions = {}): Promise<SlackPostResponse> {
    if (!this.config.slackBotToken || !this.config.slackChannel) {
      return {
        ok: false,
        error: "Slack is not configured",
      };
    }

    const response = await requestJson<SlackPostResponse>(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.slackBotToken}`,
        },
        body: {
          channel: this.config.slackChannel,
          text,
          blocks: options.blocks,
          unfurl_links: false,
          unfurl_media: false,
        },
      },
    );

    if (!response.ok || !response.data?.ok) {
      return {
        ok: false,
        error: response.data?.error ?? response.error ?? "Slack post failed",
      };
    }

    return response.data;
  }

  health(): ProviderHealth {
    return {
      ok: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      message: this.isConfigured() ? "Ready" : "Missing SLACK_BOT_TOKEN or SLACK_DEFAULT_CHANNEL",
    };
  }
}
