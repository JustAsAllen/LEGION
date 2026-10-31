# LEGION

> **A personal AI intelligence living inside your computer.**

LEGION is a Windows-first Electron desktop assistant with a strict main/renderer security boundary, real-time WebGL visuals, voice input/output, provider-independent AI, streamed Gemini responses, four-tier TTS, tool execution with confirmation, and production packaging through electron-builder.

## Executive summary

LEGION is built as a self-contained desktop runtime rather than a web wrapper. The renderer owns presentation and interaction. The main process owns privileged work, AI providers, filesystem/network access, memory, tools, and voice orchestration. Preload exposes only an explicit IPC surface.

The production path is:

    user input → renderer → preload → main/AI
               → streamed ai:event deltas
               → final reply → four-tier TTS → renderer audio

The visual path is equally deliberate: a procedurally generated three-segment ring is sampled in a Web Worker and rendered through WebGL with a square camera projection, so the mark stays circular on 16:9 displays.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop runtime | Electron 33 |
| Main process | Node.js / CommonJS |
| Renderer | Vanilla ES modules, DOM, WebGL2, Web Audio |
| 3D/rendering | Three.js, vendored for the renderer |
| AI | Provider-independent engine + Gemini/OpenAI/Anthropic adapters |
| Streaming | Gemini SSE, OpenAI SSE and Anthropic event streams |
| Voice | Voice pack → Edge neural → Piper → Windows SAPI |
| IPC | Electron contextBridge + explicit channel allowlist |
| Packaging | electron-builder, NSIS + portable Windows targets |
| Verification | Acorn static checks + live Electron/shell/render/package checks |

## Architecture

    ┌──────────────── RENDERER ────────────────┐
    │ UI · WebGL · Web Audio · state           │
    │ live AI text + panels + visual stages    │
    └──────────────────┬───────────────────────┘
                       │ explicit IPC
                ┌──────▼──────┐
                │   PRELOAD   │
                │ allowlisted │
                └──────┬──────┘
                       │
    ┌──────────────────▼───────────────────────┐
    │                  MAIN                    │
    │ state · AI · tools · voice · memory     │
    │ filesystem · network · OS integration   │
    └──────────────┬────────────────┬──────────┘
                   │                │
              AI providers       TTS engine
                   │                │
          Gemini/OpenAI/      1. Voice pack
          Anthropic            2. Edge neural
                               3. Piper local
                               4. Windows SAPI

### Streaming AI

The renderer submits turns through the ai:chat channel. Main owns the provider connection and emits provider text deltas through the existing ai:event channel. The renderer accumulates and displays those deltas live.

Gemini is the default provider. It streams server-sent events through the same `ai:event` channel, sends the registry's tool schemas in Gemini's uppercase OpenAPI form, and reports blocked prompts, auth failures and rate limits as typed errors. An unset provider is refused with `E_NO_PROVIDER`; there is no hidden local fallback.

When the turn completes, the final accumulated reply enters the normal TTS pipeline. Streaming changes the response presentation, not the voice/security architecture.

### Four-tier voice engine

1. **Voice pack** — exact prerecorded phrases, instant and offline.
2. **Edge neural** — online neural synthesis when the selected mode permits network use.
3. **Piper** — local neural TTS when a compatible runtime/model is present.
4. **Windows SAPI** — final system fallback.

Every failed tier returns null and allows the next tier to answer. The selected tier, source, and format are preserved as provenance.

### Dynamic Island (opt-in)

An optional second window mirrors state that main already broadcasts: status,
metrics, streaming reply, and quick listen/stop/cancel controls. It is off by
default (`ui.island.enabled`), opens from the tray, `Ctrl+Alt+I`, or Settings,
and runs the same allowlisted preload. It owns no state and never replaces the
main shell; with it disabled the original window is unchanged.

The pill defaults to the top centre of the primary display (380x64, expanding
to 380x480). Settings can move it to any of six positions on the primary
display, the display under the cursor, or a specific display index; bounds stay
inside that display's work area and follow monitor/DPI changes. Optional
auto-collapse returns it to the pill after a configurable idle time unless it is
pinned. `Ctrl+Alt+Space` opens it with the input focused.

The pill carries a 30 px version of LEGION's GLY particle mark, rendered by the
same stage, sampler, shaders and theme table as the main shell — not a second
logo or a second animation engine. It reacts to genuinely measured microphone
and playback levels while listening or speaking, stays subtle while idle, and
stops rendering entirely while the window is hidden. Reduced motion, theme
accent and glow follow the shell immediately.

