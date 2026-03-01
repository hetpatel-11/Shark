import type { IncomingMessage, ServerResponse } from "node:http";

import { SHARK_RUNTIME_URL } from "./runtime-target";

export const config = {
  api: {
    bodyParser: false,
  },
};

export function createProxyHandler(pathname: string) {
  return async function proxyHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const target = new URL(pathname, ensureTrailingSlash(SHARK_RUNTIME_URL));
    const method = request.method ?? "GET";
    const body = shouldIncludeBody(method) ? await readBody(request) : undefined;
    const headers = cloneHeaders(request.headers);

    const upstream = await fetch(target, {
      method,
      headers,
      body,
    });

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      response.setHeader(key, value);
    });
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end(await upstream.text());
  };
}

function shouldIncludeBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function cloneHeaders(
  source: IncomingMessage["headers"],
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (!value) {
      continue;
    }

    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") {
      continue;
    }

    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
