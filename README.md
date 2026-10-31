# LEGION

LEGION is a Windows-first Electron desktop assistant: a calm, provider-independent AI conversation layer connected to real voice services, approved desktop tools, and the GLY visual system.

LEGION is not a separate chatbot. The existing Electron shell, preload bridge, main-process services, renderer state, voice pipeline, and optional Dynamic Island form one application.

## Vision

LEGION should be useful on the desktop without becoming an unrestricted command runner. AI requests are translated into typed tools, validated in the main process, constrained by sandbox and allowlists, and confirmed when an action is sensitive.

## Features

- Streaming Gemini, OpenAI, and Anthropic conversations.
- Context-aware session memory and optional long-term memory.
- Main-process-only API keys and provider connections.
- Push-to-talk, continuous listening, and optional wake-word recognition.
- Voice pack, Edge neural, Piper, and Windows SAPI speech output tiers.
- Curated application, URL, file, system, window, clipboard, media, notification, and lock tools.
- Explicit confirmation for sensitive or destructive actions.
- CPU, memory, battery, storage, network, process, and uptime information.
- Optional Dynamic Island that mirrors the main shell.
- GLY particle mark rendered with WebGL and measured audio response.

## Screenshots

Visual references are available in [`artifacts/`](./artifacts). The live render checks also write screenshots there. Generated artifacts are ignored by Git.

## Dynamic Island

The Island is disabled by default and is additive rather than a second application. It mirrors state, captions, streamed text, user messages, measured audio, and tool progress from the main renderer. It can be positioned on supported displays, expanded, pinned, collapsed automatically, and used for listen, chat, stop, and cancel actions.

## GLY visual system

The main shell and Island use the same procedural three-arc particle mark, sampler worker, shaders, theme table, and WebGL stage. The renderer keeps the camera projection matched to the drawing-buffer aspect so the mark remains circular on widescreen displays. Reduced-motion, theme, bloom, scanline, and adaptive-quality settings are supported.

## AI architecture

The renderer sends a turn through the explicit preload bridge. The main process builds bounded conversation context, creates the selected provider adapter, streams deltas through `ai:event`, executes native tool rounds through the registry, appends the final response to memory, and hands speech to the existing TTS pipeline.

Provider adapters share one contract for messages, tools, usage, models, streaming, timeouts, retries, and cancellation. Provider failures use stable error codes. There is no hidden local provider fallback.

## Supported AI providers

- **Gemini** — default; API key `GEMINI_API_KEY`; streaming and native function calls.
- **OpenAI** — API key `OPENAI_API_KEY`; streaming and native function calls.
- **Anthropic** — API key `ANTHROPIC_API_KEY`; streaming and native tool use.
- **Development mock** — available only in development builds and never in production.

## Voice input and output

Microphone capture is explicitly user initiated unless the user enables the opt-in launch setting. Renderer audio capture uses browser permission handling, echo cancellation, noise suppression, automatic gain control, VAD, and a selected input where supported. Main performs recognition with optional Whisper or Windows System.Speech.

Speech output uses this fallback order:

1. Exact voice-pack clip.
2. Microsoft Edge neural voice when `ttsMode` is `auto`.
3. Optional local Piper runtime/model.
4. Windows SAPI.

Speech rate, volume, mute, cancellation, continuous listening, and wake-word settings are exposed in Settings.

## Desktop agent capabilities

The tool registry includes:

- `system_*` tools for CPU, RAM, battery, storage, network, processes, uptime, and full status.
- `apps_*` tools for curated applications, URLs, paths, and visible windows.
- `files_*` tools constrained by the configured sandbox roots.
- `desktop_*` tools for windows, clipboard, screenshots, media keys, notifications, and session lock.
- `web_*`, `productivity_*`, and opt-in `dev_*` tools.

Tools have identifiers, descriptions, JSON-like schemas, validation, categories, risk levels, handlers, audit records, timeouts, and cancellation. The AI never receives unrestricted shell access.

## Technology stack

- Electron 33 and Node.js CommonJS main process.
- Vanilla ES-module renderer, DOM, WebGL2, and Web Audio.
- Vendored Three.js renderer module.
- `systeminformation` for host metrics.
- `msedge-tts` for online speech.
- electron-builder for NSIS and portable Windows packaging.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for process boundaries, IPC contracts, AI streaming, voice pipelines, tools, and rendering details.

```text
renderer UI/state/audio
        │ explicit allowlisted IPC
preload contextBridge
        │
main lifecycle/state/AI/memory/tools/voice/system services
        ├── provider adapters
        ├── curated tool registry and sandbox
        └── STT/TTS services
```

## Folder structure

