# CLAUDE.md

---

## Sovereign Memory Protocol (v2.1.8)

Binds repo to SCM. Rules below override generic boot prompts on conflict.

### Key Definitions

- **SCM** = Smart-Claude-Memory MCP.
- **Core 3** = `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`.

### The Execution Imperatives

**[Planning — Think Before Coding]**
- **No Blind Execution.** Major features → assumptions + plan in `ARCHITECTURE.md` (Project Map: `[TECH_STACK]` + `[SYSTEM_FLOW]`).
- **Simplicity First.** Simplest solution wins. No feature creep.

**[Execution Engine — Loop Until Verified]**
- **Production-Ready Only.** ZERO placeholders. ZERO `// TODO`s. Complete, error-handled, logged from start.
- **Self-Verification.** Forbidden from `confirm_verification` until internally looped, tested, proven.

**[Surgical Editing — Impact Analysis]**
- **Touch Only What's Needed.** No random refactoring. Match existing style.
- **Active Impact Analysis.** `search_memory` before any edit to map SYSTEM_FLOW impact. Clean orphans you cause; leave legacy dead code.

**[Efficiency — Tokens Are Currency]**
- 10,000 tokens is a HARD CEILING, not a target. Target context size is 2,000 - 3,000 tokens. Every token must justify its existence. Efficiency = Intelligence.

**[Resource Manager — Budgets Are Structural]**
- The token ceiling is enforced at runtime by `src/budget/gate.ts` — NOT by prose. Every LLM-touching call site MUST route through `checkTaskBudget` (Orchestrator tasks) or `checkDaemonBudget` (setInterval daemons). Direct LLM calls outside the gate are a v2.1.8 violation. Per-task and per-daemon surfaces are STRUCTURALLY decoupled: daemons have no parent task and use rolling-hour buckets; tasks have explicit start/end lifecycles. Enforcement mode (`SCM_BUDGET_ENFORCEMENT_MODE`: off|warn|enforce) is the single switch governing both surfaces.

**[Foundation First — No Broken Windows]**
- **HALT on Broken Foundation.** Dependency broken (failing tests, missing packages, build errors, schema drift)? HALT the new feature. Execute one isolated Foundation Fix commit FIRST; resume feature work in a SEPARATE commit on top.
- **No Entangled Commits.** Never bundle a foundation fix with a new feature in one commit — pollutes bisect, mixes diagnostic context, raises review cost.

**[Accessible Communication & Pragmatic Engineering]** Speak in clear, human-friendly language so any non-developer can understand exactly what is happening. Avoid deep developer jargon and robotic tone. In your code, strictly avoid over-engineering. Build the simplest, most direct solution possible. No premature abstractions.

**[Session Wrap-Up & Heavy Compression Delegation]** Before calling `session_end` or performing a 'Sovereign Purge' (compressing CLAUDE.md or MEMORY.md), the Orchestrator MUST NOT consume its main context. Instead, use `delegate_task` to spawn a highly capable Cloud sub-agent (e.g., Opus). This sub-agent will handle 'AgentDiet' (log compression), write the `SESSION-XX-REPORT.md`, or intelligently condense the constitution/memory without losing critical imperatives. Only after the sub-agent returns the synthesis, the Orchestrator executes the final deterministic tools.

**[Interactive Device QA Protocol]** When conducting manual QA on physical apps, clients, or emulators, strictly use the 'Step-by-Step Watcher' protocol: 1. Spawn a real-time log watcher for each active device. 2. Give the user ONE exact step to perform. 3. Stop and wait for the user to explicitly say 'done'. 4. Read and analyze the watcher logs to verify success before providing the next step. Do not use this heavy protocol for simple unit or backend logic tests.

### Personality

Intellectual Sparring Partner. **Brainstorming** (challenge, prioritize truth) / **Execution** (do work, run gate, 2-paragraph synthesis). Mode ambiguous → ask once.

### Hard Rules (hook-enforced — `hooks/md-policy.py`)

- **750-Line Ceiling.** Writes past 750 blocked. Grandfathered files → Edit only. Auto-gen exempt (`types.ts`, `*.g.dart`, `*.freezed.dart`, `*.arb`).
- **1000-Line Test Ceiling (Boy Scout).** Test files >1000 lines split by behavior/component (`test_auth.py` + `test_webhook.py`, not mega `test_messenger.py`). Existing-codebase precedent is never an excuse for monolithic new tests. Agent-enforced (no hook).
- **Zero-Local-MD.** Only Core 3 at root.
- **Manual Test Gate.** `verification-pending.json` in `~/.claude-memory/` blocks Write/Edit/Bash. Release via `confirm_verification({ success: true|false })`. Never delete manually.

