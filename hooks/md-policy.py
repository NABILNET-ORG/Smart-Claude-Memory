#!/usr/bin/env python3
"""
Zero-Local-MD policy hook (PreToolUse: Write|Edit).

Enforces a per-project allowlist for markdown files. Intended for projects
that have offloaded their rules/docs into cloud memory via claude-memory and
want to prevent new .md files from drifting back into the workspace.

Contract:
  stdin  : JSON tool-call payload from Claude Code
  stdout : JSON decision — {"decision": "allow"} or
           {"decision": "block", "reason": "..."} or
           {"decision": "allow", "warning": "..."}

Configuration via environment variables (so one script works across projects):
  CLAUDE_MD_POLICY_WORKSPACE      absolute path of the project root (required)
  CLAUDE_MD_POLICY_ALLOW_ROOT_MD  comma-separated filenames allowed at the
                                  root (default: "CLAUDE.md,MEMORY.md,README.md")
  CLAUDE_MD_POLICY_TOKEN_LIMIT    soft token limit for CLAUDE.md / MEMORY.md
                                  (default: 3000). Overflow warns, never blocks.
"""

from __future__ import annotations
import json
import os
import sys
from pathlib import Path


def env_workspace() -> Path | None:
    raw = os.environ.get("CLAUDE_MD_POLICY_WORKSPACE", "")
    if not raw:
        return None
    try:
        return Path(raw).resolve()
    except OSError:
        return None


def env_allow_root() -> set[str]:
    raw = os.environ.get("CLAUDE_MD_POLICY_ALLOW_ROOT_MD", "CLAUDE.md,MEMORY.md,README.md")
    return {name.strip() for name in raw.split(",") if name.strip()}


def env_token_limit() -> int:
    try:
        return int(os.environ.get("CLAUDE_MD_POLICY_TOKEN_LIMIT", "3000"))
    except ValueError:
        return 3000


BYTES_PER_TOKEN = 4  # rough estimate for English + code


def decide(tool_input: dict) -> dict:
    workspace = env_workspace()
    if workspace is None:
        return {"decision": "allow"}  # not configured for this project

    raw_path = tool_input.get("file_path") or tool_input.get("path") or ""
    if not raw_path:
        return {"decision": "allow"}
    try:
        target = Path(raw_path).resolve()
    except OSError:
        return {"decision": "allow"}

    if target.suffix.lower() != ".md":
        return {"decision": "allow"}
    try:
        target.relative_to(workspace)
    except ValueError:
        return {"decision": "allow"}  # outside this workspace

    allow_root = env_allow_root()

    if target.parent != workspace:
        return {
            "decision": "block",
            "reason": (
                f"Zero-Local-MD policy: `{target.name}` is outside the allowed root "
                f"({workspace}). Store it in cloud memory via update_rule or "
                f"sync_local_memory instead."
            ),
        }

    if target.name not in allow_root:
        return {
            "decision": "block",
            "reason": (
                f"Zero-Local-MD policy: only {sorted(allow_root)} are allowed at the "
                f"project root. `{target.name}` must live in cloud memory."
            ),
        }

    if target.name in {"CLAUDE.md", "MEMORY.md"}:
        content = tool_input.get("content") or tool_input.get("new_string") or ""
        est_tokens = len(content) // BYTES_PER_TOKEN
        limit = env_token_limit()
        if est_tokens > limit:
            return {
                "decision": "allow",
                "warning": (
                    f"{target.name} is ~{est_tokens} tokens, over the {limit} soft limit. "
                    f"Consider pruning — move detail to cloud via sync_local_memory or "
                    f"update_rule, keep this file as a lean index."
                ),
            }

    return {"decision": "allow"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.stdout.write(json.dumps({"decision": "allow"}))
        return
    if payload.get("tool_name") not in {"Write", "Edit"}:
        sys.stdout.write(json.dumps({"decision": "allow"}))
        return
    result = decide(payload.get("tool_input", {}) or {})
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