### Desktop tools

Beyond files and apps, the tool registry exposes a curated desktop surface:
window list/focus/close, clipboard read/write, a full-screen PNG in the temp
folder, media keys, notifications, and session lock. Destructive actions (close,
clipboard read, screenshot, lock) require explicit confirmation.

## Repository layout

    LEGION/
    ├─ assets/
    │  ├─ logo.svg
    │  ├─ screenshot-idle.png
    │  └─ piper/                  optional local Piper runtime/model
    ├─ src/
    │  ├─ main/
    │  │  ├─ ai/                  engine, providers, personality
    │  │  ├─ system/              host metrics
    │  │  ├─ tools/               registry, sandbox, tool groups
    │  │  └─ voice/               TTS, STT, wake, Edge, Piper, packs
    │  ├─ preload/                 sole renderer/main bridge
    │  └─ renderer/
    │     ├─ js/                   app, state, panels, audio
    │     ├─ styles/               renderer CSS
    │     ├─ visuals/              WebGL stage, ring, particles, worker
    │     └─ vendor/               vendored Three.js
    ├─ scripts/                    checks and benchmark tooling
    ├─ voicepack/                  shipped prerecorded clips + manifest
    ├─ ARCHITECTURE.md
    ├─ CONTRIBUTING.md
    ├─ TODO.md
    └─ package.json

Build products never belong in source control: release/, dist/, win-unpacked/, logs, coverage, and local secrets are ignored.

## Quickstart

### Requirements

- Windows 10/11
- Node.js 18+
- npm
- A microphone for STT/voice features

### Install

    git clone https://github.com/JustAsAllen/LEGION.git
    cd LEGION
    npm install

### Run

    npm start

Development with DevTools:

    npm run dev

You can also double-click Launch LEGION.vbs for a silent launch or Launch LEGION.bat for a visible console.

### Verify

Normal hermetic verification:

    npm run check

Fast static/security gate:

    npm run check:fast

Optional live Gemini verification:

    LEGION_LIVE_AI=1
    GEMINI_API_KEY=<your-key>
    GEMINI_MODEL=gemini-3.5-flash
    npm run check:ai

The live AI check is skipped unless explicitly enabled.

### Build

Unpacked production build:

    npm run build

Full Windows distributables:

    npm run dist

Outputs go to release/. electron-builder targets both NSIS and portable Windows packages. The packaged application includes src/, assets/, voicepack/, and the optional assets/piper/ runtime under resources/piper/.

On a non-elevated Windows shell the build helper may fail while extracting macOS symlinks; see the Releasing note in CONTRIBUTING.md.

For Piper, supply a compatible piper.exe, ONNX voice model, and its sidecar metadata in assets/piper/. Runtime binaries/models are intentionally not fabricated or committed without compatible redistribution rights.

## Verification commands

| Command | Purpose |
|---|---|
| npm run check | Full source, IPC, security, data, voice, UI, render and AI-check suite |
| npm run check:fast | Quick static/scope/IPC/security gate |
| npm run check:render | Live WebGL checks including square projection |
| npm run check:island | Live checks for the opt-in Dynamic Island window |
| npm run check:package | Checks the real release/win-unpacked package |
| npm run check:launch | Verifies the real launcher and live render loop |
| npm run bench | Performance, heap and frame benchmark |
| npm run dist | NSIS + portable distributables |

check:package is host-policy aware. If Windows blocks an unsigned test executable, LEGION_ALLOW_UNSIGNED_PACKAGE_CHECK=1 permits static package validation while still reporting that runtime launch was not verified.

## Voice packs

voicepack/manifest.json maps exact phrases to .wav or .mp3 clips. A pack hit always wins before synthesis. See voicepack/README.md for the format.

## Security model

- Renderer has no direct Node.js filesystem, process, or network access.
- Secrets stay in main and never cross IPC as values.
- Preload exposes explicit allowlisted operations only.
- Tool execution uses sandbox roots and command allowlists.
- Shell path operations re-check traversal and symlinks.
- AI provider connections remain in main.
- High-impact tools pass through confirmation.

## Documentation

- **ARCHITECTURE.md** — process boundaries, IPC, AI streaming, voice tiers, renderer pipeline and packaging.
- **CONTRIBUTING.md** — development conventions and verification workflow.
- **TODO.md** — implementation status and remaining release/accessibility work.

## License

MIT
