#!/usr/bin/env python3
"""
Zero-Local-MD policy + Guardian hook (PreToolUse for Write|Edit|Bash).

Enforces four rules:
  1. Zero-Local-MD: only CLAUDE.md / MEMORY.md / README.md allowed at project root.
  2. 750-line hard limit: block writes that PUSH a file past 750 lines. Files already
     over the limit are "grandfathered" — edits allowed with a warning banner.
  3. Frozen features: for files matching a configured pattern, block `Write`; Edit only.
  4. Hard Stop / Manual Test Gate: if a pending-verification flag file exists, block
     Write/Edit/Bash until confirm_verification clears it.

Environment variables:
  CLAUDE_MD_POLICY_WORKSPACE       absolute path of the project root (required for MD rule)
  CLAUDE_MD_POLICY_ALLOW_ROOT_MD   comma-separated allowlist (default: CLAUDE.md,MEMORY.md,README.md)
  CLAUDE_MD_POLICY_TOKEN_LIMIT     soft token limit for CLAUDE.md/MEMORY.md (default 3000)
  CLAUDE_MEMORY_GATE_DIR           where the verification flag lives (default: ~/.claude-memory)
  CLAUDE_MEMORY_LINE_LIMIT         override the 750-line limit
  CLAUDE_MEMORY_FROZEN_PATTERNS    comma-separated substrings that mark a file as frozen
"""
from __future__ import annotations
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ALLOW_ROOT_DEFAULT = "CLAUDE.md,MEMORY.md,README.md"
BYTES_PER_TOKEN = 4

# Auto-generated files that bypass the 750-line hygiene check entirely.
EXCLUDE_EXACT_BASENAMES = {"types.ts"}
EXCLUDE_SUFFIXES = (".arb", ".l10n.dart", ".g.dart", ".freezed.dart")


def is_excluded(path: Path) -> bool:
    name = path.name.lower()
    if path.name in EXCLUDE_EXACT_BASENAMES:
        return True
    return any(name.endswith(suf) for suf in EXCLUDE_SUFFIXES)


def env_path(name: str) -> Path | None:
    raw = os.environ.get(name, "")
    if not raw:
        return None
    try:
        return Path(raw).expanduser().resolve()
    except OSError:
        return None


def allow_root() -> set[str]:
    raw = os.environ.get("CLAUDE_MD_POLICY_ALLOW_ROOT_MD", ALLOW_ROOT_DEFAULT)
    return {n.strip() for n in raw.split(",") if n.strip()}


def token_soft_limit() -> int:
    try:
        return int(os.environ.get("CLAUDE_MD_POLICY_TOKEN_LIMIT", "3000"))
    except ValueError:
        return 3000


def line_hard_limit() -> int:
    try:
        return int(os.environ.get("CLAUDE_MEMORY_LINE_LIMIT", "750"))
    except ValueError:
        return 750


import re as _re
import unicodedata as _unicodedata


def _slugify(s: str) -> str:
    """Must mirror src/project.ts slugify() so cache project keys line up."""
    s = _unicodedata.normalize("NFKD", s or "").lower()
    s = "".join(c for c in s if not _unicodedata.combining(c))
    s = _re.sub(r"[^a-z0-9\s_-]", "", s)
    s = s.strip()
    s = _re.sub(r"[\s_]+", "-", s)
    s = _re.sub(r"-+", "-", s)
    s = s.strip("-")
    return s or "default"


def frozen_patterns_env() -> list[str]:
    raw = os.environ.get("CLAUDE_MEMORY_FROZEN_PATTERNS", "")
    return [p.strip() for p in raw.split(",") if p.strip()]


def frozen_patterns_cache() -> list[str]:
    """Read patterns the MCP server exported for the current workspace.

    The MCP server writes ~/.claude-memory/frozen-patterns.json on startup
    and after every addFrozenPattern/removeFrozenPattern call. Reading that
    file is cheap; spawning a pg client per hook invocation would not be.
    """
    cache = gate_dir() / "frozen-patterns.json"
    if not cache.exists():
        return []
    ws = env_path("CLAUDE_MD_POLICY_WORKSPACE")
    if ws is None:
        return []
    project_id = _slugify(ws.name)
    try:
        data = json.loads(cache.read_text("utf8"))
    except (OSError, ValueError):
        return []
    entries = (data.get("projects") or {}).get(project_id, [])
    out: list[str] = []
    for e in entries:
        if isinstance(e, str):
            out.append(e)
        elif isinstance(e, dict) and isinstance(e.get("pattern"), str):
            out.append(e["pattern"])
    return out


def frozen_patterns() -> list[str]:
    """Combined list: env-var configured + cloud-synced. Deduplicated."""
    seen: set[str] = set()
    merged: list[str] = []
    for p in frozen_patterns_env() + frozen_patterns_cache():
        if p and p not in seen:
            seen.add(p)
            merged.append(p)
    return merged


