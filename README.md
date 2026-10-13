# sbx-claude

My Claude Code setup on a Docker cloud sandbox (`sbx`). A new sandbox starts with Claude Code and little else; `install.sh` installs the missing tools and restores the configuration: subagents, plugins and mods, a VNC desktop with browser and computer-use MCP servers, rtk and headroom.

## Getting started

### 1. Sign up for Docker Agentic Platform

New sign-ups between September 22 and October 31, 2026 get **$250 of sandbox compute credit** instead of the standard $25: <https://www.docker.com/c/sbx-promo/>. A credit card is required, and charged only for usage past the credit. The credit covers sandbox compute (a small sandbox, 2 vCPU and 4 GB, is $0.14 an hour), not model usage, and expires six months after you claim it.

### 2. Install the sbx CLI and sign in

```bash
# macOS
brew trust docker/tap && brew install docker/tap/sbx
# Windows
winget install -h Docker.sbx
# Ubuntu
curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt install docker-sbx

sbx login               # same Docker account as the subscription
sbx --cloud diagnose    # checks the connection to cloud sandboxes
```

Cloud sandboxes need sbx 0.45.0 or later.

### 3. Create the sandbox

```bash
sbx --cloud run claude --name buwiz-books
```

This creates the sandbox and opens Claude Code in it. Sign in with `/login`, then leave it open and use a second terminal on your machine for step 4.

**Bigger machine.** The default is 2 CPUs and 4 GiB. To pick another size, create the sandbox first with `--cpus` and `--memory`, then open it:

```bash
sbx --cloud create --name buwiz-books --cpus 16 --memory 32g claude
sbx --cloud run claude --name buwiz-books
```

| Size | CPUs | Memory | Per hour |
|---|---|---|---|
| micro | 1 | 2 GiB | $0.070 |
| small (default) | 2 | 4 GiB | $0.140 |
| medium | 4 | 8 GiB | $0.280 |
| large | 8 | 16 GiB | $0.560 |
| xl | 16 | 32 GiB | $1.118 |

Giving only `--cpus` picks the matching memory. An existing sandbox can't be resized (the flags are rejected when it resumes), so for a different size create a new sandbox under another name and repeat steps 4 and 5 there.

### 4. Open the network and extend the sandbox's life

```bash
sbx --cloud ls
# SANDBOX              AGENT    ID              STATUS
# claude/buwiz-books   claude   sbx_01abc123…   running

sbx --cloud policy init allow-all --sandbox <ID>   # the ID column, exactly as printed
sbx --cloud ttl +23h claude/buwiz-books
```

- **Network.** Until the policy is set, the sandbox can't reach the internet: cloning from GitHub fails with `Could not resolve host: github.com`. To allow only some hosts instead, create the sandbox with `--allow-network github.com:443`.
- **Lifetime.** A cloud sandbox expires after 1 hour by default, and can't be extended past 24 hours from creation, so `+23h` right after creating it is the maximum. `sbx --cloud ttl claude/buwiz-books` shows what's left. At expiry a sandbox that can be resumed is stopped, keeping its files; otherwise it is deleted, and you start again from step 3.

### 5. Install everything

In the Claude Code session from step 3:

```
! git clone https://github.com/hexuria/sbx-claude.git ~/src/sbx-claude
! ~/src/sbx-claude/install.sh
```

It takes several minutes (apt packages, Chromium, the desktop). When it finishes, exit Claude Code with `/exit`.

### 6. Reconnect

```bash
sbx --cloud exec -it \
  -e TERM_PROGRAM=WarpTerminal -e COLORTERM=truecolor \
  -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 \
  claude/buwiz-books claude --continue
```

`--continue` reopens the last conversation, now with the agents, plugins and hooks loaded. The `-e` flags give full color and UTF-8; `TERM_PROGRAM=WarpTerminal` is for the Warp terminal, leave it out elsewhere. Run `hclaude --continue` instead of `claude --continue` to go through headroom.

