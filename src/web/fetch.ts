// Native web fetch with SSRF protection, redirect re-validation, byte caps,
// content-type allowlisting, and HTML→text conversion.
//
// Every outbound request — and EACH redirect hop — is validated by
// assertSafeUrl (src/web/ssrf-guard.ts) before a socket opens. Redirects are
// followed MANUALLY (redirect:'manual') precisely so a public URL cannot
// 30x-bounce into an internal address behind our back.
//
// All failure paths return { ok:false, reason } — this function NEVER throws to
// its caller. The returned `text` is capped at maxReturnChars to protect the
// agent's context window (research_url overrides this with a high cap so the
// ingestion pipeline sees the full body).

import { convert } from "html-to-text";
import { config } from "../config.js";
import { assertSafeUrl } from "./ssrf-guard.js";

export type FetchUrlOk = {
  ok: true;
  final_url: string;
  status: number;
  content_type: string;
  title: string | null;
  text: string;
  bytes: number;
  truncated: boolean;
  // Populated only when opts.includeRaw is true AND the response was HTML.
  // The crawler needs the raw markup to enumerate <a href> links; existing
  // callers (fetch_url, research_url) leave this undefined and are unaffected.
  html?: string;
};

export type FetchUrlErr = { ok: false; reason: string };

export type FetchUrlResult = FetchUrlOk | FetchUrlErr;

export type FetchUrlOpts = {
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
  allowlist?: string[];
  maxReturnChars?: number;
  // When true, the raw (uncapped-by-maxReturnChars) HTML body is returned on
  // result.html for HTML responses. Off by default so the agent's context is
  // never flooded with markup; the crawler opts in to feed extractLinks.
  includeRaw?: boolean;
};

const MAX_REDIRECTS = 5;

// Content types we know how to turn into useful text. Anything else (images,
// binaries, octet-stream) is rejected rather than dumped into context.
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
];

function isAllowedContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_CONTENT_TYPES.includes(base);
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "a", options: { ignoreHref: false } },
    ],
  });
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || m[1] === undefined) return null;
  const decoded = m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return decoded || null;
}

/**
 * Read a Response body up to `maxBytes`. Streams chunks and stops once the cap
 * is reached, returning { text, bytes, truncated }. Decodes as UTF-8.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = res.body;
  if (!body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return {
        text: buf.subarray(0, maxBytes).toString("utf8"),
        bytes: maxBytes,
        truncated: true,
      };
    }
    return { text: buf.toString("utf8"), bytes: buf.byteLength, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        const keep = value.byteLength - (total - maxBytes);
        chunks.push(value.subarray(0, Math.max(0, keep)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Release the lock; abort the underlying stream if we stopped early.
    try {
      await reader.cancel();
    } catch {
      /* best-effort */
    }
  }

  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString("utf8"), bytes: merged.byteLength, truncated };
}

/**
 * Fetch a URL safely and return cleaned text. Manual redirect handling with
 * per-hop SSRF re-validation. Never throws — all failures become
 * { ok:false, reason }.
 */
export async function fetchUrl(
  url: string,
  opts: FetchUrlOpts = {},
): Promise<FetchUrlResult> {
  const timeoutMs = opts.timeoutMs ?? config.SCM_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? config.SCM_FETCH_MAX_BYTES;
  const maxReturnChars = opts.maxReturnChars ?? config.SCM_FETCH_MAX_RETURN_CHARS;
  const allowPrivate = opts.allowPrivate ?? config.SCM_FETCH_ALLOW_PRIVATE;
  const allowlist = opts.allowlist ?? config.SCM_FETCH_ALLOWLIST;
  const includeRaw = opts.includeRaw ?? false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    let response: Response | null = null;

    // Manual redirect loop: validate EVERY hop (including the first) before the
    // request, then re-validate the Location target before following it.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let safe: URL;
      try {
        safe = await assertSafeUrl(currentUrl, { allowPrivate, allowlist });
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }

      response = await fetch(safe.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: ALLOWED_CONTENT_TYPES.join(", ") + ", */*;q=0.1" },
      });

      // 3xx with a Location → re-validate and follow.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, reason: `HTTP ${response.status} redirect without Location header` };
        }
        if (hop === MAX_REDIRECTS) {
          return { ok: false, reason: `Too many redirects (>${MAX_REDIRECTS})` };
        }
        // Resolve relative Location against the current URL.
        currentUrl = new URL(location, safe).toString();
        continue;
      }

      // Terminal (non-redirect) response — break out and process below.
      break;
    }

    if (!response) {
      return { ok: false, reason: "No response received" };
    }

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isAllowedContentType(contentType)) {
      return {
        ok: false,
        reason: `Unsupported content-type '${contentType || "unknown"}'`,
      };
    }

    const { text: rawBody, bytes, truncated: bodyTruncated } = await readBodyCapped(
      response,
      maxBytes,
    );

    const baseType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const isHtml = baseType === "text/html" || baseType === "application/xhtml+xml";

    let title: string | null = null;
    let text: string;
    if (isHtml) {
      title = extractTitle(rawBody);
      text = htmlToText(rawBody);
    } else {
      text = rawBody;
    }

    let returnTruncated = bodyTruncated;
    if (text.length > maxReturnChars) {
      text = text.slice(0, maxReturnChars);
      returnTruncated = true;
    }

    return {
      ok: true,
      final_url: response.url || currentUrlFallback(url),
      status: response.status,
      content_type: contentType,
      title,
      text,
      bytes,
      truncated: returnTruncated,
      // Expose raw HTML only when explicitly requested and the body was HTML.
      // rawBody is itself bounded by maxBytes (read off the socket), so this is
      // not an unbounded leak — it is the same buffer htmlToText consumed.
      ...(includeRaw && isHtml ? { html: rawBody } : {}),
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { ok: false, reason: `Request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, reason: `Fetch failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// response.url can be empty when redirect:'manual' is used on some runtimes;
// fall back to the originally-requested URL so final_url is never empty.
function currentUrlFallback(original: string): string {
  return original;
}