def gate_dir() -> Path:
    raw = os.environ.get("CLAUDE_MEMORY_GATE_DIR", "")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".claude-memory"


def flag_path() -> Path:
    return gate_dir() / "verification-pending.json"


def backup_root() -> Path:
    return gate_dir() / "backups"


def backup_index_path() -> Path:
    return gate_dir() / "backup-index.json"


def _iso_timestamp_for_path() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")


def _update_backup_index(source: str, backup: str, tool_name: str, ts: str) -> None:
    """Append-or-replace a {source → latest-backup} record the TS side reads
    to tell Claude where to recover from if verification fails. Never throws."""
    idx_path = backup_index_path()
    try:
        if idx_path.exists():
            data = json.loads(idx_path.read_text("utf8"))
        else:
            data = {"entries": {}}
    except (OSError, ValueError):
        data = {"entries": {}}
    entries = data.setdefault("entries", {})
    entries[source] = {"backup": backup, "tool": tool_name, "timestamp": ts}
    data["updated_at"] = ts
    try:
        idx_path.parent.mkdir(parents=True, exist_ok=True)
        idx_path.write_text(json.dumps(data, indent=2), "utf8")
    except OSError:
        pass


def _make_backup(target: Path, tool_name: str) -> tuple[str | None, str | None]:
    """Copy target into ~/.claude-memory/backups/<project>/<ts>/<relpath>.
    Returns (backup_path, error_message). Both None if nothing to back up."""
    if not target.exists() or not target.is_file():
        return (None, None)

    ws = env_path("CLAUDE_MD_POLICY_WORKSPACE")
    project_slug = _slugify(ws.name) if ws is not None else "default"
    ts = _iso_timestamp_for_path()

    try:
        rel = target.relative_to(ws) if ws is not None else Path(target.name)
    except ValueError:
        rel = Path(target.name)

    dest = backup_root() / project_slug / ts / rel
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(target), str(dest))
    except OSError as e:
        return (None, f"backup copy failed: {e}")

    _update_backup_index(str(target), str(dest), tool_name, ts)
    return (str(dest), None)


def _target_matches_frozen(target: Path) -> bool:
    target_str = str(target).replace("\\", "/")
    for pat in frozen_patterns():
        if pat and pat in target_str:
            return True
    return False


# ─── checks ────────────────────────────────────────────────────────────────

def check_verification_gate(tool_name: str) -> dict | None:
    """If a pending-verification flag exists, block all destructive tools."""
    if tool_name not in {"Write", "Edit", "Bash"}:
        return None
    fp = flag_path()
    if not fp.exists():
        return None
    try:
        payload = json.loads(fp.read_text("utf8"))
    except (OSError, ValueError):
        payload = {}
    return {
        "decision": "block",
        "reason": (
            "Hard Stop: a pending manual-verification gate is active. "
            "After the most recent code change, you must manually confirm it works, "
            "then call confirm_verification({success:true}) to clear this gate. "
            f"Pending flag: {fp}. Details: {json.dumps(payload)[:200]}"
        ),
    }


def check_md_policy(target: Path) -> dict | None:
    ws = env_path("CLAUDE_MD_POLICY_WORKSPACE")
    if ws is None:
        return None
    if target.suffix.lower() != ".md":
        return None
    try:
        target.relative_to(ws)
    except ValueError:
        return None
    if target.parent != ws:
        return {
            "decision": "block",
            "reason": (
                f"Zero-Local-MD policy: `{target.name}` is outside the allowed root ({ws}). "
                "Store it in cloud memory via update_rule or sync_local_memory."
            ),
        }
    if target.name not in allow_root():
        return {
            "decision": "block",
            "reason": (
                f"Zero-Local-MD policy: only {sorted(allow_root())} are allowed at the root. "
                f"`{target.name}` must live in cloud memory."
            ),
        }
    return None


