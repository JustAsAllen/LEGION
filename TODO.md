# LEGION — TODO

Status legend: `[x]` done and verified · `[~]` partially done · `[ ]` not started

The truth source for "does it work" is the check suite (`npm run check`).
Anything marked done below has a corresponding passing check.

---

## How to run

```
Launch LEGION.vbs        double-click, silent (recommended)
Launch LEGION.bat        double-click, with a console
npm start                from a terminal
npm run check            full check suite (~3 min)
npm run check:fast       selftest + static + ipc (~5 s)
npm run check:launch     launcher boots a window and stays alive
npm run bench            performance benchmark (~1 min)
npm run voicepack:sample regenerate the example voice pack clips
```

First run only: `npm install`.

---

## Done and verified

- [x] **Interface shell** — title bar, centre, rail, status bar, panels, z-order, drag region
- [x] **Theme** — 5 themes reach the shader and the CSS; warning colours stay fixed
- [x] **Voice pipeline** — SAPI TTS, Windows STT, push-to-talk, continuous mode, wake word, redaction
- [x] **Settings** — voice, memory, tools, privacy, visual quality, wake word all real (no dead toggles)
- [x] **First-run wizard** — 5 steps, provider probe, bypass path, handover runs exactly once
- [x] **Tools** — 36 tools across system/apps/files/web/dev/productivity, confirmation gate
- [x] **Memory** — short-term, session, optional long-term, view/forget controls
- [x] **Data layer** — config, metrics, secrets; real values only
- [x] **Render loop** — WebGL live, 60+ fps, adaptive quality, no GL errors
- [x] **Logo** — three-arc segmented ring, procedurally sampled, verified geometry (empty gap sectors)
- [x] **Launchers** — `.vbs` and `.bat` boot a titled window; `check:launch` measures
      time to window and proves the render loop is alive and not spinning
- [x] **Batch 4** — `backgroundThrottling: false`, so the mark animates while unfocused;
      three flaky shell checks made to poll for settle instead of sampling once
- [x] **Voice packs** — `voicepack/` with a working example pack, clip lookup ahead of
      SAPI, a settings surface, and 12 checks
- [x] **Batch 5** — `npm run bench`; 10-minute soak measured, no leak, 81.7 fps
- [x] **Batch 6** — `ARCHITECTURE.md`, `CONTRIBUTING.md`, `.env.example`, README sections
- [ ] **Batch 7 (next)** — security audit, a live AI turn against a real provider, dist build

---

## Next

### 1. Documentation (from the build prompt, §43)
- [x] `README.md` — what it is, features, requirements, install, running, building, the check suite, voice packs, measured performance, themes
- [x] `assets/logo.svg` — segmented-ring mark, geometry matching `logo-model.js`
- [x] `ARCHITECTURE.md` — process split, 44 IPC channels, state machine, AI/voice/visual pipelines, tool system, memory, data flow
- [x] `.env.example` — the two real API keys, no values, states that the app needs none
- [x] `CONTRIBUTING.md` — the check suite, conventions, how to add a tool / channel / state, how to read the bench

### 2. AI engine (§17, §6)
- [x] provider-independent engine, conversation manager
- [ ] verify an end-to-end live AI turn against a real provider (API key + network required)
- [ ] local LLM provider (optional, §39)

### 3. Security audit (§30, §10)
- [x] secrets are read in main only and never returned over IPC (`secrets.js`; the
      renderer can ask whether a key exists, never its value)
- [ ] tool sandbox review: file write roots, command allowlist — read, not yet audited
- [ ] RLS-style equivalent: what the renderer can reach through `ipcRenderer`

### 4. Performance (§11, §26)
- [x] `npm run bench` — frame-time percentiles, heap trend, DOM size, RSS, quality tier
- [x] profile over a long session: 10-minute soak, 81.7 fps mean, p50 12.1 ms
- [x] memory-leak check: heap peak envelope +0.42 MB over 600 s, DOM pinned at 270 nodes
- [x] frame sampler reads its own rAF timestamps, not the app's fps counter
- [~] quality tiers auto-scale — verified to respond to load (`ultra → high → medium → low` and back), but not on genuinely low-end hardware, which this machine is not

### 5. Production build (§44)
- [ ] `npm run dist` succeeds
- [ ] installed app launches and passes the shell check
- [ ] NSIS + portable targets both build

### 6. Accessibility (§36)
- [ ] reduced-motion mode
- [ ] keyboard-only navigation of every panel
- [ ] adjustable visual intensity

### 7. Startup behaviour (§38)
- [ ] launch-at-startup toggle
- [ ] never open the mic without explicit opt-in

### 8. Custom voice packs
- [x] pack format chosen: `.wav`/`.mp3` clips + a `manifest.json` mapping phrase to file
- [x] `src/main/voice/voicepack.js` — resolve a phrase to a clip, with normalisation and traversal guard
- [x] consulted before SAPI in `tts.synthesize()`; a pack hit works on any platform, not just Windows
- [x] `voicepack/` with a working example pack (6 real SAPI clips) and `npm run voicepack:sample` to regenerate
- [x] reloads on manifest change, no restart; `voice:pack` IPC for the settings view
- [x] settings panel shows the active pack, its phrase count, and any manifest problems
- [x] "Test voice pack" plays a phrase the pack actually has and reports clip vs SAPI
- [x] `check:voicepack` — 12 checks: hit, miss, fall-through, disabled, traversal, audio sniffing, provenance
- [ ] pick/choose between multiple installed packs (one folder is read today)
- [ ] decide whether packs are per-user or shipped with the app (currently project-root only)

---

## Known issues

- Voice packs are read from the project-root `voicepack/` folder only. One folder,
  no chooser, and a packaged build has to ship the folder beside the app for packs
  to be found. Per-user packs are the obvious next step.
- `npm run bench` disables Chromium's occlusion throttling so the numbers describe
  the app. A window left fully covered by another window will still drop to roughly
  1 rAF/second, and the app will drop to the lowest quality tier in response — which
  is the tier policy behaving correctly, not a fault.
- The `4` o'clock arc holds ~2000 more samples than the other two at the full
  16000-sample capacity (sampler overflow). The gaps are still empty, so it is
  a density imbalance, not a placement error. Low priority.
- The README screenshot (`assets/screenshot-idle.png`) is a capture, not a
  re-render, and has not been re-checked against the final ring.
- `backgroundThrottling: false` means the mark keeps animating when the window
  is not focused. That is deliberate — it is an always-on companion — but it
  does cost CPU while the window is in the background.

---

## Conventions

- Never add fake functionality. If a number is shown, it is measured.
- Renderer files are ES modules; main/preload stay CommonJS. Do **not** add
  `"type": "module"` to `package.json` — it breaks the CJS entry points.
- Checks run with `--experimental-vm-modules`; the npm scripts already do this.
- `three.module.js` is vendored — do not edit it, and static-check skips it.
- Commit style: `AREA: what changed`, uppercase area prefix.
