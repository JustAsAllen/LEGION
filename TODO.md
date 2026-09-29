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

---

## Next

### 1. Documentation (from the build prompt, §43)
- [x] `README.md` — what it is, features, requirements, install, running, building, the check suite, themes
- [x] `assets/logo.svg` — segmented-ring mark, geometry matching `logo-model.js`
- [ ] `ARCHITECTURE.md` — components, data flow, AI/voice/visual pipelines, state machine, tool system, memory
- [ ] `.env.example` — every supported env var, no real values
- [ ] `CONTRIBUTING.md` — the check suite, conventions, how to add a tool / provider / state

### 2. AI engine (§17, §6)
- [x] provider-independent engine, conversation manager
- [ ] verify an end-to-end live AI turn against a real provider (API key + network required)
- [ ] local LLM provider (optional, §39)

### 3. Security audit (§30, §10)
- [ ] confirm no secret reaches the renderer (trace `config` through IPC)
- [ ] tool sandbox review: file write roots, command allowlist
- [ ] RLS-style equivalent: what the renderer can reach through `ipcRenderer`

### 4. Performance (§11, §26)
- [ ] profile CPU/GPU/RAM over a long session
- [ ] memory-leak check over a long session
- [ ] verify quality tiers auto-scale on a low-end machine

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

### 8. Custom voice packs (not started — no prior work exists)
- [ ] decide a pack format (SAPI voice, .wav, both?)
- [ ] import/install flow and a place on disk
- [ ] a check that the active pack is the one that was selected
- [ ] decide whether packs are per-user or shipped with the app

---

## Known issues

- There is no `voicepack/` directory and no custom-voice-pack pipeline. Audio is
  SAPI (Windows) only; there is nothing to import, and `TODO.md`, `README.md`
  and `package.json` never referenced one. If a pack format is wanted it has to
  be designed first, not verified.
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