def check_line_limit(target: Path, tool_input: dict, tool_name: str) -> dict | None:
    if is_excluded(target):
        return None  # auto-generated files bypass hygiene entirely

    limit = line_hard_limit()
    current_lines = 0
    if target.exists():
        try:
            current_lines = target.read_text("utf8").count("\n") + 1
        except OSError:
            current_lines = 0

    # Project the new line count.
    if tool_name == "Write":
        incoming = tool_input.get("content", "") or ""
        projected = incoming.count("\n") + 1 if incoming else 0
    else:  # Edit
        old_string = tool_input.get("old_string", "") or ""
        new_string = tool_input.get("new_string", "") or ""
        replace_all = bool(tool_input.get("replace_all", False))
        old_nl = old_string.count("\n")
        new_nl = new_string.count("\n")
        if replace_all and old_string and target.exists():
            try:
                text = target.read_text("utf8")
                occurrences = text.count(old_string)
            except OSError:
                occurrences = 1
            projected = current_lines + (new_nl - old_nl) * occurrences
        else:
            projected = current_lines + (new_nl - old_nl)

    # Grandfather rule — file was already oversized; edits allowed, with warning.
    if current_lines > limit:
        return {
            "decision": "allow",
            "warning": (
                f"Grandfathered file: `{target.name}` is {current_lines} lines "
                f"(over the {limit}-line limit). Edit permitted, but please prioritize "
                f"splitting — run check_code_hygiene({{paths:['{target.as_posix()}']}}) "
                "for an automatic refactor plan."
            ),
        }

    # Ceiling rule — was under the limit; this operation must not cross it.
    if projected > limit:
        return {
            "decision": "block",
            "reason": (
                f"block_and_refactor: `{target.name}` was {current_lines} lines (≤ {limit}); "
                f"this {tool_name} would take it to ~{projected} lines, crossing the hard limit. "
                f"Split the file first — run check_code_hygiene({{paths:['{target.as_posix()}']}}) "
                "for a split plan, then apply the refactor before re-attempting this edit."
            ),
        }
    return None


def check_frozen(target: Path, tool_name: str) -> dict | None:
    patterns = frozen_patterns()
    if not patterns:
        return None
    target_str = str(target).replace("\\", "/")
    for pat in patterns:
        if pat and pat in target_str:
            if tool_name == "Write":
                return {
                    "decision": "block",
                    "reason": (
                        "FROZEN: Use 'Edit' for surgical changes. If a full Refactor "
                        "is needed, justify it to the user and request an unfreeze. "
                        f"(Pattern: '{pat}')"
                    ),
                }
            # Edit on a frozen file is the intended path — allow silently.
            break
    return None


def check_memory_file_size(target: Path, incoming: str) -> dict | None:
    if target.name not in {"CLAUDE.md", "MEMORY.md"}:
        return None
    est = len(incoming) // BYTES_PER_TOKEN
    limit = token_soft_limit()
    if est > limit:
        return {
            "decision": "allow",
            "warning": (
                f"{target.name} is ~{est} tokens, over the {limit} soft limit. "
                "Consider calling summarize_memory_file to compress it back under the limit."
            ),
        }
    return None


# ─── orchestration ────────────────────────────────────────────────────────

def decide(tool_name: str, tool_input: dict) -> dict:
    # 1. Verification gate trumps everything (applies to Write/Edit/Bash).
    gate = check_verification_gate(tool_name)
    if gate is not None:
        return gate

    if tool_name not in {"Write", "Edit"}:
        return {"decision": "allow"}

    raw_path = tool_input.get("file_path") or tool_input.get("path") or ""
    if not raw_path:
        return {"decision": "allow"}
    try:
        target = Path(raw_path).resolve()
    except OSError:
        return {"decision": "allow"}

    incoming = tool_input.get("content") or tool_input.get("new_string") or ""

    # 2. Zero-Local-MD policy
    r = check_md_policy(target)
    if r is not None:
        return r

    # 3. Frozen features
    r = check_frozen(target, tool_name)
    if r is not None:
        return r

    # 4. 750-line rule (source files only; bypassed for binaries, images, and
    #    auto-generated files matching is_excluded()).
    if target.suffix.lower() in {
        ".ts", ".tsx", ".js", ".jsx",
        ".py", ".sql", ".md",
        ".json", ".yaml", ".yml", ".toml",
        ".dart",
    }:
        r = check_line_limit(target, tool_input, tool_name)
        if r is not None:
            return r

    # 5. CLAUDE.md / MEMORY.md size advisory
    size_warning = check_memory_file_size(target, incoming)

    # 6. Mandatory backup before the edit/write goes through.
    #    Write → always (full refactor risk).
    #    Edit  → only on frozen files (the surgical path, but still worth a snapshot).
    #    Skipped if the file doesn't exist yet (nothing to back up).
    backup_warning = None
    if target.exists() and target.is_file():
        should_backup = tool_name == "Write" or (
            tool_name == "Edit" and _target_matches_frozen(target)
        )
        if should_backup:
            bp, err = _make_backup(target, tool_name)
            if bp:
                backup_warning = (
                    f"Backup saved before {tool_name}: {bp}. "
                    "If verification fails, read this file to restore the prior state."
                )
            elif err:
                backup_warning = f"Backup FAILED for {target.name}: {err} — proceed with caution."

    warnings = [w for w in (
        (size_warning or {}).get("warning"),
        backup_warning,
    ) if w]

    if warnings:
        return {"decision": "allow", "warning": " | ".join(warnings)}
    return {"decision": "allow"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.stdout.write(json.dumps({"decision": "allow"}))
        return
    result = decide(payload.get("tool_name", ""), payload.get("tool_input", {}) or {})
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
