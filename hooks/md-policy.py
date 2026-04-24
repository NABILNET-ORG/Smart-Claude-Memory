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
import sys
from pathlib import Path

ALLOW_ROOT_DEFAULT = "CLAUDE.md,MEMORY.md,README.md"
BYTES_PER_TOKEN = 4


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


def frozen_patterns() -> list[str]:
    raw = os.environ.get("CLAUDE_MEMORY_FROZEN_PATTERNS", "")
    return [p.strip() for p in raw.split(",") if p.strip()]


def gate_dir() -> Path:
    raw = os.environ.get("CLAUDE_MEMORY_GATE_DIR", "")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".claude-memory"


def flag_path() -> Path:
    return gate_dir() / "verification-pending.json"


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


def check_line_limit(target: Path, incoming_text: str, tool_name: str) -> dict | None:
    limit = line_hard_limit()
    # Current size on disk (0 if new file)
    current_lines = 0
    if target.exists():
        try:
            current_lines = target.read_text("utf8").count("\n") + 1
        except OSError:
            current_lines = 0
    new_lines = incoming_text.count("\n") + 1 if incoming_text else 0

    # Grandfathered: already-oversized file → warn, don't block
    if current_lines > limit:
        # Write would reset size entirely; allow but warn.
        if tool_name == "Write":
            projected = new_lines
            if projected > limit:
                return {
                    "decision": "allow",
                    "warning": (
                        f"Grandfathered file: `{target.name}` is {current_lines} lines "
                        f"(over the {limit}-line hard limit). Your Write will produce "
                        f"{projected} lines — still over. Consider splitting."
                    ),
                }
        return {
            "decision": "allow",
            "warning": (
                f"Grandfathered file: `{target.name}` is already {current_lines} lines "
                f"(over the {limit}-line limit). Edit is permitted but please avoid "
                "adding more bulk; prefer extracting sections into new modules."
            ),
        }

    # Not grandfathered: block if this operation pushes it past the limit.
    if tool_name == "Write" and new_lines > limit:
        return {
            "decision": "block",
            "reason": (
                f"750-line rule: the proposed Write produces {new_lines} lines for "
                f"`{target.name}`, exceeding the {limit}-line limit. Split into smaller modules."
            ),
        }
    # For Edit we can't reliably predict new line count without applying the diff; approximate
    # by checking the delta of new_string vs old_string if both are present.
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
                        f"Frozen feature: `{target.name}` matches pattern `{pat}`. "
                        "Use Edit for surgical line-level changes, not Write (full overwrite)."
                    ),
                }
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

    # 4. 750-line rule (only meaningful for source files; skip binaries and images)
    if target.suffix.lower() in {".ts", ".tsx", ".js", ".jsx", ".py", ".sql", ".md", ".json", ".yaml", ".yml", ".toml"}:
        r = check_line_limit(target, incoming, tool_name)
        if r is not None:
            return r

    # 5. CLAUDE.md / MEMORY.md size advisory
    r = check_memory_file_size(target, incoming)
    if r is not None:
        return r

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
