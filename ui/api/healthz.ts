import { config, createProxyHandler } from "./_lib/proxy";

export { config };

export default createProxyHandler("/healthz");
