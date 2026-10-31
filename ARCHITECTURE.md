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
| AI | src/main/ai/providers.js | Gemini, OpenAI and Anthropic adapters |
| AI | src/main/ai/personality.js | response/personality policy |
| Voice | src/main/voice/tts.js | four-tier synthesis and provenance |
| Voice | src/main/voice/voicepack.js | exact prerecorded phrase resolution |
| Voice | src/main/voice/edge.js | online neural synthesis |
| Voice | src/main/voice/piper.js | local Piper discovery, model metadata and synthesis |
| Voice | src/main/voice/stt.js | Windows speech recognition |
| Voice | src/main/voice/wake.js | continuous listening and wake word |
| Tools | src/main/tools/registry.js | model-visible tool catalogue |
| Tools | src/main/tools/sandbox.js | write roots and command policy |
| Tools | src/main/tools/apps.js | curated application launch and window list |
| Tools | src/main/tools/desktop.js | window focus, clipboard, screenshot, media keys, notifications, lock |
| System | src/main/system/metrics.js | CPU/memory metrics |
| Core | src/main/main.js | window lifecycle, state machine and IPC registration |
| Core | src/main/island.js | opt-in Dynamic Island window, bounds and state mirror |

## 3. IPC contract

Preload is the only renderer/main bridge. Each exposed action has a named channel and a corresponding main handler. The static/IPC checks reject half-wired channels.

### Streaming AI channel

    renderer
      │
      ├─ ai:chat ───────────────► main / AI engine
      │                              │
      │                              ├─ provider request
      │                              │    └─ Gemini/OpenAI/Anthropic SSE
      │                              │
      ◄──────── ai:event {delta} ────┘
      │
      ├─ accumulate/display streamed text
      │
      └─ final reply → existing TTS playback path

The network connection and credentials stay in main. The renderer receives text deltas and status/provenance events, not provider secrets.

If the configured provider is unavailable, the engine refuses the turn with `E_NO_PROVIDER`. It does not probe for or adopt a hidden local backend; provider choice is explicit in Settings or first run.

### Provider contract

Every adapter honours the same shape, so nothing above it learns a backend detail:

    chat({ system, messages, tools, temperature, maxTokens, signal, onDelta })
      -> { text, toolCalls: [{ id, name, arguments }], usage, model }

Three rules are enforced in `providers.js` rather than per adapter:

- **Streaming is mandatory.** Passing `onDelta` makes every provider stream.
  Gemini, OpenAI and Anthropic all send server-sent events. One line reader
  serves all three, and tool calls are reassembled from whatever frames carried
  them. Gemini function arguments arrive as complete objects; OpenAI and
  Anthropic arguments are accumulated JSON fragments.
- **Two deadlines, deliberately different.** `ttfb` bounds connect plus
  queueing; `idle` bounds the gap between two chunks, so a long steady
  generation is never killed but a stalled one cannot hang the turn.
  Both are raced, not merely signalled, so a transport that ignores its abort
  signal still cannot stall a turn.
- **Cancellation is wired to the socket for the whole call**, headers and body
  alike, and interrupts a pending read. Releasing the abort once headers land
  would make cancel a no-op for the rest of the stream.
- **Retry is bounded and pre-delta only.** A rate limit, connection failure,
  timeout, HTTP 5xx or dropped stream is retried up to three attempts with
  `retry-after` honoured and capped exponential backoff. Once a single text
  delta has reached the renderer the request is not replayed, because that would
  duplicate visible output. Each retry emits a `retry` event.
- **Tool rounds use native transcripts.** The engine sends one assistant turn
  carrying every `toolCalls` entry, followed by `role: 'tool'` result messages.
  Each adapter translates that shape (`tool_use`/`tool_result` for Anthropic,
  `tool_calls`/`role: 'tool'` for OpenAI, `functionCall`/`functionResponse` for
  Gemini) instead of flattening tool output into user prose.

Every failure is a `ToolError` with a stable code, so main can report it
without inspecting the adapter: `E_AI_AUTH`, `E_AI_RATE_LIMIT`, `E_AI_BLOCKED`,
`E_AI_HTTP`, `E_AI_TIMEOUT`, `E_AI_STREAM`, `E_AI_MALFORMED`, `E_AI_CONN`,
`E_NO_PROVIDER`, `E_NO_KEY`, `E_ABORTED`.

