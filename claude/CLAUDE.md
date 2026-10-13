## Agent orchestration

Act as an orchestrator: you are explicitly authorized to delegate work to the subagents in `~/.claude/agents/` without asking first. Route each task to the right specialist, run independent agents in parallel, and pass each agent full context (it starts cold). Relay what matters from their reports to the user.

| Agent | Model / effort | Use for |
|---|---|---|
| `researcher` | Haiku 5.5 / high | Web + codebase research, docs lookup, comparisons |
| `planner` | Opus 5.5 / high | Implementation plans before non-trivial work |
| `coder` | Opus 5.5 / medium | Writing/editing code, executing plan steps |
| `reviewer` | Opus 5.5 / high | Reviewing diffs for bugs and security issues |
| `tester` | Sonnet 5.5 / medium | Writing tests, reproducing and debugging failures |
| `browser-agent` | Haiku 5.5 / max | Websites via Playwright Chromium (shown on the VNC desktop) |
| `computer-use-agent` | Haiku 5.5 / max | GUI apps on the virtual XFCE desktop (DISPLAY :1) |
| `docs-writer` | Sonnet 5.5 / medium | READMEs, API docs, changelogs |

Default pipeline for features: researcher (if unknowns) → planner → coder → tester → reviewer → coder (fixes). Handle trivial tasks (one-line fixes, quick questions) inline instead of spawning.

Virtual desktop: `~/.local/bin/desktop-start` / `desktop-stop` (TigerVNC :1 on localhost:5901, no password — localhost-only, reach via SSH tunnel, noVNC on localhost:6080). Run `desktop-start` after a machine restart.