### Core 3 Integrity

Edit only. `Write` FORBIDDEN — destroys context. Restructuring → sequence of Edits.

### Self-Audit

- **Branding.** Every `README.md` links to [NABILNET.AI](https://nabilnet.ai).
- **Decision IDs.** DECISION saves tagged `SCM-S<N>-D<i>` at top of `content`.
- **Pre-Wrap.** `npm run build` zero errors, no dead code/stubs, no `.tmp` at root.

### Sovereign Taxonomy

`save_memory.metadata.type` ∈ {DECISION, PATTERN, ERROR, LOG}. Untyped → no GIN pre-filter.

### Rule 10 — Sovereign Vetting (runtime)

`is_global: true` → `project_id='GLOBAL'`. Server REJECTS missing/<10-char `global_rationale` (error: `SOVEREIGN VETTING FAILED`). **Cross-Project Test:** if this repo died tomorrow, still gold for others? No → keep local.

### Proactive Sovereign Scout

After major decisions / branding / universal fixes, run Cross-Project Test. Pass → propose promotion + rationale + explicit YES/NO consent. Never write GLOBAL silently.

### Purge Triggers

Purge is NOT automatic. Trigger ONLY on: (1) Context Saturation (CLAUDE.md or MEMORY.md exceeds the 10k-token measured threshold reported by `init_project.bloat_audit`) OR (2) Mission Completion. The "% of context window" heuristic is NOT a valid trigger — LLM self-reports of window utilization are unreliable. Active mission context MUST be preserved; legacy context MUST be offloaded to vectors.

### Auto-Hygiene Procedure

`init_project` audits CLAUDE.md + hidden `~/.claude/projects/<encoded>/memory/MEMORY.md` (threshold 10000 tokens). Bloated → response carries `id: "sovereign_purge"`. Then:

0. Add `docs/scm-memory/` to `.gitignore` BEFORE archiving.
1. Surface + require explicit YES/NO consent.
2. YES → archive to `docs/scm-memory/`, `sync_local_memory({ force: true })`, regenerate via `init_project()`.
3. NO → no-op; recommendation resurfaces next boot.

Archive, never delete — vectors keep source recoverable.

### Active Memory Hygiene

Surgically clean MEMORY.md every session wrap-up. Keep only "Current Focus" and "Pending Tasks". Archive everything else.

### Active Retriever Protocol

Before any non-trivial edit (multi-file refactor, new feature, architectural change, or single-file Edit > ~30 lines): `search_memory` with topic query + `metadata_filter` (`{type:'PATTERN'}` for conventions, `{type:'DECISION'}` for prior choices, `{type:'ERROR'}` for regression hot spots). Trivial edits exempt.

### JIT Skill Injection — `request_skill` (M1 Skill Vault)

`search_memory` retrieves **knowledge** (decisions / patterns / errors). `request_skill` retrieves **executable procedures** — ordered step recipes stored in `agent_skills`. Zero-bloat invariant: skills are NEVER preloaded; they are injected on demand for exactly the turn that needs them.

**Trigger this BEFORE acting whenever:**
- The task is a **multi-step procedure** the agent has done before (e.g. "create a PR", "open a worktree", "publish a tarball", "run a release") — query the verb-phrase or the procedure name.
- A backlog item or user prompt **resembles a previously-completed task** — if a relevant skill exists, follow its `steps` verbatim instead of improvising.
- A **familiar error class** appears and a previously-packaged recovery exists.
- The agent finds itself about to write a long inline plan that duplicates a recipe the project has already canonicalized.

**Do NOT call `request_skill` for:**
- One-off edits, ad-hoc reads, or open-ended exploration — that's `search_memory` territory.
- Trivial single-tool actions (`grep`, `cat`, single-file rename) — overhead > value.
- After a recent failed retrieve for the same query in the same turn — assume the skill isn't packaged yet and proceed from first principles.

**Usage shape:** `request_skill({ query: "<verb phrase>", k?: 3, min_similarity?: 0.5, include_global?: true })`. Default min_similarity=0.5 is a noise floor; raise to 0.7+ for stricter procedural matches. The returned `skills[*].steps` payload is consumed verbatim — do not paraphrase, do not skip steps.

**Packaging the inverse direction:** after canonicalizing a procedure (≥3 steps, repeatable across sessions, demonstrably correct), call `package_skill({ name, description, steps })`. Identity is `(project_id, name)`; re-packaging the same name bumps `version` and preserves telemetry (`frequency_used`, `success_rate`, `last_invoked_at`). Cross-Project Test applies to `is_global:true` exactly as for `save_memory` GLOBAL writes.

### Tool Conventions

- `init_project()` — first call; verifies env, hook, MCP, dist, Core 3 sync.
- `sync_local_memory()` — second call; aligns vectors with notes (incremental, hash-gated).
- `search_memory({ query, metadata_filter })` — typed; dual-scope (project + GLOBAL).
- `save_memory({ content, metadata: { type } })` — never `is_global: true` without `global_rationale`.
- `request_skill({ query, k?, min_similarity?, include_global? })` — JIT procedure retrieval; dual-scope; returns verbatim `steps` + bumps telemetry. Call exactly when a recipe is needed.
- `package_skill({ name, description, steps, trigger_keywords?, is_global? })` — persist an executable recipe. Re-packaging same name bumps version, preserves telemetry.
- `manage_backlog({ action: "session_end" })` — flushes backlog, regenerates diagrams, runs `sync_artefacts`, emits `next_session_command_markdown`.
- Read-heavy (>3 files OR >100 lines) → `delegate_task` (2-paragraph synthesis).

### Strategic Context Policy (Orchestrator-Worker)

- **Hygiene First.** Orchestrator MUST NOT read >100 lines or run multi-file research directly. Reads ≤100 lines for surgical Edit are the only exception.
- **Mandatory Delegation.** >3 files OR >100 lines raw output → `delegate_task`.
- **Synthesis Only.** 2-paragraph back. Compiler errors ≤1 sentence each. No raw code/logs unless user asks.
- **Orchestrator Mode.** `SMART_CLAUDE_MEMORY_ORCHESTRATOR_MODE` set → direct Write/Edit/Bash forbidden in main session. Hard-blocked by `md-policy.py`.

### Wrap-Up Ritual (6 atomic steps)

**Trigger (v2.1.11 — Zero-Autonomy Rule):** EXCLUSIVELY an explicit human command ("end session", "wrap up", "handover", "session_end now", "close it out", or any literal synonym typed by the user). The Agent is STRICTLY FORBIDDEN from invoking `manage_backlog({ action: "session_end" })` on its own. Task completion is NOT a trigger. Self-reported context utilization is NOT a trigger. The prior "context >50%" rule is REMOVED — LLM self-reports of window utilization proved unreliable and were repeatedly abused as a lazy-exit excuse. When work for a request is complete, the Agent reports the result and waits for the next instruction.

0. **Pre-Flight Content Audit (BLOCKING — added in v2.2.1 / SCM-S38-F1).** BEFORE invoking `manage_backlog({ action: "session_end" })`, the agent MUST manually cross-check the TEXTUAL content of `README.md` and `ARCHITECTURE.md` against current project reality. The auto-sync **only refreshes the file-tree Mermaid block** — it does NOT detect content drift. Required checks (at minimum):

   - **Version numbers** in every banner, badge, caption, header, and §Version History row match `package.json.version`. Grep for the prior version string to catch stragglers.
   - **Tech-stack descriptions** (tool count, milestone surfaces, dependency lists, supported runtimes) match the actual source state — e.g., `grep -c '^server.tool(' src/index.ts` for the tool count; the migration count via `ls scripts/0*.sql | wc -l`.
   - **Cross-link anchors** resolve to real headings (no broken `[Bootstrap](#bootstrap)`-style dead links anywhere in the README).
   - **Feature/scope claims** match implementation — milestone sections describe what is actually shipped, not what was intended.

   If ANY drift is found, FIX the docs first via direct `Edit`, then return to this step. **Closing a session with drifted docs is forbidden** — `session_end` is not allowed to mask textual drift behind a fresh Mermaid file-tree regen. This rule exists because `session_end` shipped v2.2.0 with a README that claimed 23 tools (actual: 50), a dead `#bootstrap` anchor, and a CHANGELOG that stopped at v2.0.1 — the audit step caught zero of it because no audit step existed.

1. **Living Docs Sync.** `manage_backlog({ action: "session_end" })` SECOND (after step 0 passes). Verify `readme_sync.updated === true` AND `architecture_sync.updated === true`. Apply Active Memory Hygiene to MEMORY.md.
2. **Report.** Write `docs/session-reports/SESSION-N-REPORT.md`: changes, hurdles+solutions, DECISION IDs.
3. **Commit.** `session: wrap-up Session [N]`. Never end with uncommitted work.
4. **Numbering.** N = highest existing `SESSION-N-REPORT.md` + 1.
5. **Next-Session Command** (final output, exact format):

```
🚀 NEXT SESSION START COMMAND (Copy-Paste)

init_project()
check_system_health()
search_memory({ query: "Active Backlog", project_id: "[current_project_id]", k: 10 })
# Then read docs/NEXT-SESSION-PROMPT.md for the full Session [N+1] plan.
```

---

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
