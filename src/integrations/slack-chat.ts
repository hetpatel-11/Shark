import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { SharkConfig } from "../contracts.js";
import { normalizeSlackOperatorCommand } from "./slack-command.js";

type HandleSlackInstruction = (text: string) => Promise<string>;

interface SlackEventEnvelope {
  ack: () => Promise<void>;
  event: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    files?: unknown[];
  };
}

export class SlackChatBot {
  private readonly socketClient?: SocketModeClient;
  private readonly webClient?: WebClient;
  private readonly activeThreads = new Set<string>();
  private started = false;

  constructor(
    private readonly config: SharkConfig,
    private readonly handleInstruction: HandleSlackInstruction,
  ) {
    if (!config.slackAppToken || !config.slackBotToken) {
      return;
    }

    this.socketClient = new SocketModeClient({
      appToken: config.slackAppToken,
      logLevel: LogLevel.ERROR,
    });
    this.webClient = new WebClient(config.slackBotToken);

    this.socketClient.on("connecting", () => {
      process.stderr.write("Slack Socket Mode: connecting\n");
    });

    this.socketClient.on("connected", () => {
      process.stderr.write("Slack Socket Mode: connected\n");
    });

    this.socketClient.on("reconnecting", () => {
      process.stderr.write("Slack Socket Mode: reconnecting\n");
    });

    this.socketClient.on("disconnected", (error) => {
      const message = error instanceof Error ? error.stack ?? error.message : "normal shutdown";
      process.stderr.write(`Slack Socket Mode: disconnected (${message})\n`);
    });

    this.socketClient.on("app_mention", (payload) => {
      void this.handleMention(payload as SlackEventEnvelope);
    });

    this.socketClient.on("message", (payload) => {
      void this.handleMessage(payload as SlackEventEnvelope);
    });

    this.socketClient.on("slack_event", (payload: unknown) => {
      const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const type = typeof envelope.type === "string" ? envelope.type : "unknown";
      process.stderr.write(`Slack Socket Mode: received ${type}\n`);
    });

    this.socketClient.on("error", (error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Slack Socket Mode error: ${message}\n`);
    });
  }

  isEnabled(): boolean {
    return Boolean(this.socketClient && this.webClient);
  }

  async start(): Promise<void> {
    if (!this.socketClient || this.started) {
      return;
    }

    try {
      await this.socketClient.start();
      this.started = true;
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Slack Socket Mode failed to start: ${message}\n`);
    }
  }

  async stop(): Promise<void> {
    if (!this.socketClient || !this.started) {
      return;
    }

    await this.socketClient.disconnect();
    this.started = false;
  }

  private async handleMention(payload: SlackEventEnvelope): Promise<void> {
    await payload.ack();
    await this.processInstruction(payload.event, true, true);
  }

  private async handleMessage(payload: SlackEventEnvelope): Promise<void> {
    await payload.ack();

    const event = payload.event;
    if (!this.shouldProcessMessage(event)) {
      return;
    }

    const threadKey = this.buildThreadKey(event.channel, event.thread_ts);
    if (!threadKey || !this.activeThreads.has(threadKey)) {
      return;
    }

    await this.processInstruction(event, false, false);
  }

  private shouldProcessMessage(event: SlackEventEnvelope["event"]): boolean {
    if (!event || event.type !== "message") {
      return false;
    }

    if (event.subtype || event.bot_id) {
      return false;
    }

    if (!event.text?.trim()) {
      return false;
    }

    return true;
  }

  private async processInstruction(
    event: SlackEventEnvelope["event"],
    allowThreadBootstrap: boolean,
    allowMentionEvent: boolean,
  ): Promise<void> {
    if (!this.webClient) {
      return;
    }

    const isMentionEvent = event?.type === "app_mention";
    if (!this.shouldProcessMessage(event) && !(allowMentionEvent && isMentionEvent)) {
      return;
    }

    const command = normalizeSlackOperatorCommand({
      text: event.text,
      files: event.files,
    });
    if (!command) {
      return;
    }

    const reply = await this.handleInstruction(command);
    if (!reply.trim()) {
      return;
    }

    const channel = event.channel;
    const rootThreadTs = event.thread_ts ?? event.ts;
    if (!channel || !rootThreadTs) {
      if (this.config.slackChannel) {
        await this.webClient.chat.postMessage({
          channel: this.config.slackChannel,
          text: reply,
          unfurl_links: false,
          unfurl_media: false,
        });
      }
      return;
    }

    if (allowThreadBootstrap) {
      const threadKey = this.buildThreadKey(channel, rootThreadTs);
      if (threadKey) {
        this.activeThreads.add(threadKey);
      }
    }

    await this.webClient.chat.postMessage({
      channel,
      text: reply,
      thread_ts: rootThreadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  private buildThreadKey(channel?: string, threadTs?: string): string | undefined {
    if (!channel || !threadTs) {
      return undefined;
    }

    return `${channel}:${threadTs}`;
  }
}
