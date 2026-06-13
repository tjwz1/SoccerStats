import https from "https";
import nodeFetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";

// Windows Node.js builds often have incomplete certificate chains for third-party
// HTTPS endpoints (e.g. ESPN, Wikipedia, Transfermarkt). Bypass only on Windows;
// Linux/macOS deployments have complete system CA stores and should validate normally.
const tlsAgent = process.platform === "win32"
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

export function safeFetch(url: RequestInfo, init: RequestInit = {}): Promise<Response> {
  return nodeFetch(url, { ...init, ...(tlsAgent ? { agent: tlsAgent } : {}) } as RequestInit);
}
