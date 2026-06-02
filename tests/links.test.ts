// Unit tests for src/web/links.ts — pure, hermetic (no network, no DOM).
// Covers relative resolution, same-origin filtering, normalization + dedup,
// and malformed-href tolerance. Runtime: node:test + node:assert/strict.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractLinks, normalizeUrl, sameOrigin } from "../src/web/links.js";

describe("normalizeUrl", () => {
  test("drops the #fragment", () => {
    assert.equal(
      normalizeUrl("https://docs.test/a#section"),
      "https://docs.test/a",
    );
  });

  test("collapses empty path to /", () => {
    assert.equal(normalizeUrl("https://docs.test"), "https://docs.test/");
  });

  test("strips a trailing slash on non-root paths", () => {
    assert.equal(normalizeUrl("https://docs.test/a/"), "https://docs.test/a");
    // root slash is preserved
    assert.equal(normalizeUrl("https://docs.test/"), "https://docs.test/");
  });

  test("drops default ports (80/443)", () => {
    assert.equal(normalizeUrl("http://docs.test:80/a"), "http://docs.test/a");
    assert.equal(normalizeUrl("https://docs.test:443/a"), "https://docs.test/a");
  });

  test("preserves a non-default port", () => {
    assert.equal(
      normalizeUrl("http://docs.test:8080/a"),
      "http://docs.test:8080/a",
    );
  });

  test("preserves the query string (distinct pages stay distinct)", () => {
    assert.equal(
      normalizeUrl("https://docs.test/a?page=2"),
      "https://docs.test/a?page=2",
    );
  });

  test("returns null for an unparseable URL", () => {
    assert.equal(normalizeUrl("not a url"), null);
    assert.equal(normalizeUrl("/relative/only"), null);
  });
});

describe("sameOrigin", () => {
  test("true for identical scheme+host+port", () => {
    assert.equal(
      sameOrigin("https://docs.test/a", "https://docs.test/b"),
      true,
    );
  });

  test("false across host, scheme, or port", () => {
    assert.equal(sameOrigin("https://a.test/", "https://b.test/"), false);
    assert.equal(sameOrigin("http://docs.test/", "https://docs.test/"), false);
    assert.equal(
      sameOrigin("https://docs.test:8443/", "https://docs.test/"),
      false,
    );
  });

  test("false when either side is unparseable", () => {
    assert.equal(sameOrigin("garbage", "https://docs.test/"), false);
  });
});

describe("extractLinks", () => {
  const base = "https://docs.test/guide/intro";
  const origin = "https://docs.test";

  test("resolves relative hrefs against the base URL", () => {
    const html = `
      <a href="../api">API</a>
      <a href="setup">Setup</a>
      <a href="/top">Top</a>
    `;
    const links = extractLinks(html, base, origin);
    assert.ok(links.includes("https://docs.test/api"), "../api resolves up one");
    assert.ok(
      links.includes("https://docs.test/guide/setup"),
      "relative sibling resolves",
    );
    assert.ok(links.includes("https://docs.test/top"), "/top is root-relative");
  });

  test("keeps only same-origin links", () => {
    const html = `
      <a href="https://docs.test/in">in</a>
      <a href="https://evil.test/out">out</a>
      <a href="http://docs.test/scheme">scheme-mismatch</a>
    `;
    const links = extractLinks(html, base, origin);
    assert.ok(links.includes("https://docs.test/in"));
    assert.ok(!links.some((l) => l.includes("evil.test")), "cross-origin dropped");
    assert.ok(
      !links.includes("http://docs.test/scheme"),
      "scheme mismatch is a different origin",
    );
  });

  test("dedups after normalization (fragment + trailing slash)", () => {
    const html = `
      <a href="/a">a</a>
      <a href="/a/">a slash</a>
      <a href="/a#frag">a frag</a>
    `;
    const links = extractLinks(html, base, origin);
    const aCount = links.filter((l) => l === "https://docs.test/a").length;
    assert.equal(aCount, 1, "the three /a variants collapse to one");
  });

  test("tolerates malformed hrefs and skips non-navigational schemes", () => {
    // Note on WHATWG URL semantics: an href whose scheme is invalid (e.g.
    // "ht!tp:") is NOT a parse error — it is treated as a RELATIVE reference and
    // resolved against the base, so it survives as a same-origin path. Only
    // hrefs that genuinely throw new URL() or carry a non-navigational scheme
    // are dropped. The crawler tolerates the odd surviving path (it simply 404s
    // and is recorded as skipped during the crawl).
    const html = `
      <a href="">empty</a>
      <a href="   ">whitespace</a>
      <a href="mailto:x@y.test">mail</a>
      <a href="javascript:void(0)">js</a>
      <a href="tel:+1234">tel</a>
      <a href="data:text/html,x">data</a>
      <a href="#only">frag-only</a>
      <a href="/ok">ok</a>
    `;
    const links = extractLinks(html, base, origin);
    assert.deepEqual(links, ["https://docs.test/ok"], "only the valid link survives");
  });

  test("does not throw on a href that fails URL resolution", () => {
    // A backslash-laden / control-char href can still resolve under WHATWG; the
    // contract is simply that extractLinks NEVER throws — it returns whatever
    // valid same-origin links it found and silently drops the rest.
    const html = `<a href="http://">no-host</a><a href="/good">good</a>`;
    let links: string[] = [];
    assert.doesNotThrow(() => {
      links = extractLinks(html, base, origin);
    });
    assert.ok(links.includes("https://docs.test/good"));
    assert.ok(!links.some((l) => l === "http://"), "the host-less URL is dropped");
  });

  test("handles single-quoted and unquoted href values", () => {
    const html = `<a href='/single'>s</a><a href=/bare>b</a>`;
    const links = extractLinks(html, base, origin);
    assert.ok(links.includes("https://docs.test/single"));
    assert.ok(links.includes("https://docs.test/bare"));
  });

  test("empty html yields no links", () => {
    assert.deepEqual(extractLinks("", base, origin), []);
  });
});
