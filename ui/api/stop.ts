import { proxyToRuntime } from "./_lib/proxy";

export default async function handler(request: Request): Promise<Response> {
  return proxyToRuntime(request, "/api/stop");
}
