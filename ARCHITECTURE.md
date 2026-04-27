# Smart Claude Memory — System Architecture (v1.1.3)

> **Stable baseline:** v1.1.3 — Seamless Onboarding & Version SSOT (Smart Claude Memory v1.1.0 Sovereign Orchestrator feature set, sealed with master schematic).
> This document is the single source of truth for the system's structure and control flow. The marker-bounded Mermaid block in §4 is refreshed automatically by `sync_artefacts` after every worker success; the other diagrams are hand-maintained.

![Smart Claude Memory v1.1.3 Schematic](images/Smart%20Claude%20Memory%20v.1.1.2.jpeg)

*Master schematic — the definitive visual reference for the Smart Claude Memory v1.1.3 production baseline.*

---

## 1. The Sovereign Orchestrator Pattern

The **Orchestrator** (the main Claude session) never edits code, runs builds, or reads large files directly. Every unit of execution is delegated to a **Background Worker** — an Agent sub-process spawned via `delegate_task`, isolated in its own context window. The worker returns only a 2-paragraph synthesis. This keeps the Orchestrator's context lean and enforces a clean separation between strategic decisions and tactical execution.

### 1.1 Delegation flow

```mermaid
flowchart TD
    subgraph ORC["Orchestrator (Main Session) — strategic context only"]
        U[User request]
        D[delegate_task]
        S[sync_artefacts]
        R[Report 2-para synthesis to user]
    end

    subgraph WRK["Background Worker (Isolated context)"]
        E[Edits / Bash / Research]
        G[refactor_guard gate]
        H{Gate OK?}
        HL[Self-Healing Loop]
        RB[refactor_guard rollback]
        SY[Emit 2-para synthesis]
    end

    U --> D
    D -->|canonical worker prompt| E
    E --> G
    G --> H
    H -->|pass| SY
    H -->|fail| HL
    HL -->|healed| G
    HL -->|exhausted| RB
    RB --> SY
    SY -->|only synthesis returns| S
    S --> R
```

### 1.2 Context-hygiene contract
- Workers MUST NOT return raw file contents, full stack traces, or long logs to the Orchestrator.
- Each compiler error is summarized in ≤ 1 sentence (error code + symbol).
- Paragraph 2 of the synthesis records gate result (pass first-try / passed after N heals / rolled back) and any healing hypotheses tested.

---

## 2. Autonomous Self-Healing Loop (v1.1.0)

When the compile gate fails, the worker does **not** bounce the failure back to the Orchestrator. Instead, it diagnoses the regression against the nearest clean backup and applies a minimal local fix. Only if the loop exhausts (default 3 attempts) does it rollback and report surrender.

```mermaid
flowchart LR
    G1[refactor_guard gate] -->|pass| DONE([Emit synthesis])
    G1 -->|fail| AR[analyze_regression<br/>file + backups_to_compare]
    AR --> CP[closest_prior backup<br/>smallest edit distance]
    CP --> LF[Minimal local fix<br/>preserves feature intent]
    LF --> G2[refactor_guard gate]
    G2 -->|pass| DONE
    G2 -->|fail and attempts lt max| NEXT[Change hypothesis]
    NEXT --> AR
    G2 -->|attempts equal max| RBK[refactor_guard rollback]
    RBK --> DONE
```

### 2.1 Primitives
| Primitive | Tool call | Purpose |
|---|---|---|
| Gate | `refactor_guard({ action: "gate" })` | Single source of compile truth — dispatches to the stack's native analyzer. |
| Analyze | `analyze_regression({ file, backups_to_compare })` | Diffs current file against recent backups; surfaces `closest_prior` to guide the minimal fix. |
| Rollback | `refactor_guard({ action: "rollback", file })` | Restores pre-edit backup. Last resort only. |

### 2.2 Healing constraints
- **Minimal fix, not wholesale restore** — the feature edit must survive; the fix only reintroduces what regressed.
- **No repeated hypotheses** — each attempt changes approach.
- **Strictly local** — never ask the Orchestrator for more context while attempts remain.

