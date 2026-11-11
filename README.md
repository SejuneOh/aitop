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
aitop --help     all options
```

Keys: `↑↓` select · `n` next session to check · `/` search · `s` sort · `g` group · `p` pin · `f` changed files · `?` help · `q` quit

Settings can also go in `~/.config/aitop/config.json`. See `aitop --help` or the [detailed manual (Korean)](https://github.com/SejuneOh/aitop/blob/main/docs/README.ko.md).

## License

[MIT](https://github.com/SejuneOh/aitop/blob/main/LICENSE)
