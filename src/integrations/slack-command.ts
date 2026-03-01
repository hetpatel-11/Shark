export function normalizeSlackOperatorCommand(message: unknown): string {
  const payload = (message && typeof message === "object" ? message : {}) as Record<string, unknown>;
  const command = extractCommand(typeof payload.text === "string" ? payload.text : "");
  const attachments = extractAttachmentReferences(payload);

  if (!command && attachments.length === 0) {
    return "";
  }

  if (attachments.length === 0) {
    return command;
  }

  const attachmentLines = attachments.map((attachment) => `- ${attachment}`);
  const prefix = command ? `${command}\n\n` : "";
  return `${prefix}Operator-provided attachments:\n${attachmentLines.join("\n")}`;
}

function extractCommand(text: string): string {
  return text
    .replace(/<@[^>]+>/g, "")
    .trim();
}

function extractAttachmentReferences(message: Record<string, unknown>): string[] {
  const references: string[] = [];

  const files = Array.isArray(message.files) ? message.files : [];
  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }

    const candidate = file as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name : "attachment";
    const mimetype = typeof candidate.mimetype === "string" ? candidate.mimetype : "unknown";
    const url = pickFirstString(candidate, ["permalink", "url_private", "public_url", "url_private_download"]);
    if (url) {
      references.push(`${name} (${mimetype}) ${url}`);
    }
  }

  const text = typeof message.text === "string" ? message.text : "";
  for (const url of extractUrls(text)) {
    if (!references.some((value) => value.includes(url))) {
      references.push(url);
    }
  }

  return references;
}

function pickFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) ?? [];
  return matches.map((value) => value.replace(/[)>.,]+$/g, ""));
}