---

## 3. Multi-Stack Compiler Map

`refactor_guard` auto-detects the stack from project artifacts and dispatches to the native analyzer. This is what makes the gate stack-agnostic.

```mermaid
flowchart TB
    P[Project root] --> D{Detect stack}
    D -->|package.json + tsconfig.json| TS[tsc --noEmit]
    D -->|package.json only| NODE[npm run build / lint]
    D -->|pubspec.yaml| FL[flutter analyze / dart analyze]
    D -->|Cargo.toml| RS[cargo check]
    D -->|pyproject.toml| PY[mypy / ruff]
    D -->|go.mod| GO[go vet / go build]
    TS --> OUT[Exit code + summarized output]
    NODE --> OUT
    FL --> OUT
    RS --> OUT
    PY --> OUT
    GO --> OUT
```

### 3.1 Cross-platform spawn (v1.1.0 fix)
Native tool launchers on Windows resolve to `.cmd` / `.bat` shims (`npx.cmd`, `flutter.bat`). Node's `child_process.spawn` without `shell: true` cannot invoke these — it throws `EINVAL`. The v1.1.0 `runBin` in `src/tools/refactor.ts` detects `process.platform === 'win32'` and sets `shell: true` so shim resolution works through `cmd.exe`. Args are internal-only (no user input), so shell-injection risk does not apply.

### 3.2 Version Single Source of Truth (v1.1.3)
The version string is owned by `package.json`. `src/version.ts` reads it once via `createRequire(import.meta.url)` and re-exports `VERSION`. All consumers — `src/index.ts` (McpServer registration), `src/tools/health.ts` (the `orchestrator.version` field on `HealthReport`, whose type was widened from the literal `"1.1.0"` to `string` to accept any future bump), and `src/tools/orchestrator.ts` (the `delegateTask` response envelope) — import that one constant. There are no hard-coded version literals in the source tree, so `check_system_health` always reports exactly what `package.json` says and a release bump propagates with a single edit.

### 3.3 Policy Hydration & Smart-Scout Onboarding (v1.1.3)
`batch_freeze_patterns` (in `src/tools/batch-freeze-patterns.ts`) hydrates the frozen-pattern cache from either glob `paths` or a markdown rule file. When `from_rule_file` is supplied, extraction is strict: it scans only the section under an exact `## Frozen Patterns` heading, strips backticks and list markers, and skips any line containing unescaped spaces. The shared loader at `src/tools/frozen-cache.ts` migrates legacy string entries to the `{ pattern, source, added_at }` schema on read, writes atomically via `<file>.tmp` + `rename`, and dedups on trimmed pattern equality (first-writer-wins). Every consumer — `list_frozen`, `freeze_file`, `unfreeze_file`, and `supabase.writeFrozenPatternsCache` — funnels through the same loader. The `source` field unlocks idempotent re-hydration and the suppression logic below.

`init_project` (in `src/tools/setup.ts`) closes the onboarding loop. Beyond the readiness checks, it does a quick local scan: if `.claude/rules/` exists, it peeks the first ~200 lines of each immediate-child `.md` for an exact `## Frozen Patterns` line. It then loads the project's frozen cache via `loadFrozenCache()` and drops any candidate already represented in `entry.source` (after path normalization — workspace-relative, forward slashes, lowercased on Win32). What survives is emitted as a structured `recommendations: [{ id: "hydrate_policies", tool: "batch_freeze_patterns", candidates, suggested_first_call: { from_rule_file, dry_run: true } }]` block. The key is omitted entirely when nothing is actionable, and the scout never mutates the cache — it surfaces a recommended `dry_run` call for the operator to consent to.

---

## 4. File Architecture (auto-generated)

The Mermaid block below is refreshed by `sync_artefacts` after every worker success. Do not edit content between the markers by hand.

<!-- MEMORY:ARCH:START -->

