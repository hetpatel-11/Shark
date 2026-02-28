import { SHARK_RUNTIME_URL } from "./runtime-target";

function buildTarget(pathname: string): URL {
  return new URL(pathname, ensureTrailingSlash(SHARK_RUNTIME_URL));
}

export async function proxyToRuntime(
  request: Request,
  pathname: string,
): Promise<Response> {
  const target = buildTarget(pathname);
  const body = shouldIncludeBody(request.method) ? await request.text() : undefined;
  const headers = cloneHeaders(request.headers);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
  });

  return passthrough(upstream);
}

function shouldIncludeBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function cloneHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") {
      return;
    }

    headers.set(key, value);
  });
  return headers;
}

async function passthrough(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    headers.set(key, value);
  });
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(body, {
    status: upstream.status,
    headers,
  });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
