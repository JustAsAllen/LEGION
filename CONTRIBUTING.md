# Contributing to LEGION

## Before you write code

Run the suite first, on a clean tree, so you know what "working" means for
your machine:

```bash
npm install
npm run check
```

It takes about three minutes. It boots the real app, not mocks, so if it is
green the app genuinely works. `npm run check:fast` (about five seconds) covers
the static and IPC checks only; use it while editing and run the full suite
before you commit.

Everything marked `[x]` in `TODO.md` has a check behind it. If you cannot write
a check for a change, the change is not verifiable yet, which is the one thing
this project will not ship.

## Conventions

- **Never fake functionality.** If a number is on screen, it is measured. No
  placeholders, no "coming soon" that looks like a feature, no simulated
  latency.
- Renderer files are ES modules. `main/` and `preload/` stay CommonJS. Do
  **not** add `"type": "module"` to `package.json`; it breaks the entry points.
- No comments that restate the code. A comment earns its place by explaining
  *why* something is the way it is, especially when the obvious version is
  wrong — the codebase has several of those, and each one exists because the
  naive version failed.
- Commits: `AREA: what changed`, uppercase area. `FIX:`, `VOICEPACK:`,
  `DOCS:`, and so on.
- `three.module.js` is vendored. Do not edit it; the static check skips it.

## Adding an IPC channel

This is the most common change and the easiest to get half-finished, because
the static check will catch an incomplete one:

1. Add the handler in `main.js` with `handle('area:action', ...)`.
2. Add the name to the allowlist in `preload.js`.
3. Add the caller as `invoke['area:action']` on the exposed object.
4. Run `npm run check:fast`.

`scope-analyzer.js` fails if a channel has a handler but no sender, a sender but
no handler, or is missing from the allowlist. That is the point of it.

## Adding a tool

1. Add the definition in the right `src/main/tools/*.js`, with a `name`, a
   `description` the model will read, a `risk`, and a `schema`.
2. Respect the sandbox. Anything that touches the filesystem or spawns a
   process goes through `tools/sandbox.js`; do not bypass it.
3. Anything destructive needs the confirmation gate, not a prompt string.
4. `npm run check:fast` — the analyzer will tell you if the tool is not
   reachable or is missing a schema.

## Adding a state

States are the array in `main.js` and nothing else may change them. Add the
state, every transition into and out of it in `setState`, and the renderer's
handling. A state that no path can reach is dead code; a state with no exit is
a hang.

## Adding a voice pack clip

Drop a `.wav` or `.mp3` in `voicepack/`, named after the phrase
(`on-it.mp3` matches "on it"), or add an entry to `voicepack/manifest.json` for
an awkwardly named file. Matching is exact on the normalised phrase. Verify with
`npm run check:voicepack`.

To regenerate the shipped example clips: `npm run voicepack:sample`.

## Measuring a change

`npm run bench` boots the app and measures frame times, heap growth and the
quality tier over a soak window:

```bash
npm run bench          # 30 s
npm run bench 600      # 10 minutes, for a leak claim
npm run bench 180 --json
```

It refuses to run if a LEGION instance is already alive, because a stray process
makes every number quietly wrong. If it reports that the window was not
presenting, close whatever is covering it and re-run.

The JS heap is the meaningful leak signal. Summing RSS across the Electron
processes double-counts large shared pages and overstates real usage.

## Reporting a bug

The useful details are all in the failing check: the command, the assertion, and
what it printed. If it is a visual or timing bug, the number in the output is
usually the whole story.
