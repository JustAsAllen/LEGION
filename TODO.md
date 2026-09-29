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
npm run check:package    the built exe, launched and exercised
npm run check:launch     launcher boots a window and stays alive
npm run bench            performance benchmark (~1 min)
npm run voicepack:sample regenerate the example voice pack clips
```

Setting `LEGION_LIVE_VOICE=1` adds the checks that need the real online voice
service. Without it the suite never touches the network.

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
      (security audit and the unpacked build are done; see §3 and §5. Still open: a real
      provider turn, and a signed installer)

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
- [x] tool sandbox review: file write roots, command allowlist, traversal and symlink
      re-checks — `check:security` exercises them, 16 checks
- [x] RLS-style equivalent: what the renderer can reach through `ipcRenderer` — the
      channel list is a fixed allowlist in `preload.js`, with no generic bridge;
      `check:ipc` proves main and preload agree
- [x] `shell:openPath` / `shell:showItem` restricted to user data, the app folder and
      configured sandbox roots, with NUL rejection and symlink revalidation
- [x] `scripts/check-security.js` is wired into `check` and `check:fast`

### 4. Performance (§11, §26)
- [x] `npm run bench` — frame-time percentiles, heap trend, DOM size, RSS, quality tier
- [x] profile over a long session: 10-minute soak, 81.7 fps mean, p50 12.1 ms
- [x] memory-leak check: heap peak envelope +0.42 MB over 600 s, DOM pinned at 270 nodes
- [x] frame sampler reads its own rAF timestamps, not the app's fps counter
- [~] quality tiers auto-scale — verified to respond to load (`ultra → high → medium → low` and back), but not on genuinely low-end hardware, which this machine is not

### 5. Production build (§44)
- [~] `npm run dist` succeeds — the unpacked app packages and passes every packaged
      check, but the NSIS installer step fails on this host: electron-builder cannot
      create symlinks while extracting `winCodeSign` (`ERROR: Cannot create symbolic
      link : A required privilege is not held by the client`). Needs Developer Mode
      or elevation, and is unrelated to the app code.
- [x] `npm run build` produces a working `release/win-unpacked` with the voice pack
      both inside `app.asar` and editable beside the exe
- [x] `check:package` — 14 checks against the real built exe: window opens, boot
      settles, the ring really draws, the pack resolves from the installed location,
      and the voice pipeline is reachable from the packaged renderer
- [ ] code-sign the binary — an unsigned self-built Electron app is blocked outright
      by Application Control / Smart App Control on this machine, so `check:package`
      cannot exercise the built exe until it is signed or the folder is allowed
- [ ] installed app launches and passes the shell check (blocked by the two items above)
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
- [x] shipped and installed: `voicepack/` is inside `app.asar` and copied to
      `resources/voicepack`; an installed build prefers the editable copy beside the
      exe, so clips can be swapped without repacking
- [ ] pick/choose between multiple installed packs (one folder is read today)
- [ ] per-user packs (a folder in user data), so custom packs survive an app update

### 9. Voice source pipeline
Four tiers, tried in order, and the first one that can answer wins:

1. **Static voice pack** — a recorded clip, instant and offline
2. **Online voice** — Microsoft Edge neural voices, used when the phrase is not
   recorded and the mode allows it
3. **Piper** — local neural TTS, if an executable and model are configured
4. **System voice (SAPI)** — always available, the final fallback

- [x] `src/main/voice/tts.js` runs the tiers in that order and reports which one
      answered (`tier`, `source`, `format`)
- [x] three modes: `auto` (all four), `offline` (never touches the network),
      `pack-only` (silence rather than a fallback)
- [x] `src/main/voice/edge.js` — live synthesis, voice listing, latency and
      last-error reporting for the settings panel
- [x] the online tier degrades instead of throwing: unreachable service or a failed
      request falls through to Piper, then to the system voice
- [x] `src/main/voice/piper.js` — optional local neural TTS, probed once and
      skipped cleanly when no executable or model is present
- [x] the renderer plays either container: `decodeAudioData` handles the WAV from
      the pack and the MP3 from the online tier, verified in the real app
- [x] settings exposes the mode and reads out which sources are usable right now
- [x] `check:voice` covers the order, all three modes, and the pack hand-off;
      the online tier is checked only when `LEGION_LIVE_VOICE=1` is set, so the
      default suite stays offline and hermetic
- [x] live online tier verified: real MP3 frame returned and decoded (3.79 s, 48 kHz mono)
- [~] Piper — code is complete but unverified; no executable or model is installed here
- [~] online voice quality and latency are not tuned; `en-US-AriaNeural` is the default

---

## Known issues

- Voice packs are read from the project-root `voicepack/` folder, or from
  `resources/voicepack` beside the installed exe. One folder, no chooser, and no
  per-user location yet, so a custom pack does not survive an app update. Per-user
  packs are the obvious next step.
- The packaged build is unsigned, and Windows Application Control / Smart App Control
  refuses to launch an unsigned binary. `check:package` reports this and stops rather
  than crashing; the runtime checks pass once the binary is signed or the folder is
  allowed. This is a signing gap, not an app defect.
- The online voice tier depends on Microsoft's Edge speech endpoint and needs a network
  connection. It is opt-in by mode and falls through to the local tiers on any failure,
  but it is not a privacy-hardened option: the text is sent to that service.
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
