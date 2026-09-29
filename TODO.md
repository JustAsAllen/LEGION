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
- [x] OpenAI/Anthropic/Ollama provider adapters
- [x] Ollama NDJSON streaming through the existing ai:event channel
- [x] Automatic local Ollama detection when no provider is configured
- [x] Renderer live streaming state connected to provider deltas
- [x] Final AI reply routed through the existing hybrid TTS path
- [x] Tool catalogue, confirmation gate and sandbox policy
- [x] Memory, config, metrics and secret handling
- [x] Procedural three-arc ring and off-main-thread sampler
- [x] Square WebGL mark projection for widescreen layouts
- [x] Render check asserting the live camera remains 1:1
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
- [~] Live Ollama turn — source path and opt-in check are implemented; requires Ollama + a local model
- [~] Piper runtime — source path and packaging are implemented; requires a compatible piper.exe + ONNX model
- [~] NSIS installer runtime verification — Windows signing/policy can block execution of unsigned self-built artifacts
- [~] Code signing — requires a release certificate and signing environment

## Remaining product work

### Accessibility

- [ ] Reduced-motion mode
- [ ] Keyboard-only navigation of every panel
- [ ] Adjustable visual intensity

### Startup

- [ ] Launch-at-startup toggle
- [ ] Explicit microphone opt-in guard at startup

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
    npm run build
    npm run check:package
    npm run dist
    npm run bench

For live Ollama verification:

    LEGION_LIVE_AI=1
    LEGION_OLLAMA_MODEL=<installed-model>
    npm run check:ai
