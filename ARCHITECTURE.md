# LEGION — architecture

What the process boundaries are, what talks to what, and why. For installation
and usage see `README.md`; for how to contribute see `CONTRIBUTING.md`.

## The two-process split

LEGION is an Electron app with a strict boundary:

```
  renderer  (src/renderer)          main  (src/main)
  ───────────────────────────        ──────────────────────────────
  ES modules, no Node                CommonJS, full Node
  DOM, WebGL, Web Audio              filesystem, network, OS APIs
  no secrets, ever                   the only place keys exist
  window.legion                      window.legionApp
        │                                   ▲
        └──────── preload (contextBridge) ─────┘
                    one named channel per action
```

The renderer never touches `fs`, `child_process`, or `net`. It asks, and the
main process decides whether to do it. That is what keeps a bad tool result or
a prompt-injected instruction from becoming arbitrary code execution in the
renderer, and it is why `scripts/static-check.js` and `scripts/scope-analyzer.js`
are part of `npm run check` rather than optional lint.

`preload.js` is the only bridge. It exposes a fixed list of channel names, and
each one maps to exactly one handler in `main.js`. The scope analyzer fails the
build if a channel is handled without a sender, sent without a handler, or
missing from the allowlist — so a new capability cannot be wired up halfway.

## Main process

`main.js` (25 KB) is the spine: it creates the window, owns the state machine,
and registers the 44 IPC handlers. The rest are focused modules it calls into.

| Module | Responsibility |
|---|---|
| `main.js` | window, state machine, all IPC handlers, global shortcuts |
| `config.js` | validated, merged config persisted as JSON |
| `secrets.js` | API keys, read only in main, never sent to the renderer |
| `memory.js` | short-term, session and optional long-term memory |
| `ai/engine.js` | provider-independent conversation turn |
| `ai/providers.js` | Anthropic, OpenAI, Ollama adapters |
| `ai/personality.js` | how replies are phrased |
| `voice/tts.js` | the synthesis pipeline, and which tier answered |
| `voice/voicepack.js` | resolve a phrase to a prerecorded clip |
| `voice/edge.js` | online neural voices, with availability and last-error state |
| `voice/piper.js` | local neural TTS, bundled-resource discovery plus configurable fallback |
| `voice/stt.js` | Windows speech recognition |
| `voice/wake.js` | continuous listening and the wake word |
| `tools/registry.js` | the tool table the model is shown |
| `tools/sandbox.js` | write roots and the command allowlist |
| `tools/*.js` | 36 tools, grouped by area |
| `system/metrics.js` | real CPU/memory numbers for the status bar |

### Live AI turn

The renderer submits text through `ai:chat`. The main process owns the provider call and emits provider text deltas over the existing `ai:event` channel; no network client or secret crosses into the renderer. Ollama uses its newline-delimited streaming response when the engine supplies a delta callback. When the turn completes, the renderer sends the final accumulated reply through the existing hybrid TTS pipeline, so the same voice-pack → online neural → Piper → SAPI ordering applies to live AI responses.

### The state machine

Eight states, in `main.js`, and every transition is explicit:

```
OFFLINE → BOOTING → IDLE ⇄ LISTENING → PROCESSING → SPEAKING → IDLE
                                    ↓            ↓          ↓
                                   ALERT  ←──────┘        ERROR
```

`setState()` is the only way to change state, and the renderer reflects it
rather than driving it. `SPEAKING` is released by the renderer reporting
`voice:speechEnd`, because main cannot see when audio playback finishes.

### Voice output

`tts.synthesize()` tries four sources in order and stops at the first that can
answer. The result carries which one it was (`tier`, `source`, `format`), so the
UI can say "this sentence was prerecorded" instead of guessing.

1. **Static voice pack** — a recorded clip. Instant, offline, and always first.
2. **Online voice** (`voice/edge.js`) — Microsoft Edge neural voices, when the
   phrase is not recorded and the mode allows the network. Returns MP3.