### Provider selection and status

Gemini is the default provider, with OpenAI and Anthropic selectable alongside
it. The selected provider is the only path: `resolveProvider` reads the setting
and refuses an unset provider rather than guessing at a local runtime.

`ai:status` and `ai:probe` report presence, not values. For cloud providers the
key is read in main from the environment or `userData/secrets.json`; the
renderer only learns whether a key is configured and which environment variable
could supply it. A legacy saved `ollama` setting is migrated to Gemini and its
local model and endpoint are cleared.

### Dynamic Island window

The Island is an optional second window, off by default (`ui.island.enabled`),
and never a replacement shell. `src/main/island.js` owns its bounds and its
visibility only: it holds no application state, runs no tools, and mirrors what
main already broadcasts. With the setting off, the original window and renderer
are unchanged.

    main
      ├─ state / metrics / ai:event ─► both windows (send() fan-out)
      ├─ island:state ───────────────► island renderer (status, bounds, display)
      ├─ island:relay ───────────────► island renderer (state, caption, user turn)
      │
      ◄─ island:status / displays / show / hide / toggle / expand / pin
      ◄─ island:focusInput / command
      ◄─ island:action ──────────────► main renderer (listen, stop, cancel, chat,
      │                                 settings, show, resync)
      ◄─ island:push ────────────────► relay from the main renderer (guarded)

The window is frameless, transparent, and always-on-top. It defaults to the top
centre of the primary display (`top-center`), 380x64 collapsed and 380x480
expanded. Six positions are supported (`top|bottom` x `left|center|right`),
the target display is `primary`, `cursor`, or a display index, and bounds are
clamped to that display's work area. Display added/removed/metrics changes
re-run positioning, so mixed-DPI and multi-monitor layouts stay inside the
visible desktop. `skipTaskbar` and `showInactive()` keep it out of the taskbar
and out of the user's focus.

On Windows/Electron 33 `setAlwaysOnTop(true)` is silently ignored for a window
created hidden; the controller re-applies `setAlwaysOnTop(true, 'screen-saver')`
after the window is shown. At 125% scaling Windows reports rounded bounds, so
tests compare window sizes with a one-pixel tolerance.

Optional auto-collapse (`autoCollapse`, `autoCollapseMs`, minimum 1500 ms)
returns the panel to the pill after inactivity unless it is pinned; losing focus
collapses it unless pinned. It is toggled from the tray, by `Ctrl+Alt+I`, or
from Settings, and `Ctrl+Alt+Space` opens it with the text input focused.

The same preload is used, so the bridge surface does not grow a second
implementation. `handle()` accepts either the main window or the Island as a
sender and rejects everything else; `send()` fans main events out to both
windows. A newly created island replays main's current state on
`did-finish-load` and asks the main renderer to re-send its live caption, because
broadcasts that fire while the window is loading would otherwise be lost. The
renderer also reports its settled `IDLE` boot state to main so the authoritative
state cannot stay stuck on `BOOTING`. The state it displays is broadcast, not
owned: if the Island is closed, the main process continues exactly as before.
A user-invoked cancel is reported as `cancelled`, not as an error, so mirrors
return to `IDLE` instead of flashing `ERROR` after stopping a turn.

#### GLY mark in the Island

The pill's mark is not a second logo: it is the same `LogoStage`,
`LogoLoader`, sampler worker, shaders and glyph atlas the shell uses, mounted
into a 30x30 square slot in the header. The slot stays square so the stage's
perspective fit keeps the segmented ring circular at every DPI; the thin CSS
ring underneath is a placeholder until `data-gly="ready"`, and a graceful
fallback if a WebGL context cannot be created.

A `BrowserWindow` necessarily owns its own WebGL context, so the rule is one
stage per island window, not one per app. The stage is created once on first
paint, kept for the window's lifetime, and disposed on `pagehide`. It is never
rebuilt when the window is hidden or restored: the same canvas and context are
paused and resumed.

The mark runs its own frame loop instead of `stage.start()`, because the island
needs a different policy from the shell:

| Condition | Frames |
| --- | --- |
| Hidden (`island.hide()` or `document.hidden`) | none |
| `IDLE` / `OFFLINE` | ~30 fps |
| Any active state | display rate |

The island uses the `low` quality tier with `particleScale: 0.35`, adaptive
quality off and pointer parallax off. That yields about 770 instances, inside
the field's 600-instance floor, which is what keeps the ring dense at 30 px
without the shell's 10k-instance budget.

State visuals are driven by the real state machine (`setState`), and audio by
measured levels relayed from the main renderer. The main shell owns the
microphone and playback analysers; the island never opens a device. While
listening or speaking it receives a `kind: 'audio'` payload at about 11 Hz, plus
one explicit zero frame when the turn ends so the mark relaxes. Theme accent,
glow, intensity, bloom and reduced motion arrive as a `kind: 'visual'` payload
whenever the shell applies a theme or Settings writes the visual policy. Both
windows therefore share one theme table (`THEME_VISUALS` in `app.js`) instead
of duplicating colours.

## 4. AI turn lifecycle

    input
      ↓
    AIEngine.respond()
      ↓
    provider selection
      └─ configured provider, or E_NO_PROVIDER when unset
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

### Desktop tools

`src/main/tools/desktop.js` is a curated desktop surface, not a shell escape:
window enumeration/focus/minimize/maximize/restore/close, clipboard read and
write, a full-screen PNG capture in the temp folder, media keys, a Windows
notification, and session lock. Every Windows call goes through a compiled
Win32 helper invoked with `execFile`; no user string is ever concatenated into a
PowerShell script. Clipboard text and notification text are passed as base64,
and window identity resolves to a numeric `hwnd` before the action runs.

Approval is enforced in the registry: closing a window, reading the clipboard,
capturing the screen and locking the session all declare a `confirm` plan, so
they cannot run when `tools.requireConfirmation` is on unless the user approves
the exact call in the UI. Media keys, notifications and focus changes do not
leave the machine and run without a prompt.

## 5. Four-tier speech synthesis

