# Hooks

Distributable Claude Code hooks that pair well with `claude-memory`.

## `md-policy.py`

Enforces a **Zero-Local-MD policy** in any project: only a whitelisted set of `.md` files may exist at the project root; everything else must live in cloud memory and be retrieved via `search_memory`.

### What it does

- **Blocks** `Write`/`Edit` on any `.md` file outside the project root or outside the allowlist.
- **Warns** (does not block) when `CLAUDE.md` or `MEMORY.md` exceeds a soft token limit — your cue to prune.

### Install per project

1. Pick (or create) the target project's `.claude/settings.json` or `.claude/settings.local.json`.
2. Add the hook entry:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "python \"/abs/path/to/claude-memory/hooks/md-policy.py\""
          }
        ]
      }
    ]
  },
  "env": {
    "CLAUDE_MD_POLICY_WORKSPACE": "/abs/path/to/your/project",
    "CLAUDE_MD_POLICY_ALLOW_ROOT_MD": "CLAUDE.md,MEMORY.md,README.md",
    "CLAUDE_MD_POLICY_TOKEN_LIMIT": "3000"
  }
}
```

3. Restart Claude Code.

### Environment variables

| Name | Default | Purpose |
|---|---|---|
| `CLAUDE_MD_POLICY_WORKSPACE` | — (required) | Absolute path of the project root the policy applies to. If unset, the hook no-ops. |
| `CLAUDE_MD_POLICY_ALLOW_ROOT_MD` | `CLAUDE.md,MEMORY.md,README.md` | Comma-separated filenames allowed at the root. |
| `CLAUDE_MD_POLICY_TOKEN_LIMIT` | `3000` | Soft limit for `CLAUDE.md` and `MEMORY.md`. Over → warn, never block. |

### Failure mode

Any malformed input, missing env var, or unhandled exception resolves to `{"decision": "allow"}` — the hook never blocks through its own bugs.
