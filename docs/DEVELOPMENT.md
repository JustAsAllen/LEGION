# Development Guide

## Runtime boundaries

Renderer code is ES modules under `src/renderer/`. Main and preload code are CommonJS. Do not add `"type": "module"` to `package.json`.

The renderer owns presentation, WebGL, Web Audio, and local UI state. The main process owns secrets, provider requests, tools, filesystem access, OS integration, memory, and voice orchestration. New privileged behavior must remain behind an explicit preload channel.

## Useful commands

```powershell
npm install
npm run dev
npm run check:fast
npm run check
npm run build
npm run check:package
npm run bench
```

`npm run check` uses real Electron and Windows services where applicable. `check:simvoice` and the development mock provider exercise the pipeline without claiming real microphone or provider behavior.

## Adding IPC

1. Add the main handler in `src/main/main.js`.
2. Add the channel to the preload invoke/send or event allowlist.
3. Expose a narrow method in `src/preload/preload.js`.
4. Add renderer usage through the existing API object.
5. Run `npm run check:ipc`, `npm run check:static`, and the focused behavior check.

Do not expose a generic `invoke`, `ipcRenderer`, Node primitive, or secret value.

## Adding a tool

Register it in the appropriate `src/main/tools/*.js` module with a unique name, description, schema, category, risk, handler, and confirmation predicate where required. Use the provided sandbox and `ctx.run`; never accept an unrestricted shell string. Add a check to `scripts/check-data.js` when behavior is new.

## Documentation and release hygiene

Do not commit `node_modules`, `release`, `artifacts`, local settings, secrets, or environment files. Build and screenshot output is ignored. Optional Piper binaries/models are not included unless redistribution is allowed.

On Windows, electron-builder may be blocked by symlink or unsigned-binary policy. Follow the existing release notes in [`CONTRIBUTING.md`](../CONTRIBUTING.md) and report whether runtime packaging was actually verified.
