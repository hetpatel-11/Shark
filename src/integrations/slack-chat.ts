import { createMemoryState } from "@chat-adapter/state-memory";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, ConsoleLogger } from "chat";

import type { SharkConfig } from "../contracts.js";
import { normalizeSlackOperatorCommand } from "./slack-command.js";

type EnqueueCommand = (text: string, source: "slack") => Promise<void>;

export class SlackChatBot {
  private readonly chat?: Chat;

  constructor(
    config: SharkConfig,
    enqueueCommand: EnqueueCommand,
  ) {
    if (!config.slackBotToken || !config.slackSigningSecret) {
      return;
    }

    this.chat = new Chat({
      userName: "Shark",
      adapters: {
        slack: createSlackAdapter({
          botToken: config.slackBotToken,
          signingSecret: config.slackSigningSecret,
          logger: new ConsoleLogger("silent"),
        }),
      },
      state: createMemoryState(),
      logger: "silent",
    });

    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      const command = normalizeSlackOperatorCommand(message);
      if (command) {
        await enqueueCommand(command, "slack");
      }
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      const command = normalizeSlackOperatorCommand(message);
      if (!command) {
        return;
      }

      await enqueueCommand(command, "slack");
    });
  }

  isEnabled(): boolean {
    return Boolean(this.chat);
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (!this.chat) {
      return new Response("Slack bot is not configured", { status: 501 });
    }

    return this.chat.webhooks.slack(request);
  }
}
