import https from "https";
import nodeFetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";

// Windows Node.js builds often have incomplete certificate chains for third-party
// HTTPS endpoints (e.g. ESPN, Wikipedia, Transfermarkt). A single shared agent
// with rejectUnauthorized:false bypasses the broken chain validation globally.
// This is intentional for a dev/personal app — no user credentials transit these requests.
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

export function safeFetch(url: RequestInfo, init: RequestInit = {}): Promise<Response> {
  return nodeFetch(url, { ...init, agent: tlsAgent } as RequestInit);
}
