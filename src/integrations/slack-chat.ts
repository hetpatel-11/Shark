import { createMemoryState } from "@chat-adapter/state-memory";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, ConsoleLogger } from "chat";

import type { DashboardSnapshot, SharkConfig } from "../contracts.js";

type EnqueueCommand = (text: string, source: "slack") => Promise<void>;
type SnapshotReader = () => DashboardSnapshot;

export class SlackChatBot {
  private readonly chat?: Chat;

  constructor(
    config: SharkConfig,
    enqueueCommand: EnqueueCommand,
    snapshot: SnapshotReader,
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
      const command = extractCommand(message.text ?? "");
      if (command) {
        await enqueueCommand(command, "slack");
        await thread.post(`Queued command for Shark: ${command}`);
        return;
      }

      const state = snapshot();
      await thread.post(
        [
          `Shark is running in ${state.mode} mode.`,
          `Storage: ${state.storage}.`,
          `Pending tasks: ${state.pendingTasks.length}.`,
          "Reply in this thread with instructions and Shark will queue them.",
        ].join(" "),
      );
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      const command = extractCommand(message.text ?? "");
      if (!command) {
        return;
      }

      await enqueueCommand(command, "slack");
      await thread.post(`Queued follow-up command: ${command}`);
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

function extractCommand(text: string): string {
  const normalized = text
    .replace(/<@[^>]+>/g, "")
    .trim();

  return normalized;
}
