// Native web-research tools — hermetic unit tests (no real network, no DNS).
//
// Covers:
//   ssrf-guard:  blocks file:/data:/127.0.0.1/10.x/169.254.169.254/localhost/::1,
//                allows a public host (DNS mocked to a public IP), enforces an
//                allowlist (host must match; DNS is NOT consulted).
//   fetchUrl:    non-2xx → ok:false; timeout (AbortError) → ok:false; oversize
//                body → truncated:true; disallowed content-type → ok:false;
//                HTML → text + <title> extraction; redirect → re-validated and a
//                redirect-to-private target is blocked.
//   researchUrl: happy path calls chunkMarkdown + embed + upsertChunks with the
//                correct file_origin + metadata, deletes prior rows first, and
//                returns chunks_stored.
//
// Runtime: node:test + node:assert/strict + --experimental-test-module-mocks.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mocked config (fetch defaults) ──────────────────────────────────────────
const TEST_CONFIG = {
  SCM_FETCH_TIMEOUT_MS: 15000,
  SCM_FETCH_MAX_BYTES: 2_000_000,
  SCM_FETCH_MAX_RETURN_CHARS: 20_000,
  SCM_FETCH_ALLOW_PRIVATE: false,
  SCM_FETCH_ALLOWLIST: [] as string[],
  CHUNK_SIZE: 800,
  CHUNK_OVERLAP: 100,
  EMBED_DIM: 3,
};

mock.module("../src/config.js", {
  namedExports: { config: TEST_CONFIG, memoryRoots: [] as string[] },
});

// ── Mocked DNS: public hosts → public IP; everything else NXDOMAIN ──────────
// example.com resolves to a public address so the SSRF guard's "resolve + reject
// private" path is exercised WITHOUT touching the real resolver. A host the test
// wants to fail resolution for can be added to DNS_FAIL.
const DNS_MAP: Record<string, string[]> = {
  "example.com": ["93.184.216.34"],
  "public.test": ["93.184.216.34"],
  "evil-redirect.test": ["93.184.216.34"],
};
mock.module("node:dns/promises", {
  namedExports: {
    lookup: async (host: string, _opts?: unknown) => {
      const addrs = DNS_MAP[host.toLowerCase()];
      if (!addrs) {
        const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
        throw err;
      }
      return addrs.map((address) => ({ address, family: 4 }));
    },
  },
});

// ── Mocked ollama embed + supabase write helpers ────────────────────────────
type EmbedCall = { texts: string[] };
type UpsertCall = { projectId: string; rows: Array<Record<string, unknown>> };
type DeleteCall = { projectId: string; fileOrigin: string };

const state: {
  embedCalls: EmbedCall[];
  upsertCalls: UpsertCall[];
  deleteCalls: DeleteCall[];
} = { embedCalls: [], upsertCalls: [], deleteCalls: [] };

mock.module("../src/ollama.js", {
  namedExports: {
    embed: async (texts: string[]) => {
      state.embedCalls.push({ texts });
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  },
});

mock.module("../src/supabase.js", {
  namedExports: {
    supabase: {
      from() {
        throw new Error("supabase.from should not be called directly in these tests");
      },
    },
    upsertChunks: async (projectId: string, rows: Array<Record<string, unknown>>) => {
      state.upsertCalls.push({ projectId, rows });
      return { count: rows.length };
    },
    deleteChunksForFile: async (projectId: string, fileOrigin: string) => {
      state.deleteCalls.push({ projectId, fileOrigin });
      return 0;
    },
  },
});

mock.module("../src/project.js", {
  namedExports: {
    currentProjectId: "test-project",
    slugify: (s: string) => s,
    detectProjectId: () => "test-project",
    displayProjectName: (p: string) => p,
  },
});

// SUTs — imported AFTER mocks are registered.
const { assertSafeUrl, isPrivateIp } = await import("../src/web/ssrf-guard.js");
const { fetchUrl } = await import("../src/web/fetch.js");
const { researchUrl } = await import("../src/tools/research-url.js");

// ── fetch stubbing helpers ──────────────────────────────────────────────────
type StubResponse = {
  status: number;
  headers: Record<string, string>;
  body?: string;
  url?: string;
};

const realFetch = globalThis.fetch;

/** Install a fetch stub that returns queued responses in order (by call index). */
function stubFetchSequence(responses: StubResponse[]): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return makeResponse(spec!);
  }) as typeof fetch;
  return { calls };
}