```text
src/main/ai/          AI engine, provider adapters, personality
src/main/tools/       registry, sandbox, apps, desktop, files, system tools
src/main/voice/       STT, TTS, wake word, Piper, Edge, voice pack
src/main/system/      host metrics
src/main/main.js      Electron lifecycle, state machine, IPC handlers
src/main/island.js    Dynamic Island window controller
src/preload/          sole renderer/main bridge
src/renderer/js/      application, state, audio, panels, Island mirror
src/renderer/visuals/ GLY stage, sampler, particle field, logo model
src/renderer/styles/  shell and panel styles
scripts/              static, security, AI, voice, shell, render, and package checks
voicepack/            shipped prerecorded clips and manifest
assets/piper/         optional user-supplied Piper runtime/model location
docs/                 architecture and operational documentation
```

There is currently no `src/shared`, `tests`, or TypeScript tree; the repository uses runtime JavaScript checks and Electron integration checks instead.

## Installation

Requirements:

- Windows 10 or 11.
- Node.js 18 or newer.
- npm.
- A microphone for speech input.

```powershell
git clone https://github.com/JustAsAllen/LEGION.git
Set-Location LEGION
npm install
```

## Development setup

```powershell
npm run dev
```

The development build enables the local mock provider and mock TTS only for testing. For normal use, configure a real provider in Settings.

## Environment variables

Copy [`.env.example`](./.env.example) for reference. LEGION does not automatically load `.env` files.

```powershell
$env:GEMINI_API_KEY = '<key>'
$env:GEMINI_MODEL = 'gemini-3.5-flash'
```

Supported variables are `GEMINI_API_KEY`, `GEMINI_MODEL`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. Keys may also be entered in Settings and are stored in Electron `userData/secrets.json`; values never cross into the renderer.

## AI configuration

Choose the provider and model in Settings. The selected provider must have a configured key. Use **Test connection** to perform a real main-process provider validation. The optional live Gemini check is:

```powershell
$env:LEGION_LIVE_AI = '1'
$env:GEMINI_API_KEY = '<key>'
npm run check:ai
```

## Voice configuration

Use Settings for voice source mode (`auto`, `offline`, or `pack-only`), voice name, rate, volume, microphone behavior, continuous mode, and wake word. Piper is optional: place a compatible `piper.exe`, ONNX model, and required sidecar metadata in `assets/piper/` for development or the packaged resource location.

## Running LEGION

```powershell
npm start
npm run dev
```

The Windows launchers are [`Launch LEGION.bat`](./Launch%20LEGION.bat) and [`Launch LEGION.vbs`](./Launch%20LEGION.vbs).

## Building and Windows packaging

```powershell
npm run build   # unpacked build in release/
npm run dist    # NSIS and portable Windows targets
```

electron-builder includes `src/`, `assets/`, `voicepack/`, and `package.json`, and copies voice packs and optional Piper resources. Windows policy or signing restrictions can prevent launching unsigned local artifacts; see [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## Troubleshooting

- **No provider:** select a provider and configure its key in Settings.
- **Provider auth failure:** check the key and run **Test connection**.
- **No microphone:** grant Windows microphone permission and verify an input device.
- **No recognition:** install a Windows speech language or configure a working Whisper runtime/model.
- **No speech output:** use `offline` mode to avoid network dependence and verify a SAPI voice is installed.
- **Piper unavailable:** Piper is optional; LEGION falls through to SAPI.
- **Build blocked by symlinks/signing policy:** enable Windows Developer Mode or use the verification guidance in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Security

Renderer pages run with context isolation, sandboxing, node integration disabled, and web security enabled. Preload exposes named channels only. Secrets stay in main. File paths are sandboxed and symlink-checked. Applications are curated. Tool actions are validated, audited, cancellable, and confirmed according to risk.

See [`docs/SECURITY.md`](./docs/SECURITY.md).

## Testing

```powershell
npm run check          # full suite
npm run check:fast     # static, IPC, security
npm run check:ai       # provider and tool-loop checks
npm run check:voice    # real voice pipeline checks
npm run check:shell    # renderer shell and Island behavior
npm run check:render   # WebGL/render checks
npm run check:package  # packaged-content checks
```

The suite distinguishes real hardware/network checks from development-only mock checks. Do not treat a skipped live provider or unavailable Piper runtime as verified.

## Roadmap

Current remaining work is tracked in [`TODO.md`](./TODO.md), including encrypted secret storage, broader accessibility, Piper runtime verification, voice-pack management, and release signing.

## Contribution guidelines

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before changing code. Preserve the main/renderer boundary, use the existing tool and IPC patterns, add checks for behavior changes, and do not edit the vendored Three.js file.

## License

LEGION is licensed under the MIT license. Optional Piper binaries and voice models must be supplied only when their redistribution terms permit it.
