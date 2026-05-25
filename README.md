# pi-simplify

[![npm version](https://img.shields.io/npm/v/@geminixiang/pi-simplify.svg)](https://www.npmjs.com/package/@geminixiang/pi-simplify)

A [pi coding agent](https://github.com/mariozechner/pi) extension that cleans up leftover code after feature implementation.

## What it does

After implementing a feature, your code often accumulates:

- **Dead code** - unused exports, orphaned files, zombie variables
- **Debug remnants** - console.log, debugger statements, temp flags
- **Commented-out code** - old logic left in comments
- **Over-engineering** - "might use later" abstractions never used
- **Duplicate logic** - repeated if-else blocks doing the same thing

`/simplify` finds these and removes them.

## Installation

```sh
pi install npm:@geminixiang/pi-simplify
```

## Usage

### Full Simplify

```
/simplify
```

Analyzes all git changes and presents cleanup candidates:

- **Safe** (green) - auto-selected, will be deleted
- **Confirm** (yellow) - delete after user confirms
- **Review** (orange) - user should review first

### With Focus

```
/simplify focus on the utils folder
/simplify focus on removing debug code
```

## Comparison with pi-review

|              | pi-review                   | pi-simplify           |
| ------------ | --------------------------- | --------------------- |
| **Goal**     | Find problems               | Delete excess         |
| **Attitude** | Conservative (marks issues) | Active (removes junk) |
| **Output**   | Findings list               | Deletion plan         |
| **Trigger**  | Manual review               | Post-feature cleanup  |

## License

MIT
