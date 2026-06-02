// Zero-dependency same-origin link extraction — SCM-S49-D2 (locked fork #1).
//
// Why regex over a DOM parser: the repo holds a zero-new-runtime-dependency
// line (see the docs-crawler design). A DOM library (linkedom) was rejected to
// preserve that streak. For documentation sites — well-formed, mostly static —
// a tolerant <a href> regex plus the platform URL parser is adequate. We never
// execute or trust the markup; we only enumerate hrefs, resolve them against
// the page URL, keep same-origin ones, normalize, and dedup.
//
// Robustness contract: a malformed href is SKIPPED, never thrown. extractLinks
// returns a deduped, normalized, same-origin list ready to enqueue.

// Capture the value of every href="..." / href='...' / href=bare attribute on
// an anchor tag. The [^>]*? keeps us inside a single tag; the three alternation
// arms cover double-quoted, single-quoted, and unquoted href values.
const HREF_RE =
  /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi;

/**
 * Same-origin test by scheme + host + port. Both inputs are absolute URLs (or
 * URL objects). A parse failure on either side returns false (treat as foreign,
 * i.e. do not follow).
 */
export function sameOrigin(a: string | URL, b: string | URL): boolean {
  try {
    const ua = a instanceof URL ? a : new URL(a);
    const ub = b instanceof URL ? b : new URL(b);
    return ua.origin === ub.origin;
  } catch {
    return false;
  }
}

/**
 * Canonicalize a URL for the visited-set and dedup:
 *   - drop the #fragment (same document),
 *   - drop a default port (:80 for http, :443 for https),
 *   - collapse an empty path to "/",
 *   - drop a trailing slash on non-root paths ("/a/" → "/a"),
 *   - preserve the query string (distinct ?page=2 pages are distinct files).
 * Returns null when the input is not a parseable absolute URL.
 */
export function normalizeUrl(raw: string | URL): string | null {
  let u: URL;
  try {
    u = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  } catch {
    return null;
  }

  // Strip the fragment — it never identifies a distinct page.
  u.hash = "";

  // Drop redundant default ports so http://h:80/ === http://h/.
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  // Normalize the path: "" → "/", and "/a/" → "/a" (but keep root "/").
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.replace(/\/+$/, "");
    if (path === "") path = "/";
  }
  u.pathname = path;

  return u.toString();
}

/**
 * Enumerate every <a href> in `html`, resolve relative hrefs against `baseUrl`,
 * keep only links same-origin with `seedOrigin`, normalize + dedup. Malformed
 * hrefs and non-http(s) schemes (mailto:, javascript:, tel:, #-only) are
 * skipped. Returns absolute, normalized URLs in first-seen order.
 *
 * @param html        raw HTML of the fetched page.
 * @param baseUrl     the page's final URL (relative hrefs resolve against it).
 * @param seedOrigin  origin to confine the crawl to (the seed's origin).
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  seedOrigin: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  if (!html) return out;

  for (const m of html.matchAll(HREF_RE)) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref) continue;

    // Cheap pre-filters: skip non-navigational schemes and pure fragments
    // before paying for URL construction.
    const lower = rawHref.toLowerCase();
    if (lower.startsWith("#")) continue;
    if (
      lower.startsWith("mailto:") ||
      lower.startsWith("javascript:") ||
      lower.startsWith("tel:") ||
      lower.startsWith("data:") ||
      lower.startsWith("ftp:")
    ) {
      continue;
    }

    // Resolve relative → absolute against the page URL. Malformed → skip.
    // Note: scheme-relative hrefs ("//host/path") inherit baseUrl's scheme via
    // the URL parser (no https→http downgrade); any cross-origin result is then
    // rejected by the same-origin check below, with assertSafeUrl (inside
    // fetchUrl) as the final guard before any network call.
    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }

    // Only http/https survive (resolution can yield other schemes).
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }

    // Same-origin confinement (no cross-origin following in the MVP).
    if (!sameOrigin(resolved, seedOrigin)) continue;

    const normalized = normalizeUrl(resolved);
    if (!normalized) continue;

    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}
