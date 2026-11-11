# ⣠⣴⣾ aitop

[![npm](https://img.shields.io/npm/v/@sejuneoh/aitop)](https://www.npmjs.com/package/@sejuneoh/aitop)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/SejuneOh/aitop/blob/main/LICENSE)

**`top` for your AI coding agents.** A read-only terminal monitor that shows every Claude Code, Codex CLI and Antigravity CLI session on your machine in one live screen: what each one is doing, which ones are waiting for you, and how many tokens they used.

- **Live status** of every session and its subagents: thinking, running a tool, waiting for you, idle
- **Waiting alerts**: blocked sessions jump to the top, with optional bell, desktop notification or hook command
- **Tokens and cost** per session and for today / last 7 days, at public API list prices
- **Changed files and diffs** per session and per prompt
- **Read-only**: no network, no ports, no dependencies. It only reads the session logs each CLI already writes

> The interface text is currently in Korean. Keys and options work the same everywhere.

## Install

Requires Node.js 22+ on Linux, macOS or WSL.

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
aitop --line     print one short status line and exit (for tmux, e.g. $54.13/$50 wait 2 $3.1/h)
aitop --help     all options
```

### tmux status line

`aitop --line` prints today's cost (API list price, `/$<budget>` when a daily budget is set), the number of Claude Code sessions waiting for you, and spend over the last hour. Items that are 0 are left out, and `--line-width N` (default 40) drops items from the end. It reads only aitop's cache, so it is fast once `aitop` has run before; with no cache yet it prints `...` after about 1.5 seconds. `--line=tmux` adds tmux colours, `NO_COLOR` turns them off.

```tmux
set -g status-right '#(aitop --line=tmux)'
set -g status-interval 15
```

Keys: `↑↓` select · `n` next session to check · `/` search · `s` sort · `g` group · `p` pin · `f` changed files · `?` help · `q` quit

Settings can also go in `~/.config/aitop/config.json`. See `aitop --help` or the [detailed manual (Korean)](https://github.com/SejuneOh/aitop/blob/main/docs/README.ko.md).

## License

[MIT](https://github.com/SejuneOh/aitop/blob/main/LICENSE)