This is the tier ladder for turning text into audio. Recognition is a separate ladder; see [8.1](#81-speech-recognition-pipeline).

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

The segmented ring must remain a circle regardless of a 16:9 viewport. The stage derives the perspective projection from the renderer drawing-buffer aspect ratio, so the projection matches the widescreen canvas rather than being stretched by it.

The renderer check records the live camera and canvas aspects and requires them to match:

  camera.aspect === canvas.width / canvas.height

This preserves 1:1 screen-space geometry while allowing the canvas itself to remain widescreen. The vertical fit is held constant so the ring remains centered with padding around the shell chrome.

The island's mark box is square, so the same projection rule keeps its ring
circular; the island check asserts equal CSS and drawing-buffer dimensions.

## 8. Audio path

Microphone input and speech playback use separate analysers. TTS audio is decoded in the renderer with decodeAudioData, then routed through the speech analyser so visual state is driven by actual audio rather than a timer.

### 8.1 Speech recognition pipeline

The microphone belongs to the renderer, because only the browser can be given a chosen device and real echo cancellation. Recognition belongs to main, because only main can reach a recogniser. The two are joined by tapping the graph the browser already opened.

    renderer                                  main
    -------                                  ----
    getUserMedia({ audio: {
      echoCancellation, noiseSuppression,
      autoGainControl, channelCount: 1 }})
      │
      ├─ createScriptProcessor ──┐
      │                          │ 20ms Float32 frames
      │                          ▼
      │                  voice:captureChunk ──► resample to 16kHz mono
      │                                             │
      │                                             ▼
      │                                          VAD segments
      │                                             │
      │                                             ▼
      │                                       16-bit WAV in a temp file
      │                                             │
      │                                             ▼
      │                             whisper.cpp, or System.Speech on the file
      │                                             │
      ◄──────────── voice:captureEnd ──────────────┘

Frames go out on a fire-and-forget channel rather than `invoke`, because a 20ms frame is fifty messages a second for as long as someone is speaking, and none of them wants a reply. The frame that finishes a sentence therefore has no caller waiting on it, so main announces the result on `voice:captureEnd` instead of returning it.

`channelCount: 1` is requested because a stereo stream doubles the bytes on the wire and every recogniser here wants mono. The fallback path matters more than it looks: when a device rejects an exact selector, the request is retried *without the device id but with all four processing constraints intact*. Retrying with `{ audio: true }` opens the stream cleanly and silently discards echo cancellation, noise suppression and automatic gain, which looks like success and is not.

Chromium treats these constraints as hints rather than requirements — a device with no hardware echo canceller opens with `echoCancellation: false` and raises no error — so the granted values are read back from the track and reported in `voice:capabilities` rather than being presented as a guarantee.

### 8.2 Why System.Speech cannot honour a device selection

System.Speech exposes no capture-device API, only `SetInputToDefaultAudioDevice()`. The engine that listens to the system default input directly therefore cannot be given the microphone chosen in Settings, and cannot be given browser DSP either, because it opens the device behind the browser's back. That limitation is the reason the capture pipeline above exists: audio we take ourselves can be recognised from a file, and a file can be recogniser-agnostic.

### 8.3 Device arbitration

One input device serves the wake listener, a capture, and the synthesiser. System.Speech permits a single engine per device, so two of them at once makes both unusable rather than merely noisy. The listener is held for the *whole* of a capture and of a synthesis, nested by counter, and a pending restart is refused while the device is held.

### 8.4 Recognition engines

Engines are tried in tier order and the first that works wins:

| engine | device | echo cancellation | notes |
| --- | --- | --- | --- |
| `whisper` | renderer-selected | yes | optional external binary |
| `sapi-file` | renderer-selected | yes | System.Speech over a 16kHz WAV |
| `sapi-device` | system default | no | System.Speech live; cannot select a device |

whisper.cpp follows the same optional-external pattern as Piper: absent by default, probed in the background after the window is up rather than awaited on the startup path, and probed per device capability rather than trusted. Selecting `whisper` explicitly reports that the binary is missing instead of silently falling back, because a user who chose a specific engine should be told when they did not get it.

Known limits of that tier, stated plainly rather than implied:

- The model file is reused across calls from disk, but the CLI reloads the model per invocation. This is not an in-memory model cache. A persistent `whisper-server` process would be, at the cost of a resident process.
- GPU use depends on a build with CUDA support, and a CUDA build must actually target the host's compute capability. On Blackwell (`sm_120`) an older prebuilt binary will fail or fall back to CPU; this cannot be detected from a version string and must be confirmed by running it.
- Nothing about this tier is validated on the development machine, because no whisper.cpp binary or model is installed there.

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
3. **Data/voice** — config, storage, TTS routing, voice-pack provenance, and the
   desktop tool registration/confirmation/enum contract.
4. **Live renderer** — shell behaviour, WebGL state and square camera projection.
5. **Island** — the opt-in window boots, mirrors state, issues actions, and
   renders its own GLY mark with a paused hidden state
   (`npm run check:island`, 52 checks against a live `--dev` instance).
6. **Package** — real unpacked build and installed resource layout.
7. **Optional live AI** — real Gemini streamed turn with `LEGION_LIVE_AI=1` and `GEMINI_API_KEY`.

The default suite stays offline unless a live check is explicitly enabled.

`check:voice` synthesises speech with the machine's own voice, writes it as a WAV, and pushes it back through the production path — resampler, VAD, endpointing, recogniser — so the words that come out are compared with the words that went in. It verifies the pipeline by recognition rather than by asserting that a function was called.

The pipeline's weakest claims cannot be reached that way and are pinned on source instead: they concern device arbitration between the wake listener, a capture and the synthesiser, which needs a real microphone and a real second engine on one device. Assertions on structure are a weak substitute, and are labelled as such.

## 12. Data on disk

Electron user data contains configuration, secrets, memory and metrics. Development data is isolated from normal user data. Project-root voicepack/ and build-time assets/piper/ are repository resources, not user secrets.

`userData/secrets.json` currently stores provider keys as plain text. It is
git-ignored and never exposed to the renderer (`ai:status` reports presence, not
values), but it is not encrypted at rest. OS-backed secret storage (Credential
Manager / DPAPI) is tracked as hardening work, not implemented.

`desktop_screenshot` writes full-screen PNGs to
`os.tmpdir()/legion-screens/`, outside the repository and app data. The path is
returned to the model as tool output; the files are not cleaned up automatically.