3. **Piper** (`voice/piper.js`) — local neural TTS. Development builds discover `assets/piper`; packaged builds discover the unpacked `resources/piper` directory. It is used when `piper.exe` and an `.onnx` voice model are present.
4. **System voice (SAPI)** — the final fallback. Returns WAV.

Two rules make this predictable. A tier that fails returns `null` instead of
throwing, so an offline machine or a dead service degrades one step rather than
breaking speech. And `pack-only` means *only*: an unrecorded phrase is silent,
because silently substituting a different voice would break the promise.

The mode (`voice.ttsMode`) decides how far down the list the pipeline may go:
`auto` uses all four, `offline` skips the network entirely, `pack-only` stops at
the first. The renderer plays whatever container comes back — `decodeAudioData`
handles the pack's WAV and the online tier's MP3 without a format branch.

### Secrets

Enforced in `secrets.js`, not by convention: keys are read in main only, never
cross IPC, and the renderer can ask *whether* a key exists but never *what* it
is. A key can come from an env var or a `0600` file in `userData/secrets.json`.

## Renderer

ES modules, loaded by `index.html`. No bundler, no build step, no `type:
module` in `package.json` — that would break the CommonJS entry points.

| Module | Responsibility |
|---|---|
| `js/app.js` (45 KB) | wiring: store, audio, stage, panels, keyboard |
| `js/panels.js` (36 KB) | the settings, memory and tools panels |
| `js/audio.js` | mic capture, TTS playback, one analyser per source |
| `js/firstrun.js` | the five-step onboarding wizard |
| `js/state.js` | tiny observable store |
| `js/waveform.js` | live waveform from the analyser |
| `visuals/stage.js` | the WebGL stage, the mark, adaptive quality |
| `visuals/logo-model.js` | the segmented ring, sampled procedurally |
| `visuals/particle-field.js` | the instance field |
| `visuals/sampler.worker.js` | arc sampling off the main thread |

### Audio

`audio.js` routes microphone and speech through **separate analysers**. That
matters: it means the waveform and the state machine are driven by real
amplitude from the mic and from the reply, not by a timer.

Speech playback is: main synthesises to a WAV or hands back a pack clip, base64
to the renderer, `decodeAudioData`, then the same analyser the mic uses. So the
`SPEAKING` state is backed by genuine audio.

### The mark and adaptive quality

`logo-model.js` generates the three-arc ring procedurally and `sampler.worker.js`
samples arc points off the main thread, so a quality change never stalls a frame.

`stage.js` owns an adaptive quality policy. The user's chosen tier is a
**ceiling**: adaptive mode may drop below it when frames get slow, but it never
climbs past what was explicitly asked for. It reacts to a one-second fps average
and requires four consecutive good windows before climbing, so it settles instead
of oscillating. Measured behaviour under load: `ultra → high → medium → low`,
and back to `ultra` once the frames recovered.

## Data flow, end to end

```
 wake word ─┐
 push-to-talk┼→ stt.listen → text ─→ ai.engine ─→ provider ─→ reply ─→ tts/voicepack
             │                                 │                        │
             │                                 ├→ tools:invoke          ↓
             │                                 │     └→ sandbox ─→ fs/net
             │                                 │                        │
             │                                 └→ memory:remember        ↓
             │                                                          audio.js
             ↓                                                            │
      setState(ALERT) ───────────────────────────────────────────→ analyser
```

## Data on disk

Everything lives under Electron's `userData`, so it survives upgrades and is
removed with the app. `--dev` puts it in a `dev/` subfolder, so development
never touches real user data.

| Path | What |
|---|---|
| `config.json` | settings |
| `secrets.json` | API keys, `0600` |
| `memory/` | session and long-term memory |
| `metrics.json` | the numbers the status bar shows |
| `../voicepack/` | prerecorded clips, in the project root |

## What is deliberately not here

- **No bundler.** `electron-builder` handles the app; the renderer is served as
  ES modules. A build step on the renderer would only hide what the browser
  already loads.
- **No framework.** Vanilla DOM and WebGL2. The dependency list is short enough
  to read.
- **No renderer-side secrets, ever.** If a future feature seems to need one,
  the design is wrong.
