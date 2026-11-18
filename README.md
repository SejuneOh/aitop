# ⣠⣴⣾ aitop

[![npm](https://img.shields.io/npm/v/@sejuneoh/aitop)](https://www.npmjs.com/package/@sejuneoh/aitop)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/SejuneOh/aitop/blob/main/LICENSE)

**`top` for your AI coding agents.** One live terminal screen for every Claude Code, Codex CLI and Antigravity CLI session on your machine. No hooks, read-only.

> `npx @sejuneoh/aitop`
>
> `npm i -g @sejuneoh/aitop`

- The first line tries it with no install.
- The second installs it. Then just run `aitop`.

![aitop: a session starts waiting, jumps to the top, and its resume command shows in the detail panel (demo data)](https://raw.githubusercontent.com/SejuneOh/aitop/main/docs/demo.gif)

- **See who needs you.**
  - A waiting session jumps to the top and `n` takes you there.
  - Add `--notify=waiting,done,context` for desktop alerts, or `aitop --line` for a tmux status line.
- **Know which session is which.**
  - Every row shows the session name (your `/rename` or the tool's title).
  - `y` copies a resume command, and `--report sessions` prints yesterday's sessions with cost for your standup.
- **No hooks, nothing sent.**
  - Claude Code, Codex CLI and Antigravity CLI side by side, from [several history folders](#several-claude-or-codex-profiles) (`~/.claude`, `~/.claude-work`, ...).
  - aitop only reads the logs they already write. It changes no settings and needs no network, ports or dependencies.

**Contents**

- [Quick start](#quick-start)
- [Features](#features)
- [Subagents](#subagents) · [Daily and monthly reports](#daily-and-monthly-reports) · [Session report](#session-report) · [Call tree](#call-tree)
- [Notifications](#notifications) · [tmux status line](#tmux-status-line) · [Several Claude or Codex profiles](#several-claude-or-codex-profiles)
- [Resume a session elsewhere](#resume-a-session-elsewhere) · [JSON output](#json-output) · [Language](#language)
- [How it differs from similar tools](#how-it-differs-from-similar-tools) · [Install](#install) · [License](#license)

## Quick start

> `aitop`

- Live screen.

> `aitop --all`

- Include sessions that ended in the last 24 hours.

> `aitop --once`

- Print the current state once and exit.

> `aitop --json`

- Print a snapshot as JSON and exit. See [JSON output](#json-output).

> `aitop --doctor`

- Check which tools and logs aitop can see.

> `aitop --line`

- Print one short status line and exit (for tmux, e.g. `$54.13 wait 2 fix-login 3m run 3 $3.1/h`). See [tmux status line](#tmux-status-line).

> `aitop --report sessions`

- Yesterday's sessions with cost, for standups (`--md`, `--json`). See [Session report](#session-report).

> `aitop --help`

- All options.

**Keys on the live screen**

- `↑↓` select · `n` next session to check · `/` search · `s` sort · `g` group
- `p` pin · `f` changed files · `?` help · `q` quit

**Config file**

- Settings can also go in `~/.config/aitop/config.json` (`%APPDATA%\aitop\config.json` on Windows).
- See `aitop --help` or the [detailed manual (Korean)](https://github.com/SejuneOh/aitop/blob/main/docs/README.ko.md).

## Features

- **Live status** of every session and its subagents: thinking, running a tool, waiting for you, idle, or stopped by an error.
  - Subagent rows show how long they have run ([details](#subagents)).
- **Stopped by an error**: `! Login needed`, `! Connection lost`, read from the API error lines Claude Code already logs.
- **Prompt cache countdown** for Claude sessions waiting on you or idle: `cache 3:12` after the status text.
- **Tool run time** while a session runs a tool: `Tool · Bash · 4m12s`.
- **Waiting alerts**: blocked sessions jump to the top, with optional bell, desktop notification or hook command.
- **Tokens and cost** per session and for today / last 7 days, estimated at public API list prices. This is not your bill.
- **Changed files and diffs** per session and per prompt.
- **Read-only**: no network, no ports, no dependencies. It only reads the session logs each CLI already writes.

<details>
<summary>Details: stopped sessions, cache countdown, tool run time</summary>

**Stopped by an error**

- It sorts right under waiting and pinned sessions.
- It is counted on its own as `! 1 stopped` in the header, the window title (`(2◆ 1! 1●)`), `n` and `--line`.
- It never counts as done.

**Prompt cache countdown**

- Warning color under a minute, dim `cache expired` after.
- Estimated from the log's `cache_creation` 5m/1h tokens and the last request start, per the [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- Dropped first on narrow screens, except under a minute, when the status text is shortened instead.
- `--json` has `cacheExpiresAt`.

**Tool run time**

- Measured from the open tool call's start (Claude `tool_use`, Codex `function_call`, Antigravity running step).
- Shown after one minute, in a dim warning color from ten minutes (Claude Code's Bash timeout max).
- Not counted while waiting for approval.
- Dropped first on narrow screens; `--json` has `toolStartedAt`.

</details>

## Subagents

Subagents show as `├─` rows under their session, on the live screen.

> `aitop`

- While one works, its row shows how long it has run, marked with `◷` so it is not read as IDLE (`◷42s`, `◷3m12s`, `◷1h05m`; `~3m12s` with `AITOP_AMBIGUOUS=wide`).
- A dim `stalled?` appears when a working subagent's log has not changed for 3 minutes. It is only a guess.
- While it runs a tool that can be slow, the limit is 10 minutes.
- When an Antigravity subagent waits for your approval, its parent row waits too, as `<agent>: <tool>`.

<details>
<summary>Details: <code>stalled?</code> and Antigravity waits</summary>

**`stalled?`**

- Slow tools: Bash, PowerShell, a nested agent, web fetch or search, an MCP tool, agy `run_command`.
- It never shows while the session waits for you.
- It does not change sorting, alerts, the window title or `--line`.
- `--json` has it per member as `stalled`, with `startedAt` and `lastActivityAt`.

**Antigravity subagent waits**

- The session jumps to the top and counts for `n`, `--notify` and `--line`.
- If the parent waits itself, its own wait shows first.
- Other waiting subagents show on their own rows.

</details>

## Daily and monthly reports

Tokens and cost (API list price, like the header) per day or per month, newest first, with a total row, then exit.

> `aitop --report daily`
>
> `aitop --report daily --by model --days 14`
>
> `aitop --report daily --by project --days 7`
>
> `aitop --report monthly --by model --months 6`

- `aitop --report daily`: daily cost table and exit.
- `aitop --report monthly [--by tool|model|project] [--months N] [--json]`: monthly cost table (last 12 months) and exit, for up to 12 months.
- `--by`: columns per tool by default, per model with `--by model`, or per project with `--by project`.
- `--days N`: goes back up to 30 days.
- `--json`: the same numbers for scripts.

<details>
<summary>Details: projects, first run, monthly archive</summary>

**Project columns**

- A project is the last folder name of the working directory: Claude log `cwd`, Codex `turn_context.cwd`, agy workspace.
- Claude Code worktrees under `<repo>/.claude/worktrees/` count as the repo.
- `(unknown)` when missing.
- Extra columns beyond the terminal width are merged into `(others)`; `--json` lists all with a `paths` map.

**First run**

- The first daily run reads up to 30 days of logs, so it can take a while (progress shows on stderr).
- Later runs use the cache.

**Monthly archive**

- Past days are folded into `monthly.json` in the cache folder (`~/.cache/aitop`, outside the versioned cache) about two days later.
- So monthly totals survive cache rebuilds and Claude Code deleting old transcripts.
- The first monthly run reads up to a year of remaining logs once.
- `*` marks this month.
- `~` marks a month only partly counted (for example before the oldest remaining Claude log).
- `no data` marks a month with neither logs nor archive (unknown, not zero).
- The archive keeps token counts per type, so costs are recomputed when the price table changes.
- In `--json`, rows have `month`, `current` and `status` (`complete`, `partial` or `missing`).
- With several history folders, see the monthly rule in [Several Claude or Codex profiles](#several-claude-or-codex-profiles).

</details>

## Session report

Every session that used tokens in the period, highest cost first, for standups.

> `aitop --report sessions`
>
> `aitop --report sessions --md --plan 200`
>
> `aitop --report sessions --since 7d --json`

- Full form: `aitop --report sessions [--since yesterday|today|Nd|YYYY-MM-DD] [--plan USD] [--md|--json] [--show-prompts]`.
- `--since`: default is since midnight yesterday; at most 30 days back.
- `--plan 200`: adds how many times the period's share of a $200/month subscription (period days / 30) you used. Still in API list price and not your bill.
- `--md`: Markdown you can paste (`|` and line breaks escaped).
- `--json`: the same numbers for scripts.
- `--show-prompts`: first prompts are hidden unless you pass it, so they do not end up in shared output (session names still show).
- A summary card on top shows the total, the share per tool and the session count.
- The card's last line totals the waits (`Agents waited for you 1h12m (estimate)`).

<details>
<summary>Details: columns</summary>

- Tool.
- Main model (`+N` more).
- Project (same rule as `--by project`).
- Session name: your `/rename` name, then the tool's title, then the folder.
- Start and end of activity within the period.
- Time the agent waited for you (see below).
- Tokens.
- Cost (API list price). Unpriced models are left out, not guessed, and `--json` marks them with `unpriced`.
- Files changed (`-` when unknown, always for agy).
- Claude subagents are counted in their parent session.

</details>

<details>
<summary>Details: how "waited" is estimated</summary>

- Waited is an **estimate**: the sum of gaps from the agent's last line (reply or tool result) to your next input.
- Inputs for Claude: prompts you typed (slash commands included) and answers you picked in a permission dialog or AskUserQuestion.
- Inputs for Codex: `user_message`.
- Prompts queued while the agent worked and background task notifications do not count.
- An interrupt restarts the clock.
- The logs do not say whether you were at the screen, so **time away cannot be told apart** from waiting.
- Each gap counts for at most 2 hours, so a session left open overnight does not swamp the total.
- A Claude permission dialog's start time is not logged. The gap runs from the tool call to its result and includes the tool's run time after approval.
- Codex does not log approvals, so only prompts count there.
- Gaps crossing the period start count only the part inside.
- Subagents are not counted (parent session only).
- Each session is summed on its own, so with sessions running side by side the total can exceed wall-clock time.
- agy shows `-`.
- `--json` has `waitedMs` (milliseconds, `null` when unknown) per session and in `summary`.

</details>

## Call tree

The call tree of one Claude Code session with cost per tool call: each prompt, the tool calls under it and subagents under their `Agent`/`Task` call.

> `aitop --report trace fix-login`
>
> `aitop --report trace 1a2b3c4d --json`

- Full form: `aitop --report trace <session> [--md|--json] [--show-prompts]`.
- Each line has duration, tokens and estimated cost (API list price).
- `<session>`: the start of its id (as in `--json` and the resume command), a log file path, or a `/rename` name or title.
- `--md`, `--json`: Markdown or JSON output.
- `--show-prompts`: commands, paths and prompt text are hidden unless you pass it. Secrets are masked either way.
- It reads the log once and writes nothing.
- Codex and Antigravity sessions are not supported yet.

<details>
<summary>Details: cost split, folding, markers</summary>

- A tool line gets the cost of the reply that called it, split across the tools that reply called.
- Subagent and prompt lines total their whole branch.
- Totals can differ slightly from the session cost in other reports (subagent lines in very old logs are not placed in the tree).
- Repeated calls of one tool are grouped (`Grep ×38`).
- Branches deeper than a subagent's own steps are folded.
- Past 300 lines, the oldest prompts, and then the earliest steps inside a prompt or subagent, are left out and marked `N earlier steps left out`.
- Failed calls show `✗`, calls without a result yet `●`.
- `(no result)` shows when a later prompt came first or the log has not changed for over 15 minutes.

</details>

## Notifications

Alerts when a session starts waiting, finishes a long turn or fills its context. Off by default and only on the live screen.

> `aitop --notify`
>
> `aitop --notify=waiting,done,context`
>
> `aitop --on-waiting 'my-hook.sh'`

- `--notify`: desktop notification when a session starts waiting (notify-send on Linux, Windows notification on WSL, osascript on macOS).
- `--notify=waiting,done,context`: pick the kinds. Plain `--notify` uses the config file kinds, or waiting only when none are set.
- `--on-waiting`: run a command with `/bin/sh -c` for the same events (10 second limit, runs as you).
- Sessions already waiting (or already over 90% context) when aitop starts are not reported.

**Kinds**

- `waiting`: a session starts waiting for your approval or answer.
- `done`: a session that was busy for over 3 minutes in one turn (config `doneMinutes`; time spent waiting for approval does not count) goes idle and stays idle for 5 seconds. Once per turn.
- `context`: context use passes 90%, once. It re-arms after it drops below 85% (for example after compaction).

<details>
<summary>Details: <code>done</code> exceptions, hook, config file</summary>

**Not reported as `done`**

- Brief idle gaps between tool calls, approval waits, ended sessions and subagents.
- Sessions stopped by an API error and sessions whose status is guessed from file times.

**Hook**

- The hook keeps its name (`--on-waiting`) for all kinds.
- It gets `AITOP_EVENT` (`waiting`, `done` or `context`) in its environment.
- It also gets `AITOP_TOOL`, `AITOP_PROJECT`, `AITOP_SESSION_ID`, `AITOP_CWD` and `AITOP_WAITING_FOR`.

**Config file and switches**

- `"notify": true` or `"notify": ["waiting", "done", "context"]`.
- `"onWaiting": "..."` (the file must be `chmod 600`).
- `"doneMinutes": 5`.
- Plain `--notify` keeps the kinds from the config `notify` list (waiting only when there is none).
- `--no-notify` turns off only the desktop notification: the hook still follows those kinds.
- `--bell` stays waiting only.

</details>

<details>
<summary>Details: WSL, D-Bus, notification text</summary>

- On WSL, aitop shows a Windows notification through `powershell.exe` (as Windows PowerShell, no setup needed).
- It falls back to notify-send when `powershell.exe` is not on the PATH.
- notify-send needs a D-Bus session bus. When `DBUS_SESSION_BUS_ADDRESS` is unset or its socket file is missing, notifications cannot show and `--doctor` marks the line with `!`.
- A missing tool or a failed notification is skipped quietly.
- The body shows the session's own name when it has one (Claude Code `/rename`, or a name given by a peer session; Codex `thread_name`), otherwise the project.
- Desktop notifications can appear on the lock screen, so the name is visible there too.

</details>

## tmux status line

One short status line for tmux, then exit.

> `aitop --line`
>
> `aitop --line=tmux`

```tmux
set -g status-right '#(aitop --line=tmux)'
set -g status-interval 15
```

**What it shows** (items that are 0 are left out)

- Today's cost (API list price, `/$<budget>` when a daily budget is set).
- The sessions waiting for you, with the longest waiting one's name and wait time: `wait fix-login 3m` for one, `wait 2 fix-login 3m` for more.
- The Claude Code sessions stopped by an API error (`stop 1`, read live).
- The number of sessions running (`run 3`).
- Spend over the last hour.

**Options**

- `--line=tmux`: adds tmux colors. `NO_COLOR` turns them off.
- `--line-width N` (default 40): drops items from the end.
- In tmux always use `--line=tmux`: it escapes `#` in session names.

<details>
<summary>Details: width, cache, escaping</summary>

**Waiting and width**

- Waiting sessions are read live for Claude Code. Names are cut to 12 columns with `~`.
- The waiting name goes before the waiting count, after `stop`.
- With a daily budget and a waiting name, `$/h` often does not fit in 40, so raise `--line-width` to keep it.

**Cache**

- It reads only aitop's cache, so it is fast once `aitop` has run before.
- With no cache yet it prints `...` after about 1.5 seconds.
- The running count (and waiting Antigravity sessions with their names) come from a small summary that the live screen, `--once` and `--json` write to the cache.
- When no summary is newer than 60 seconds, `run` is left out rather than shown wrong.

**Escaping**

- Session names come from your sessions. Plain output could let tmux expand a `#{...}` or `#(...)` inside a name.
- In a zsh prompt with `PROMPT_SUBST`, a `%` in a name can be expanded by zsh.
- So escape `%` (for example `${$(aitop --line)//\%/%%}`) or use the line only in tmux.

</details>

## Several Claude or Codex profiles

aitop reads `~/.claude` and `~/.codex` by default. List more profiles to read them too.

> `AITOP_CLAUDE_DIRS=~/.claude:~/.claude-work aitop`
>
> `aitop --print-config`
>
> `aitop --doctor`

- Config file: `"claudeDirs": ["~/.claude", "~/.claude-work"]` and `"codexHomes": ["~/.codex", "~/.codex-alt"]`.
- Or set `AITOP_CLAUDE_DIRS` / `AITOP_CODEX_HOMES` with paths joined by `:` (`;` on Windows).
- Order: `AITOP_*` > config file > an inherited `CLAUDE_CONFIG_DIR` / `CODEX_HOME` > default.
- `aitop --print-config` shows which source is used.
- `aitop --doctor` lists every folder it reads, plus folders that hold logs but are not read, with how to add them.

<details>
<summary>Details: paths, duplicates, monthly reports, look-alike folders</summary>

- Because of the order, a `CLAUDE_CONFIG_DIR` exported for Claude Code does not hide your config list.
- A value that is itself an existing folder is never split, so an old single path containing `:` keeps working.
- The same folder listed twice (also through a link) is read once.
- A session log copied into two folders is counted once.
- For monthly reports, a month counts as complete only from the day after the oldest remaining log of the folder that was cleaned most recently.
- So a folder with old logs cannot make a month look complete when another folder already lost logs for it.
- aitop does not read look-alike folders on its own.
- `--doctor` reports as not read: `~/.claude-*`, `~/.config/claude`, `~/.codex-*` and similar owned by you, and a `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the config list left out.

</details>

## Resume a session elsewhere

Continue a session elsewhere, for example when you cannot jump to its tab, as in Windows Terminal with WSL. The detail panel shows a `Resume` command and `y` copies it.

> Claude: `cd <dir> && claude --resume <id>`
>
> Codex: `cd <dir> && codex resume <id>`
>
> Antigravity: `cd <dir> && agy --conversation <id>`

- None for Gemini CLI.
- `y` copies the command to the clipboard with OSC 52.
- `--json` has the same command as `resumeCmd` per session (`null` if none).
- Nothing is sent to the session.

<details>
<summary>Details: data folders, when no command is made, clipboard</summary>

**Data folders**

- A session from a data folder other than `~/.claude` / `~/.codex` gets `CLAUDE_CONFIG_DIR=<dir>` / `CODEX_HOME=<dir>` before the tool, so it finds the right history.
- The same happens for any session while `CLAUDE_CONFIG_DIR` / `CODEX_HOME` is set.

**When no command is made**

- Claude finds sessions per folder, so without a known folder no command is made.
- Ids that are not UUIDs make none either.
- A short detail panel leaves the command out; use `y` or `--json` then.
- Paths and ids are shell quoted and control characters are stripped.

**Clipboard (OSC 52)**

- Windows Terminal, WezTerm, iTerm2 and kitty accept OSC 52.
- tmux needs `set -g set-clipboard on`.
- Other terminals ignore it silently, so copy the command from the panel.

</details>

## JSON output

> `aitop --json`
>
> `aitop --doctor --json`

- `--json` prints a snapshot as JSON and exits.
- For scripts, use `phaseKind`, a stable state name: `think`, `write`, `tool`, `team`, `waiting`, `idle`, `stopped`, `done`, `ended` (or `null`).
- `stopReason` says why a session is `stopped`: `{ "kind": "auth" }` login needed, `network` connection lost, `api` any other API error. `null` otherwise.

<details>
<summary>Details: text fields and where other fields are described</summary>

**Text fields**

- `phase` stays the Korean status text in every language (as does `AITOP_WAITING_FOR` for `--on-waiting`).
- Session `name` uses the same user-given names as the table.
- A Codex session's `name` changes from the folder name to its `thread_name` once it has one.
- `stopped` is an idle Claude session whose last log entry is an API error.
- Other text fields follow their own rules: with English selected, `--doctor --json` has Korean `tools.*.hint` but English `config.problems`.

**Other fields**

- `cacheExpiresAt`, `toolStartedAt`: [Features](#features).
- `stalled`, `startedAt`, `lastActivityAt`: [Subagents](#subagents).
- `resumeCmd`: [Resume a session elsewhere](#resume-a-session-elsewhere).
- Report output (`month`, `current`, `status`, `paths`, `unpriced`, `waitedMs`): [Daily and monthly reports](#daily-and-monthly-reports), [Session report](#session-report).

</details>

## Language

The UI follows your locale: English by default, Korean when the locale starts with `ko`.

> `aitop --lang ko`
>
> `AITOP_LANG=ko aitop`

- `--lang ko`: Korean screen, help, doctor and error messages.
- Set `AITOP_LANG=ko|en` (or `--lang`) to pick one, or `"lang": "ko"` in the config file.
- It covers the live screen, `--once`, `--help`, `--doctor`, error messages and desktop notifications.
- Keys and options work the same in both.

<details>
<summary>Details: how the language is picked</summary>

- Order: `--lang`, then `AITOP_LANG`, then `lang` in the config file, then `LC_ALL`, `LC_MESSAGES` and `LANG`.
- Korean when the locale starts with `ko`, English otherwise (including `C.UTF-8` and unset).
- If you used aitop on a `C.UTF-8` or `en_US` locale before, the screen, help and doctor output are now in English.
- Set `AITOP_LANG=ko` to keep Korean.

</details>

## How it differs from similar tools

- [ccusage](https://github.com/ryoppippi/ccusage)
  - Reports token usage and cost from local logs (daily, monthly, session, 5-hour blocks).
  - aitop is a live session monitor first, with smaller cost reports on the side.
- [abtop](https://github.com/graykode/abtop)
  - A Rust live dashboard for Claude Code, Codex CLI and OpenCode, with rate limits, ports and keys to kill sessions.
  - aitop installs with npm, also covers Antigravity, and only watches.
- [claude-code-monitor](https://github.com/onikan27/claude-code-monitor)
  - Watches Claude Code on macOS through hooks it adds to `~/.claude/settings.json`, with a phone web view.
  - aitop adds no hooks and only reads existing logs, on Linux, macOS, WSL and Windows.
- [Agents Stack](https://marketplace.visualstudio.com/items?itemName=MykD.agents-stack)
  - A VS Code extension for Claude Code, Antigravity, Codex and Gemini CLI.
  - It adds hooks to each agent's config. Antigravity has no hook for approval waits, so those do not show.
  - aitop runs in any terminal, adds no hooks and shows Antigravity sessions waiting for approval.

## Install

Requires Node.js 22+ on Linux, macOS, WSL or Windows.

> `npx @sejuneoh/aitop`
>
> `npm install -g @sejuneoh/aitop`
>
> `aitop`

- `npx` runs the latest version without installing.
- `npm install -g` installs it. Then run `aitop`.

<details>
<summary>Windows: what works and what does not yet</summary>

- Native Windows support is early (Windows Terminal recommended).
- Works: Claude Code and Codex sessions, `--once`, `--json`, `--report` and `--doctor`.
- Not there yet: process detection, desktop notifications and `--on-waiting` ([#195](https://github.com/SejuneOh/aitop/issues/195)-[#197](https://github.com/SejuneOh/aitop/issues/197)).
- Until then a Codex session counts as running while its log was written in the last 10 minutes.
- So it drops out during a long step that writes nothing for over 10 minutes, and a crashed session can stay up to 10 minutes.
- Cache, log and config live in `%LOCALAPPDATA%\aitop\cache`, `%LOCALAPPDATA%\aitop\state` and `%APPDATA%\aitop` unless `XDG_*` is set.

</details>

## License

[MIT](https://github.com/SejuneOh/aitop/blob/main/LICENSE)

Not affiliated with or endorsed by Anthropic, OpenAI or Google. Product names are trademarks of their owners.