function makeResponse(spec: StubResponse): Response {
  const headers = new Headers(spec.headers);
  const bodyStr = spec.body ?? "";
  const stream =
    spec.body === undefined
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(bodyStr));
            controller.close();
          },
        });
  const res = new Response(stream, { status: spec.status, headers });
  // Response.url is read-only; override for redirect-follow assertions.
  Object.defineProperty(res, "url", { value: spec.url ?? "", configurable: true });
  return res;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// ════════════════════════════════════════════════════════════════════════════
describe("ssrf-guard — isPrivateIp", () => {
  it("flags IPv4 loopback / private / link-local / CGNAT ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.5.5",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
    ]) {
      assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1"]) {
      assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
    }
  });

  it("flags IPv6 loopback / ULA / link-local / mapped-v4", () => {
    for (const ip of ["::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
    }
  });

  it("allows public IPv6 and mapped public v4", () => {
    assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
    assert.equal(isPrivateIp("::ffff:93.184.216.34"), false);
  });
});

describe("ssrf-guard — assertSafeUrl rejections", () => {
  const base = { allowPrivate: false, allowlist: [] as string[] };

  it("rejects non-http(s) schemes", async () => {
    for (const u of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "ftp://example.com/x"]) {
      await assert.rejects(() => assertSafeUrl(u, base), /scheme|Invalid/i, `should reject ${u}`);
    }
  });

  it("rejects literal loopback host names", async () => {
    await assert.rejects(() => assertSafeUrl("http://localhost/x", base), /loopback|localhost/i);
    await assert.rejects(() => assertSafeUrl("http://app.localhost/x", base), /loopback|localhost/i);
  });

  it("rejects private/loopback/link-local IP literals", async () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x",
    ]) {
      await assert.rejects(() => assertSafeUrl(u, base), /private|loopback|link-local/i, `should reject ${u}`);
    }
  });

  it("rejects a public hostname that resolves to a private IP", async () => {
    DNS_MAP["rebind.test"] = ["10.0.0.99"];
    await assert.rejects(
      () => assertSafeUrl("http://rebind.test/x", base),
      /private|loopback/i,
    );
    delete DNS_MAP["rebind.test"];
  });
});

