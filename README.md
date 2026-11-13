# ⣠⣴⣾ aitop

[![npm](https://img.shields.io/npm/v/@sejuneoh/aitop)](https://www.npmjs.com/package/@sejuneoh/aitop)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/SejuneOh/aitop/blob/main/LICENSE)

**`top` for your AI coding agents.** A read-only terminal monitor that shows every Claude Code, Codex CLI and Antigravity CLI session on your machine in one live screen: what each one is doing, which ones are waiting for you, and how many tokens they used.

![aitop showing Claude Code, Codex and Antigravity sessions (demo data)](https://raw.githubusercontent.com/SejuneOh/aitop/main/docs/demo.gif)

- **Live status** of every session and its subagents: thinking, running a tool, waiting for you, idle
- **Waiting alerts**: blocked sessions jump to the top, with optional bell, desktop notification or hook command
- **Tokens and cost** per session and for today / last 7 days, at public API list prices
- **Changed files and diffs** per session and per prompt
- **Read-only**: no network, no ports, no dependencies. It only reads the session logs each CLI already writes

> The UI follows your locale: English by default, Korean when the locale starts with `ko`. Set `AITOP_LANG=ko|en` (or `--lang`) to pick one. This covers the live screen, `--once`, `--help`, `--doctor`, error messages and desktop notifications. Keys and options work the same in both.

## Install

Requires Node.js 22+ on Linux, macOS, WSL or Windows.

Native Windows support is early (Windows Terminal recommended): Claude Code and Codex sessions, `--once`, `--json`, `--report` and `--doctor` work, but process detection, desktop notifications and `--on-waiting` are not there yet ([#195](https://github.com/SejuneOh/aitop/issues/195)-[#197](https://github.com/SejuneOh/aitop/issues/197)). Until then a Codex session counts as running while its log was written in the last 10 minutes, so it drops out during a long step that writes nothing for over 10 minutes, and a crashed session can stay up to 10 minutes. Cache, log and config live in `%LOCALAPPDATA%\aitop\cache`, `%LOCALAPPDATA%\aitop\state` and `%APPDATA%\aitop` unless `XDG_*` is set.

```bash
npm install -g @sejuneoh/aitop
aitop
```

## Usage

```
aitop            live screen
aitop --all      include sessions that ended in the last 24 hours
aitop --json     print a snapshot as JSON and exit
aitop --doctor   check which tools and logs aitop can see
aitop --line     print one short status line and exit (for tmux, e.g. $54.13 wait 2 fix-login 3m run 3 $3.1/h)
aitop --report daily  daily cost table and exit
aitop --report monthly  monthly cost table (last 12 months) and exit
aitop --help     all options
aitop --lang ko  Korean screen, help, doctor and error messages (also AITOP_LANG=ko or "lang": "ko" in the config file)
```

The language is picked from `--lang`, then `AITOP_LANG`, then `lang` in the config file, then `LC_ALL`, `LC_MESSAGES` and `LANG`: Korean when the locale starts with `ko`, English otherwise (including `C.UTF-8` and unset). If you used aitop on a `C.UTF-8` or `en_US` locale before, the screen, help and doctor output are now in English; set `AITOP_LANG=ko` to keep Korean.

In `--json`, `phase` stays the Korean status text in every language (as does `AITOP_WAITING_FOR` for `--on-waiting`). For scripts, use `phaseKind`, a stable state name: `think`, `write`, `tool`, `team`, `waiting`, `idle`, `done`, `ended` (or `null`). Other text fields follow their own rules: with English selected, `--doctor --json` has Korean `tools.*.hint` but English `config.problems`.

### Daily report

`aitop --report daily` prints tokens and cost (API list price, like the header) per day, newest first, with a total row, then exits. Columns are per tool by default, per model with `--by model`, or per project with `--by project` (the last folder name of the working directory: Claude log `cwd`, Codex `turn_context.cwd`, agy workspace; Claude Code worktrees under `<repo>/.claude/worktrees/` count as the repo; `(unknown)` when missing; extra columns beyond the terminal width are merged into `(others)`, `--json` lists all with a `paths` map); `--days N` goes back up to 30 days, and `--json` gives the same numbers for scripts. The first run reads up to 30 days of logs, so it can take a while (progress shows on stderr); later runs use the cache.

```
aitop --report daily --by model --days 14
aitop --report daily --by project --days 7
```

`aitop --report monthly [--by tool|model|project] [--months N] [--json]` prints the same per month, newest first, for up to 12 months. Past days are folded into `monthly.json` in the cache folder (`~/.cache/aitop`, outside the versioned cache) about two days later, so monthly totals survive cache rebuilds and Claude Code deleting old transcripts. The first run reads up to a year of remaining logs once. `*` marks this month, `~` a month only partly counted (for example before the oldest remaining Claude log), and `no data` a month with neither logs nor archive (unknown, not zero). The archive keeps token counts per type, so costs are recomputed when the price table changes. In `--json`, rows have `month`, `current` and `status` (`complete`, `partial` or `missing`).

```
aitop --report monthly --by model --months 6
```

### Notifications

Off by default and only on the live screen. Sessions already waiting (or already over 90% context) when aitop starts are not reported.

```
aitop --notify                       desktop notification when a session starts waiting (notify-send on Linux/WSL, osascript on macOS)
aitop --notify=waiting,done,context  pick the kinds; plain --notify uses the config file kinds, or waiting only when none are set
aitop --on-waiting 'my-hook.sh'      run a command with /bin/sh -c for the same events (10 second limit, runs as you)
```

- `waiting`: a session starts waiting for your approval or answer.
- `done`: a session that was busy for over 3 minutes in one turn (config `doneMinutes`; time spent waiting for approval does not count) goes idle and stays idle for 5 seconds. Brief idle gaps between tool calls, approval waits, ended sessions, subagents and sessions whose status is guessed from file times are not reported. Once per turn.
- `context`: context use passes 90%, once; it re-arms after it drops below 85% (for example after compaction).

The hook keeps its name: it gets `AITOP_EVENT` (`waiting`, `done` or `context`) plus `AITOP_TOOL`, `AITOP_PROJECT`, `AITOP_SESSION_ID`, `AITOP_CWD` and `AITOP_WAITING_FOR` in its environment. Config file: `"notify": true` or `"notify": ["waiting", "done", "context"]`, `"onWaiting": "..."` (file must be `chmod 600`), `"doneMinutes": 5`. Plain `--notify` keeps the kinds from the config `notify` list (waiting only when there is none). `--no-notify` turns off only the desktop notification: the hook still follows those kinds. `--bell` stays waiting only.

### tmux status line

`aitop --line` prints today's cost (API list price, `/$<budget>` when a daily budget is set), the sessions waiting for you with the longest waiting one's name and wait time (`wait fix-login 3m` for one, `wait 2 fix-login 3m` for more; Claude Code read live, names cut to 12 columns with `~`), the number of sessions running (`run 3`), and spend over the last hour. Items that are 0 are left out, and `--line-width N` (default 40) drops items from the end (the waiting name goes before the waiting count; with a daily budget and a waiting name, `$/h` often does not fit in 40, so raise `--line-width` to keep it). It reads only aitop's cache, so it is fast once `aitop` has run before; with no cache yet it prints `...` after about 1.5 seconds. The running count (and waiting Antigravity sessions with their names) come from a small summary that the live screen, `--once` and `--json` write to the cache; when no summary is newer than 60 seconds, `run` is left out rather than shown wrong. `--line=tmux` adds tmux colors, `NO_COLOR` turns them off.

Session names come from your sessions, so in tmux always use `--line=tmux`: it escapes `#` in names, while plain output could let tmux expand a `#{...}` or `#(...)` inside a name. In a zsh prompt with `PROMPT_SUBST`, a `%` in a name can be expanded by zsh, so escape `%` (for example `${$(aitop --line)//\%/%%}`) or use the line only in tmux.

```tmux
set -g status-right '#(aitop --line=tmux)'
set -g status-interval 15
```

Keys: `↑↓` select · `n` next session to check · `/` search · `s` sort · `g` group · `p` pin · `f` changed files · `?` help · `q` quit

Settings can also go in `~/.config/aitop/config.json` (`%APPDATA%\aitop\config.json` on Windows). See `aitop --help` or the [detailed manual (Korean)](https://github.com/SejuneOh/aitop/blob/main/docs/README.ko.md).

## License

[MIT](https://github.com/SejuneOh/aitop/blob/main/LICENSE)
