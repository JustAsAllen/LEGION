# LEGION — TODO

Status legend: [x] complete and verified · [~] implemented but environment-dependent/unverified · [ ] not implemented.

The automated check suite is the source of truth for repeatable verification.

## Completed production surface

- [x] Electron main/renderer security boundary and explicit preload bridge
- [x] Real IPC channel registration and reachability checks
- [x] Five-theme visual configuration and live shader propagation
- [x] Push-to-talk, continuous STT and wake-word flow
- [x] Four-tier TTS: voice pack → Edge neural → Piper → SAPI
- [x] Voice-pack manifest, exact phrase matching, traversal guard and settings integration
- [x] Piper runtime discovery in development and packaged-resource discovery in production
- [x] Provider-independent AI engine
- [x] Gemini/OpenAI/Anthropic provider adapters
- [x] Gemini SSE streaming through the existing ai:event channel
- [x] Explicit provider selection with typed missing-key and no-provider errors
- [x] Renderer live streaming state connected to provider deltas
- [x] Final AI reply routed through the existing hybrid TTS path
- [x] Tool catalogue, confirmation gate and sandbox policy
- [x] Desktop agent tools: window list/focus/close, clipboard, screenshot, media keys, notification, session lock
- [x] Bounded provider retry (pre-delta, honours retry-after) and native tool transcripts per adapter
- [x] Opt-in Dynamic Island as a separate always-on-top window, with its own checks
- [x] Memory, config, metrics and secret handling
- [x] Procedural three-arc ring and off-main-thread sampler
- [x] Square WebGL mark projection for widescreen layouts
- [x] Render check asserting the live camera remains 1:1
- [x] Reduced-motion mode, launch-at-startup toggle and explicit microphone opt-in
- [x] Launcher checks and background-throttling fix
- [x] Static/scope/IPC/security/data/voice/render/shell verification suite
- [x] Packaged-build verification with host-policy-aware unsigned executable handling
- [x] electron-builder configuration for NSIS + portable targets
- [x] README, architecture documentation and contribution guidance
- [x] Source/build/secrets gitignore hygiene

## Release verification

- [x] npm run build configuration produces the unpacked Windows target when the host permits Electron packaging
- [x] Voice pack is included in the app and copied to editable resources/voicepack
- [x] Piper resource directory is configured for packaged builds
- [x] check:package statically validates package contents and can skip only an OS-level unsigned-binary launch block when explicitly requested
- [x] Live Gemini turn — streaming verified against `gemini-3.5-flash` with a real key
- [~] Piper runtime — source path and packaging are implemented; requires a compatible piper.exe + ONNX model
- [~] NSIS installer runtime verification — Windows signing/policy can block execution of unsigned self-built artifacts
- [~] Code signing — requires a release certificate and signing environment

## Remaining product work

### Accessibility

- [x] Reduced-motion mode
- [ ] Keyboard-only navigation of every panel
- [ ] Adjustable visual intensity (`visual.themeIntensity` exists; no control)

### Startup

- [x] Launch-at-startup toggle
- [x] Explicit microphone opt-in guard at startup

### Hardening

- [ ] Encrypt provider secrets at rest (currently plain text in `userData/secrets.json`)
- [ ] Verify live Claude/OpenAI model IDs (Gemini `gemini-3.5-flash` verified live)
- [ ] Allow the desktop screenshot folder to be cleaned up or configured

### Voice packs

- [ ] Multiple installed pack chooser
- [ ] Per-user voice-pack location that survives application updates

### Voice quality

- [ ] Tune online voice selection/latency beyond the current default
- [ ] Verify Piper audio quality/latency on a supported Windows runtime

## Release notes

The repository is intentionally self-contained at source level. Optional Piper binaries/models are not fabricated into Git without compatible redistribution rights. Build outputs and local secrets remain ignored.

## Useful commands

    npm install
    npm run check
    npm run check:fast
    npm run check:render
    npm run check:island
    npm run build
    npm run check:package
    npm run dist
    npm run bench

For live Gemini verification:

    LEGION_LIVE_AI=1
    GEMINI_API_KEY=<your-key>
    GEMINI_MODEL=gemini-3.5-flash
    npm run check:ai
