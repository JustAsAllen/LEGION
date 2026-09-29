# LEGION — Architecture

LEGION is a Windows-first Electron desktop assistant built around a strict privilege boundary and a small, explicit runtime surface.

## 1. Process architecture

    ┌──────────────── RENDERER ────────────────┐
    │ DOM · WebGL2 · Web Audio · state         │
    │ live AI text · panels · visual stages    │
    └──────────────────┬───────────────────────┘
                       │ contextBridge
                 explicit IPC channels
                       │
    ┌──────────────────▼──────────────────────┐
    │                 PRELOAD                 │
    │ fixed allowlist; no generic bridge      │
    └──────────────────┬──────────────────────┘
                       │
    ┌──────────────────▼──────────────────────┐
    │                  MAIN                   │
    │ state · AI · memory · tools · voice     │
    │ filesystem · network · OS integration  │
    └─────────────────────────────────────────┘

The renderer never directly imports fs, child_process, or network clients. Provider requests, secrets, tool execution, and voice synthesis remain in main.

## 2. Main-process tiers

| Area | Module | Responsibility |
|---|---|---|
| AI | src/main/ai/engine.js | conversation turn orchestration, tool rounds, streaming events |
| AI | src/main/ai/providers.js | OpenAI, Anthropic and Ollama adapters |
| AI | src/main/ai/personality.js | response/personality policy |
| Voice | src/main/voice/tts.js | four-tier synthesis and provenance |
| Voice | src/main/voice/voicepack.js | exact prerecorded phrase resolution |
| Voice | src/main/voice/edge.js | online neural synthesis |
| Voice | src/main/voice/piper.js | local Piper discovery, model metadata and synthesis |
| Voice | src/main/voice/stt.js | Windows speech recognition |
| Voice | src/main/voice/wake.js | continuous listening and wake word |
| Tools | src/main/tools/registry.js | model-visible tool catalogue |
| Tools | src/main/tools/sandbox.js | write roots and command policy |
| System | src/main/system/metrics.js | CPU/memory metrics |
| Core | src/main/main.js | window lifecycle, state machine and IPC registration |

## 3. IPC contract

Preload is the only renderer/main bridge. Each exposed action has a named channel and a corresponding main handler. The static/IPC checks reject half-wired channels.

### Streaming AI channel

    renderer
      │
      ├─ ai:chat ───────────────► main / AI engine
      │                              │
      │                              ├─ provider request
      │                              │    └─ Ollama NDJSON stream
      │                              │
      ◄──────── ai:event {delta} ────┘
      │
      ├─ accumulate/display streamed text
      │
      └─ final reply → existing TTS playback path

The network connection and credentials stay in main. The renderer receives text deltas and status/provenance events, not provider secrets.

If the configured provider is unavailable, the engine can detect a reachable local Ollama service when no provider is configured. The automatic path uses the same provider-independent engine and the same ai:event channel.

## 4. AI turn lifecycle

    input
      ↓
    AIEngine.respond()
      ↓
    provider selection
      ├─ configured provider
      └─ automatic local Ollama detection when provider = none
      ↓
    provider.chat(..., onDelta)
      ↓
    ai:event / delta
      ↓
    tool round(s), when requested
      ↓
    final accumulated reply
      ↓
    memory append
      ↓
    renderer TTS

Tool execution remains in main and is subject to the confirmation/sandbox policy.

## 5. Four-tier voice engine

    text
      │
      ▼
    ┌────────────────┐
    │ 1. Voice pack  │ exact clip?
    └───────┬────────┘
            │ miss
    ┌───────▼────────┐
    │ 2. Edge neural │ online allowed?
    └───────┬────────┘
            │ fail/unavailable
    ┌───────▼────────┐
    │ 3. Piper       │ local runtime/model?
    └───────┬────────┘
            │ fail/unavailable
    ┌───────▼────────┐
    │ 4. Windows SAPI│ final fallback
    └────────────────┘

Each tier is failure-tolerant: returning null moves to the next tier. The result records tier, source, and format.

### Piper packaging

Development discovery checks assets/piper/. Packaged Windows builds discover resources/piper/. electron-builder copies that directory as an extra resource. The runtime expects a compatible Piper executable, an ONNX model, and the model sidecar metadata where required.

The repository intentionally does not fabricate or silently download redistribution-sensitive runtime assets.

## 6. Renderer pipeline

    index.html
       │
       ├─ js/app.js ───── store / panels / stage / IPC wiring
       ├─ js/audio.js ─── mic + TTS playback + analysers
       ├─ js/state.js ─── observable state
       └─ visuals/stage.js
              │
              ├─ logo-model.js ── analytic three-arc ring
              ├─ sampler.worker.js ── off-main-thread sampling
              └─ particle-field.js ── GPU instance field

The renderer is unbundled ES modules. Three.js is vendored locally. This keeps the runtime transparent and avoids a second build system.

## 7. WebGL geometry lock

The segmented ring must remain a circle regardless of a 16:9 viewport. The stage therefore uses a square camera projection for the mark rather than deriving the projection from the window aspect ratio.

The renderer check records the live camera aspect and requires:

    camera.aspect === 1

The canvas itself may be widescreen; the mark projection remains 1:1. This prevents the ring from becoming an oval when the Electron window is wider than it is tall.

## 8. Audio path

Microphone input and speech playback use separate analysers. TTS audio is decoded in the renderer with decodeAudioData, then routed through the speech analyser so visual state is driven by actual audio rather than a timer.

## 9. State machine

    OFFLINE → BOOTING → IDLE ⇄ LISTENING
                               │
                               ▼
                           PROCESSING
                               │
                               ▼
                            SPEAKING
                               │
                               └──────→ IDLE

PROCESSING / SPEAKING may enter ALERT or ERROR as appropriate.

Main owns transitions. Renderer reports events such as speech completion; it does not invent application state.

## 10. Packaging

electron-builder uses:

- src/**/* — application source
- assets/**/* — visual assets and optional Piper runtime source
- voicepack/**/* — packaged example voice pack
- voicepack → resources/voicepack — editable installed copy
- assets/piper → resources/piper — local Piper runtime/model resources
- output directory: release/
- Windows targets: NSIS installer + portable executable

Build products are never source-controlled.

## 11. Verification layers

1. **Static** — syntax, scope, DOM/channel consistency.
2. **IPC/security** — channel registration, bridge allowlist, sandbox and secrets.
3. **Data/voice** — config, storage, TTS routing and voice-pack provenance.
4. **Live renderer** — shell behaviour, WebGL state and square camera projection.
5. **Package** — real unpacked build and installed resource layout.
6. **Optional live AI** — real Ollama streamed turn with LEGION_LIVE_AI=1.

The default suite stays offline unless a live check is explicitly enabled.

## 12. Data on disk

Electron user data contains configuration, secrets, memory and metrics. Development data is isolated from normal user data. Project-root voicepack/ and build-time assets/piper/ are repository resources, not user secrets.
