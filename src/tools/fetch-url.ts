// MCP tool: fetch_url
//
// Thin handler over src/web/fetch.ts. Validates the url arg is present, forwards
// optional timeout/byte overrides, and returns the fetchUrl result object
// verbatim ({ ok:true, ...cleaned text } | { ok:false, reason }). The SSRF guard
// and context-protecting maxReturnChars cap live in fetchUrl; this layer only
// adapts the tool argument shape.

import { config } from "../config.js";
import { fetchUrl, type FetchUrlResult } from "../web/fetch.js";

export type FetchUrlToolArgs = {
  url: string;
  timeout_ms?: number;
  max_bytes?: number;
};

export async function fetchUrlTool(args: FetchUrlToolArgs): Promise<FetchUrlResult> {
  if (!args.url || typeof args.url !== "string" || args.url.trim() === "") {
    return { ok: false, reason: "Missing required 'url' argument." };
  }

  return fetchUrl(args.url, {
    timeoutMs: args.timeout_ms ?? config.SCM_FETCH_TIMEOUT_MS,
    maxBytes: args.max_bytes ?? config.SCM_FETCH_MAX_BYTES,
    maxReturnChars: config.SCM_FETCH_MAX_RETURN_CHARS,
    allowPrivate: config.SCM_FETCH_ALLOW_PRIVATE,
    allowlist: config.SCM_FETCH_ALLOWLIST,
  });
}
