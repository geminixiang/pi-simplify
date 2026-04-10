# pi-simplify

A [pi coding agent](https://github.com/mariozechner/pi) extension that adds a `/simplify` command to review changed code for reuse, quality, and efficiency — then fix any issues found.

## What it does

Running `/simplify` launches three parallel sub-agents that each review your git diff from a different angle:

- **Code Reuse** — finds newly written code that duplicates existing utilities or helpers
- **Code Quality** — catches hacky patterns: redundant state, parameter sprawl, copy-paste blocks, leaky abstractions, stringly-typed code, unnecessary comments
- **Efficiency** — spots unnecessary work, missed concurrency, hot-path bloat, memory leaks, and overly broad operations

After all three agents finish, issues are aggregated and fixed in place. A brief summary is printed at the end.

## Installation

### 1. Install pi-subagents

`pi-simplify` relies on the Agent tool provided by the `pi-subagents` package. Install it first:

```sh
pi install npm:pi-subagents
```

### 2. Install pi-simplify

```sh
pi install npm:@geminixiang/pi-simplify
```

## Usage

After installation, the `/simplify` command is available inside pi:

```
/simplify
```

You can also pass an optional focus area to narrow the review:

```
/simplify focus on performance in the database layer
```

## License

MIT
