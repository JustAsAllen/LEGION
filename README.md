<div align="center">
  <img src="assets/logo.svg" width="180" alt="LEGION logo" />

  <h1>LEGION</h1>
  <p><strong>A personal AI intelligence living inside your computer.</strong></p>
</div>

---

LEGION is a desktop assistant built on Electron. It listens, speaks, watches its
own resource usage, and shows you what it is doing through a GPU-rendered
particle mark — three arc segments of a ring with gaps at 2, 6 and 10 o'clock.

The mark is not an image. Every point is sampled against an analytic ring
definition in a Web Worker and shaded in a fragment shader, so it reacts to
state (idle, listening, thinking, speaking), theme and system load in real time.

## Screens

![LEGION idle](assets/screenshot-idle.png)

## What it does

- **Voice** — push-to-talk, continuous listening and a configurable wake word, with
  end-of-turn and silence handling.
- **Visual mark** — a live segmented ring that reflects app state and system load.
- **Settings** — waveform, redaction, wake phrase, theme, and audio device controls
  that are actually wired to real state.
- **Confirmations** — a confirmation gate for anything with impact, so a tool call
  never happens silently.
- **First run** — a guided setup that can be dismissed and is safe to re-enter.

## Requirements

- Windows (the launchers are `.bat` and `.vbs`)
- Node.js 18 or newer
- A microphone, if you want to use the voice features

## Install

```bash
npm install
```

## Run

Double-click one of the launchers in the project root:

- **`Launch LEGION.vbs`** — silent, no console window. This is the recommended one.
- **`Launch LEGION.bat`** — keeps a console window, useful if you want to see
  startup errors.

Or from a terminal:

```bash
npm start        # normal
npm run dev      # with devtools
```

## Checks

LEGION ships with a check suite. Each one is a real test against a live app or a
live static analysis, not a unit test with mocks.

```bash
npm run check       # everything
npm run check:fast  # static + scope self-test + IPC
```

| Script | What it covers |
|---|---|
| `npm run selftest` | The static-check scope analyzer's own test cases |
| `npm run check:static` | Syntax, missing handlers, DOM ids, and undeclared reads (acorn AST walk) |
| `npm run check:ipc` | Every `ipcMain` handler is registered and reachable |
| `npm run check:data` | The data layer: config, storage, round trips |
| `npm run check:voice` | STT/TTS routing, error paths, provider fallback |
| `npm run check:firstrun` | First-run flow and dismiss handling |
| `npm run check:shell` | Live UI: geometry, panel behaviour, modals, settings round trips |
| `npm run check:render` | The live renderer: frame rate, element counts, WebGL errors |

`check:static` parses every project file with acorn and reports undeclared reads
instead of trusting a hand-maintained list of globals. Vendored three.js is
skipped.

## Build a distributable

```bash
npm run dist
```

Outputs land in `release/`. Windows targets are an NSIS installer and a portable
executable.

## Project layout

```
src/
  main/        main process, window, IPC handlers
  renderer/    the UI, the mark, and the Web Worker that samples it
    visuals/   ring geometry, particle field, glyph atlas, stage
    js/        app shell, panels, audio
scripts/       the check suite
assets/        logo
```

## Themes

`legion-dark`, `abyss`, `ember`, `mint` and `mono`. The accent propagates to the
CSS, the waveform and the ring shader together, so a theme change is consistent
across the whole app.

## License

MIT