describe("ssrf-guard — assertSafeUrl allows", () => {
  it("allows a public host (DNS → public IP)", async () => {
    const url = await assertSafeUrl("https://example.com/page", {
      allowPrivate: false,
      allowlist: [],
    });
    assert.equal(url.hostname, "example.com");
  });

  it("allowlist: rejects a host not on the list", async () => {
    await assert.rejects(
      () => assertSafeUrl("https://example.com/x", { allowPrivate: false, allowlist: ["allowed.test"] }),
      /allowlist/i,
    );
  });

  it("allowlist: allows exact + subdomain match without DNS", async () => {
    // 'internal.test' is NOT in DNS_MAP — proves DNS is skipped when allowlisted.
    const exact = await assertSafeUrl("https://internal.test/x", {
      allowPrivate: false,
      allowlist: ["internal.test"],
    });
    assert.equal(exact.hostname, "internal.test");
    const sub = await assertSafeUrl("https://api.internal.test/x", {
      allowPrivate: false,
      allowlist: ["internal.test"],
    });
    assert.equal(sub.hostname, "api.internal.test");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("fetchUrl", () => {
  beforeEach(() => {
    restoreFetch();
  });

  it("non-2xx → { ok:false, reason:'HTTP <status>' }", async () => {
    stubFetchSequence([{ status: 404, headers: { "content-type": "text/html" }, body: "nope" }]);
    const res = await fetchUrl("https://example.com/missing");
    restoreFetch();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /HTTP 404/);
  });

  it("disallowed content-type → ok:false", async () => {
    stubFetchSequence([{ status: 200, headers: { "content-type": "image/png" }, body: "PNG" }]);
    const res = await fetchUrl("https://example.com/img.png");
    restoreFetch();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /content-type/i);
  });

  it("HTML → cleaned text + <title> extraction; scripts/styles skipped", async () => {
    const html =
      "<html><head><title>  Hello &amp; World </title><style>.x{}</style></head>" +
      "<body><script>var a=1;</script><nav>menu</nav><p>Visible paragraph.</p></body></html>";
    stubFetchSequence([{ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: html }]);
    const res = await fetchUrl("https://example.com/");
    restoreFetch();
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.title, "Hello & World");
      assert.match(res.text, /Visible paragraph\./);
      assert.doesNotMatch(res.text, /var a=1/);
      assert.doesNotMatch(res.text, /\.x\{\}/);
    }
  });

  it("plain text passes through untouched", async () => {
    stubFetchSequence([{ status: 200, headers: { "content-type": "text/plain" }, body: "raw text body" }]);
    const res = await fetchUrl("https://example.com/file.txt");
    restoreFetch();
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.title, null);
      assert.equal(res.text, "raw text body");
    }
  });

  it("oversize body → truncated:true and text capped", async () => {
    const big = "A".repeat(5000);
    stubFetchSequence([{ status: 200, headers: { "content-type": "text/plain" }, body: big }]);
    const res = await fetchUrl("https://example.com/big", { maxBytes: 1000, maxReturnChars: 1000 });
    restoreFetch();
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.truncated, true);
      assert.ok(res.text.length <= 1000, `text length ${res.text.length} should be <= 1000`);
    }
  });

  it("timeout (AbortError) → ok:false", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    const res = await fetchUrl("https://example.com/slow", { timeoutMs: 5 });
    restoreFetch();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /timed out/i);
  });

  it("follows a safe redirect to a public target", async () => {
    const seq = stubFetchSequence([
      { status: 302, headers: { location: "https://public.test/final" } },
      { status: 200, headers: { "content-type": "text/plain" }, body: "after redirect", url: "https://public.test/final" },
    ]);
    const res = await fetchUrl("https://example.com/start");
    restoreFetch();
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.text, "after redirect");
    assert.equal(seq.calls.length, 2);
  });

  it("redirect to a private address is blocked on re-validation", async () => {
    stubFetchSequence([
      { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
      { status: 200, headers: { "content-type": "text/plain" }, body: "SECRET" },
    ]);
    const res = await fetchUrl("https://example.com/start");
    restoreFetch();
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /private|loopback|link-local/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("researchUrl", () => {
  beforeEach(() => {
    state.embedCalls = [];
    state.upsertCalls = [];
    state.deleteCalls = [];
    restoreFetch();
  });

  it("happy path: chunks, embeds, deletes-then-upserts with correct file_origin + metadata", async () => {
    const md = "# Heading One\n\n" + "Body content for the page. ".repeat(5);
    stubFetchSequence([
      { status: 200, headers: { "content-type": "text/markdown" }, body: md, url: "https://example.com/doc" },
    ]);

    const res = await researchUrl({ url: "https://example.com/doc" });
    restoreFetch();

    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(res.project_id, "test-project");
    assert.equal(res.source_url, "https://example.com/doc");
    assert.ok(res.chunks_stored >= 1);

    // embed called once with chunk contents.
    assert.equal(state.embedCalls.length, 1);
    assert.ok(state.embedCalls[0]!.texts.length >= 1);

    // delete-before-insert refresh: delete called for the URL BEFORE upsert.
    assert.equal(state.deleteCalls.length, 1);
    assert.deepEqual(state.deleteCalls[0], {
      projectId: "test-project",
      fileOrigin: "https://example.com/doc",
    });

    // upsert called with rows carrying the right file_origin + web metadata.
    assert.equal(state.upsertCalls.length, 1);
    const call = state.upsertCalls[0]!;
    assert.equal(call.projectId, "test-project");
    assert.equal(call.rows.length, res.chunks_stored);
    const row0 = call.rows[0]!;
    assert.equal(row0.file_origin, "https://example.com/doc");
    assert.ok(Array.isArray(row0.embedding));
    assert.equal(typeof row0.file_hash, "string");
    const meta = row0.metadata as Record<string, unknown>;
    assert.equal(meta.type, "LOG");
    assert.equal(meta.kind, "web");
    assert.equal(meta.source_url, "https://example.com/doc");
    assert.equal(typeof meta.fetched_at, "string");
  });

  it("propagates a fetch failure (ok:false) without writing", async () => {
    stubFetchSequence([{ status: 500, headers: { "content-type": "text/html" }, body: "err" }]);
    const res = await researchUrl({ url: "https://example.com/boom" });
    restoreFetch();
    assert.equal(res.ok, false);
    assert.equal(state.embedCalls.length, 0);
    assert.equal(state.upsertCalls.length, 0);
    assert.equal(state.deleteCalls.length, 0);
  });

  it("rejects a missing url argument", async () => {
    const res = await researchUrl({ url: "" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /url/i);
  });
});
