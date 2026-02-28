import type { SharkConfig } from "../contracts.js";
import { requestJson } from "./http.js";

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

export class AnthropicAdapter {
  constructor(private readonly config: SharkConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.anthropicApiKey);
  }

  async generateText(prompt: string): Promise<string> {
    if (!this.config.anthropicApiKey) {
      return buildFallbackResponse(prompt);
    }

    const response = await requestJson<AnthropicMessageResponse>(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": this.config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: this.config.anthropicModel,
          max_tokens: 800,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        },
      },
    );

    if (!response.ok) {
      return buildFallbackResponse(prompt, response.error);
    }

    const text = response.data?.content
      ?.filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n")
      .trim();

    return text && text.length > 0
      ? text
      : buildFallbackResponse(prompt, "Anthropic returned no text");
  }
}

function buildFallbackResponse(prompt: string, reason?: string): string {
  const suffix = reason ? `\n\nFallback reason: ${reason}` : "";
  return [
    "Startup: AI revenue operations control tower for SMBs",
    "Customer: founder-led SMBs with 5-100 employees",
    "Problem: revenue, hiring, and cash workflows are fragmented across too many tools",
    "Product: one AI-native command center that automates lead routing, collections, onboarding, and back-office follow-up",
    "Why now: agents can now execute across email, browser, and internal tools continuously",
    "Moat: proprietary workflow memory and execution history compound into better operating playbooks",
    `Prompt context: ${prompt.slice(0, 160)}`,
    suffix,
  ].join("\n");
}
