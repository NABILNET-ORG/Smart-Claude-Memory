// Tests for src/trajectory/summarizer.ts.
// Uses Node 22+ `mock.module` to stub the `../ollama.js` import without touching disk.
// Runtime: node:test + node:assert/strict.

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type ChatCall = { messages: unknown[]; opts: { model?: string; temperature?: number; timeoutMs?: number } | undefined };

// Mutable hook the mocked chat() reads from. Each test sets these before importing.
let chatImpl: (messages: unknown[], opts?: ChatCall["opts"]) => Promise<string> = async () => "";
const chatCalls: ChatCall[] = [];

// Install the module mock BEFORE importing summarizer.ts. mock.module hoisting
// is not automatic in node:test (unlike Vitest), so we register it here at
// top-level and only then dynamically import the target.
mock.module("../src/ollama.js", {
  namedExports: {
    chat: (messages: unknown[], opts?: ChatCall["opts"]) => {
      chatCalls.push({ messages, opts });
      return chatImpl(messages, opts);
    },
    // The summarizer doesn't use embed/captionImage but we expose minimal stubs
    // in case the import surface is loaded eagerly.
    embed: async () => [] as number[][],
    captionImage: async () => "",
  },
});

const { summarizeTrajectory } = await import("../src/trajectory/summarizer.js");

describe("summarizeTrajectory", () => {
  beforeEach(() => {
    chatCalls.length = 0;
    chatImpl = async () => "";
  });

  describe("input validation", () => {
    it("throws on empty input", async () => {
      await assert.rejects(
        () => summarizeTrajectory(""),
        (err: Error) => err.message === "summarizeTrajectory: empty input",
      );
    });

    it("throws on whitespace-only input", async () => {
      await assert.rejects(
        () => summarizeTrajectory("   \n\t  \n"),
        (err: Error) => err.message === "summarizeTrajectory: empty input",
      );
    });
  });

  describe("happy path", () => {
    it("returns trimmed summary, token count, and default model", async () => {
      const reply = "Agent compacted logs for session 17.";
      chatImpl = async () => reply;

      const out = await summarizeTrajectory("some stripped trajectory log here");

      assert.equal(out.summary, reply);
      assert.equal(out.summaryTokens, Math.ceil(reply.length / 4));
      assert.equal(out.model, "gemma3:e2b");
      assert.equal(chatCalls.length, 1);
    });

    it("honors a custom model and forwards it to chat()", async () => {
      chatImpl = async () => "ok";
      const out = await summarizeTrajectory("payload", { model: "qwen2:7b" });
      assert.equal(out.model, "qwen2:7b");
      assert.equal(chatCalls.length, 1);
      assert.equal(chatCalls[0]!.opts?.model, "qwen2:7b");
    });

    it("sends the system + user prompts to chat()", async () => {
      chatImpl = async () => "done";
      await summarizeTrajectory("the payload");
      const [{ messages }] = chatCalls as Array<{ messages: Array<{ role: string; content: string }> }>;
      assert.equal(messages.length, 2);
      assert.equal(messages[0]!.role, "system");
      assert.equal(messages[1]!.role, "user");
      assert.ok(
        messages[1]!.content.endsWith("the payload"),
        "user prompt should end with the stripped input",
      );
    });
  });

  describe("post-processing", () => {
    it("strips a 'Summary:' preamble", async () => {
      chatImpl = async () => "Summary: the agent ran tests.";
      const out = await summarizeTrajectory("x");
      assert.equal(out.summary, "the agent ran tests.");
    });

    it("strips stacked preambles (up to 3 times)", async () => {
      chatImpl = async () => "Summary: Summary: Summary: clean text.";
      const out = await summarizeTrajectory("x");
      assert.equal(out.summary, "clean text.");
    });

    it("collapses newlines into spaces", async () => {
      chatImpl = async () => "line1\nline2\nline3";
      const out = await summarizeTrajectory("x");
      assert.ok(!out.summary.includes("\n"), "summary still contains newline");
      assert.equal(out.summary, "line1 line2 line3");
    });

    it("collapses CRLF and tabs into single spaces", async () => {
      chatImpl = async () => "a\r\nb\r\n\tc";
      const out = await summarizeTrajectory("x");
      assert.ok(!out.summary.includes("\n"));
      assert.ok(!out.summary.includes("\r"));
      assert.equal(out.summary, "a b c");
    });

    it("truncates summaries over 400 chars at a sentence boundary", async () => {
      const sentence = "This is a complete sentence. "; // 29 chars
      // Build ~600 chars worth of complete sentences.
      const reply = sentence.repeat(22).trim();
      assert.ok(reply.length > 400, "fixture must exceed 400 chars");
      chatImpl = async () => reply;

      const out = await summarizeTrajectory("x");
      assert.ok(out.summary.length <= 400, `len ${out.summary.length}`);
      // Must end on a sentence-terminating punctuation (period, !, ?).
      const last = out.summary.slice(-1);
      assert.ok([".", "!", "?"].includes(last), `unexpected last char "${last}"`);
    });
  });

  describe("abort propagation", () => {
    it("rejects with the summarizer's AbortError message when signal aborts first", async () => {
      const controller = new AbortController();
      // chat() never resolves so the race is decided by abort.
      chatImpl = () => new Promise(() => {});
      const promise = summarizeTrajectory("payload", { signal: controller.signal });
      controller.abort();
      await assert.rejects(
        () => promise,
        (err: Error) => err.message === "summarizeTrajectory: aborted",
      );
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      chatImpl = async () => "should not matter";
      await assert.rejects(
        () => summarizeTrajectory("payload", { signal: controller.signal }),
        (err: Error) => err.message === "summarizeTrajectory: aborted",
      );
    });
  });
});