`sbx --cloud attach claude/buwiz-books` also works: it reconnects to the session that is already running (detach with `Ctrl+\`).

### 7. Watch the desktop (optional)

Once, on your machine:

```bash
sbx --cloud setup ssh
```

Then, each time:

```bash
ssh -N -L 6080:127.0.0.1:6080 <ID>@sbx_cloud
```

and open <http://localhost:6080/vnc.html?autoconnect=1&resize=scale>. The SSH user is the sandbox ID exactly as `sbx --cloud ls` prints it. Add `-L 5901:127.0.0.1:5901` to use a VNC app on `localhost:5901` instead.

The desktop doesn't come back on its own after the sandbox stops and resumes: run `desktop-start` in the sandbox.

### Stop it when you're done

```bash
sbx --cloud stop claude/buwiz-books
```

A stopped sandbox isn't billed. Reconnect with step 6.

## What it sets up

| Piece | What it is | Where |
|---|---|---|
| **Subagents** | `researcher` (Haiku 5.5, high), `planner` (Opus 5.5, high), `coder` (Opus 5.5, medium), `reviewer` (Opus 5.5, high), `tester` (Sonnet 5.5, medium), `docs-writer` (Sonnet 5.5, medium), `browser-agent` (Haiku 5.5, max), `computer-use-agent` (Haiku 5.5, max). All cache for 1 hour. | `claude/agents/` → `~/.claude/agents/` |
| **Orchestration rules** | Routing table that lets Claude delegate to the agents above without asking | `claude/CLAUDE.md` → appended to `~/.claude/CLAUDE.md` |
| **Browser agent** | Playwright MCP (`@playwright/mcp` 0.0.82) driving Chromium; shows on the VNC desktop when it is running, headless otherwise; persistent login profile | `bin/browser-mcp` |
| **Computer-use agent** | Small MCP server (screenshot, click, drag, type, key, scroll, launch) over xdotool + ImageMagick on the virtual desktop | `desktop/computer_mcp.py`, `bin/computer-mcp` |
| **Virtual desktop** | XFCE on TigerVNC `:1` (1280x800) with wallpaper, top bar and a dock (Browser, Terminal, Files); noVNC on port 6080. Both listen on localhost only, with no VNC password: access goes through the SSH tunnel. | `bin/desktop-start`, `bin/desktop-stop`, `desktop/xfce/` |
| **rtk** 0.50.0 | Rewrites Bash commands to compress their output (`PreToolUse` hook) | `rtk init -g` |
| **headroom** 0.39.1 | Local proxy that compresses context before it reaches the API. Named `hclaude`, not `cc`, which is the C compiler. | `bin/hclaude` |
| **Plugins** | `html-plan`, `eli5` (claude-community), `blast-radius` (claude-code-playground mods), `agent-meter` (this repo) | |
| **agent-meter** mod | One line above the prompt: the agent on screen, its model and effort, and its share of the weekly limit | `mods/agent-meter/` |
| **Settings** | `advisorModel: opus`, `alwaysThinkingEnabled: true` (merged into `~/.claude/settings.json`) | |

`./install.sh --no-claude` installs the tools and desktop but leaves `~/.claude` alone; `--no-desktop` skips the desktop and the computer-use server. Both scripts are safe to run again. Tested on Ubuntu 26.04 arm64; x86_64 uses the matching rtk build.

## agent-meter

One line above the prompt for the transcript on screen, main's or a subagent's:

```
main opus-5.5 medium 5.7%/6%
```

That agent's share of the weekly limit / the week used so far. Open a subagent's transcript and the line follows it (`coder haiku-5.5 max 0.1%/6%`).

Claude Code reports one weekly % for the whole account, in whole points, so each agent's share is worked out:

1. **What a point costs.** Each time the weekly % ticks up, the mod pins the session's cost at that moment (Claude Code's own figure, as in `/cost`). The cost between two ticks bought exactly the points between them: USD per weekly point. It is kept in `~/.cache/agent-meter/usd-per-point` and used by every later session. Before two ticks, the first tick gives an estimate: the week starts at 0%, so the session's cost at the tick bought all the points up to it.
2. **Each agent's cost.** Subagents are priced from their own token usage at API list prices (1-hour cache writes at 2x input). `main` is the session's total cost less the subagents'.
3. **Share** = cost ÷ USD per point. The week's fraction past the last tick comes from spending since it.

Other sessions on the same account (another sandbox) also move the weekly %; a tick measured while they are busy makes a point look cheaper than it is. Raw readings are in `~/.cache/agent-meter/readings.json`.

Develop it with `claude --plugin-dir mods/agent-meter`; test with `claude plugin test mods/agent-meter`.

## Not included

- Credentials: sign in with `/login` in each new sandbox. For GitHub, run `gh auth login` in the sandbox; a secret added at agentic-platform.docker.com while a sandbox was running didn't reach it.
- Personal memory files under `~/.claude/projects/`.
- Permission-mode settings (auto mode, skipped prompts): set those with `/config`.
