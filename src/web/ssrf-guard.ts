// SSRF guard for the native web-research tools (fetch_url + research_url).
//
// The threat: an MCP tool that fetches an arbitrary user-supplied URL is a
// classic Server-Side Request Forgery vector. Without a guard, a caller could
// point the tool at http://169.254.169.254/ (cloud metadata), http://localhost
// admin panels, or RFC-1918 internal services the host can reach but the caller
// cannot. This module is the single chokepoint every outbound fetch MUST pass
// through — including EACH redirect hop (see src/web/fetch.ts), because a
// public URL can 30x-redirect to an internal one.
//
// Design: scheme allowlist → literal-host denylist → optional caller allowlist
// (exact or subdomain match) → DNS resolution of ALL A/AAAA records → reject if
// ANY resolved address is private/loopback/link-local (unless allowPrivate).
// Throws Error on rejection; callers convert to { ok:false, reason }.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// Hostnames that are ALWAYS rejected regardless of DNS, because they are, by
// definition or convention, the local machine. `localhost` and any `*.localhost`
// label (RFC 6761) resolve to loopback on conforming resolvers, but we never
// want to rely on the resolver for these — block them by name first.
function isBlockedLiteralHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // strip FQDN trailing dot
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  // IPv6 literals arrive wrapped in brackets from the URL parser's hostname?
  // Actually URL.hostname strips brackets for IPv6; handle the bare forms in
  // isPrivateIp below. Reject the obvious loopback name aliases here.
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;
  return false;
}

/**
 * True when `ip` is a loopback, private (RFC 1918 / RFC 6598), or link-local
 * address. Covers both IPv4 and IPv6, including IPv4-mapped IPv6 (::ffff:a.b.c.d).
 * A non-IP string returns false (caller resolves hostnames before calling this
 * on the resolved addresses).
 */
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets as [number, number, number, number];

  // 0.0.0.0/8 — "this network" / unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes 169.254.169.254 cloud metadata).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — RFC 6598 carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // ::1 — loopback. :: — unspecified.
  if (lower === "::1" || lower === "::") return true;

  // IPv4-mapped IPv6: ::ffff:a.b.c.d (and the rarer ::ffff:0:a.b.c.d).
  // Extract the trailing dotted-quad and defer to the v4 check.
  const mapped = lower.match(/::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && mapped[1]) return isPrivateIpv4(mapped[1]);

  // Normalise to the first hextet group for prefix tests.
  const firstHextet = lower.split(":")[0] ?? "";
  const head = parseInt(firstHextet || "0", 16);

  // fc00::/7 — unique local addresses (fc00–fdff).
  if (!Number.isNaN(head) && (head & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local (fe80–febf).
  if (!Number.isNaN(head) && (head & 0xffc0) === 0xfe80) return true;

  return false;
}

/** Case-insensitive exact-or-subdomain match of `host` against one allowlist entry. */
function hostMatchesAllowEntry(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const e = entry.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "").trim();
  if (!e) return false;
  if (h === e) return true;
  return h.endsWith(`.${e}`);
}

/**
 * Validate a raw URL string for safe outbound fetching. Returns the parsed URL
 * on success; throws Error with a human-readable reason on rejection.
 *
 * @param rawUrl   the URL to validate (a redirect Location, on later hops).
 * @param opts.allowPrivate  when true, skip the private/loopback IP rejection
 *   (still enforces scheme + literal-host blocks). For trusted on-prem fetches.
 * @param opts.allowlist  when non-empty, the host MUST match one entry
 *   (exact or subdomain, case-insensitive); DNS is then NOT consulted for the
 *   private-IP check (the operator has explicitly trusted these hosts).
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: { allowPrivate: boolean; allowlist: string[] },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${truncateForError(rawUrl)}`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `Blocked URL scheme '${url.protocol}' — only http: and https: are allowed.`,
    );
  }

  const host = url.hostname;
  if (!host) {
    throw new Error("Blocked URL: missing host.");
  }

  // URL.hostname wraps IPv6 literals in brackets (e.g. "[::1]"); isIP() only
  // recognises the bare form, so normalise BEFORE the IP-literal check below.
  // Without this, "http://[::1]/" would fall through to the DNS path instead of
  // being recognised (and rejected) as a loopback literal.
  const bareHost = stripV6Brackets(host);

  if (isBlockedLiteralHost(host)) {
    throw new Error(`Blocked host '${host}' — loopback/localhost is not allowed.`);
  }

  // An allowlist, when configured, is authoritative: the host must match an
  // entry and we do NOT DNS-resolve (the operator vouches for these hosts).
  const allowlist = opts.allowlist.filter(Boolean);
  if (allowlist.length > 0) {
    const matched = allowlist.some((entry) => hostMatchesAllowEntry(host, entry));
    if (!matched) {
      throw new Error(
        `Blocked host '${host}' — not in the configured fetch allowlist.`,
      );
    }
    return url;
  }

  // If the host is itself an IP literal, check it directly — no DNS needed.
  if (isIP(bareHost) !== 0) {
    if (!opts.allowPrivate && isPrivateIp(bareHost)) {
      throw new Error(
        `Blocked address '${host}' — private/loopback/link-local IPs are not allowed.`,
      );
    }
    return url;
  }

  // Hostname: resolve ALL addresses and reject if ANY is private. This defends
  // against DNS rebinding to a single private record among public ones.
  if (!opts.allowPrivate) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(host, { all: true });
    } catch (e) {
      throw new Error(
        `Blocked host '${host}' — DNS resolution failed: ${(e as Error).message}`,
      );
    }
    if (addresses.length === 0) {
      throw new Error(`Blocked host '${host}' — DNS returned no addresses.`);
    }
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new Error(
          `Blocked host '${host}' — resolves to a private/loopback address (${address}).`,
        );
      }
    }
  }

  return url;
}

function stripV6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function truncateForError(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}