```mermaid
%% Auto-generated. Do not edit between the MEMORY:ARCH markers.
flowchart TD
  n0["Claude-Memory/"]
  n1["hooks/"]
  n0 --> n1
  n2["md-policy.py"]
  n1 --> n2
  n3["README.md"]
  n1 --> n3
  n4["images/"]
  n0 --> n4
  n5["Smart Claude Memory v.1.1.2.jpeg"]
  n4 --> n5
  n6["scripts/"]
  n0 --> n6
  n7["001_schema.sql"]
  n6 --> n7
  n8["002_multi_project.sql"]
  n6 --> n8
  n9["003_file_hash.sql"]
  n6 --> n9
  n10["004_backlog_frozen.sql"]
  n6 --> n10
  n11["005_archive_backlog.sql"]
  n6 --> n11
  n12["apply-schema.ts"]
  n6 --> n12
  n13["backup-and-remove.ts"]
  n6 --> n13
  n14["e2e-incremental-test.ts"]
  n6 --> n14
  n15["e2e-isolation-test.ts"]
  n6 --> n15
  n16["e2e-test.ts"]
  n6 --> n16
  n17["purge-samia-rules.ts"]
  n6 --> n17
  n18["src/"]
  n0 --> n18
  n19["tools/"]
  n18 --> n19
  n20["backlog.ts"]
  n19 --> n20
  n21["batch-freeze-patterns.ts"]
  n19 --> n21
  n22["conflict.ts"]
  n19 --> n22
  n23["frozen-cache.ts"]
  n19 --> n23
  n24["health.ts"]
  n19 --> n24
  n25["hygiene.ts"]
  n19 --> n25
  n26["image.ts"]
  n19 --> n26
  n27["orchestrator.ts"]
  n19 --> n27
  n28["policy.ts"]
  n19 --> n28
  n29["refactor.ts"]
  n19 --> n29
  n30["search.ts"]
  n19 --> n30
  n31["setup.ts"]
  n19 --> n31
  n32["summarize.ts"]
  n19 --> n32
  n33["sync.ts"]
  n19 --> n33
  n34["update-rule.ts"]
  n19 --> n34
  n35["verification.ts"]
  n19 --> n35
  n36["chunker.ts"]
  n18 --> n36
  n37["config.ts"]
  n18 --> n37
  n38["index.ts"]
  n18 --> n38
  n39["ollama.ts"]
  n18 --> n39
  n40["project-detect.ts"]
  n18 --> n40
  n41["project.ts"]
  n18 --> n41
  n42["supabase.ts"]
  n18 --> n42
  n43["verification-gate.ts"]
  n18 --> n43
  n44["version.ts"]
  n18 --> n44
  n45[".env.example"]
  n0 --> n45
  n46[".gitignore"]
  n0 --> n46
  n47["ARCHITECTURE.md"]
  n0 --> n47
  n48["LICENSE"]
  n0 --> n48
  n49["package-lock.json"]
  n0 --> n49
  n50["package.json"]
  n0 --> n50
  n51["README.md"]
  n0 --> n51
  n52["tsconfig.json"]
  n0 --> n52
```

<!-- MEMORY:ARCH:END -->

---

## 5. Version History

| Version | Summary |
|---|---|
| v0.8.0 | Production engine — ensureSchema, init_project, keep-alive, arch sync |
| v0.9.0 | Ultra-Enforcer — frozen cache, auto-freeze, backups, NL triggers |
| v0.9.1 | Legacy backup sweep + recovery discovery |
| v1.0.0 | God Mode — project detect, compiler gate, regression, binding session |
| **v1.1.0** | **Sovereign Orchestrator — delegation pattern + Autonomous Self-Healing + cross-platform spawn fix + ARCHITECTURE.md consolidation** |
| **v1.1.2** | **Master Schematic & Sovereign Baseline — definitive visual identity + version-locked production release** |
| **v1.1.3** | **Seamless Onboarding & Version SSOT — dynamic version SSOT, batch policy hydration, smart-scout init_project** |
