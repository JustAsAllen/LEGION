# Security Model

## Electron boundary

Windows are created with context isolation, sandboxing, web security, and Node integration disabled. The preload bridge exposes only named operations and event subscriptions. Renderer code cannot import `fs`, `child_process`, secrets, or provider clients.

## Secrets

Provider values are read in main from environment variables or `userData/secrets.json`. The renderer receives only configured/source metadata. Local storage is currently a protected plain JSON file; encryption at rest remains tracked in `TODO.md`.

## Tools

Tools are registered with schemas, categories, risk levels, handlers, and optional confirmation plans. Arguments are validated before execution. Unknown arguments are rejected. Tool calls are audited with redacted arguments and structured success/error results.

Read-only actions are separated from write, destructive, and system actions. Sensitive actions require an explicit UI confirmation when `tools.requireConfirmation` is enabled. Pending confirmations expire and cancellation propagates to active handlers.

## Files and processes

File tools resolve through `PathSandbox`, configured roots, traversal checks, and symlink containment checks. Application launching uses a curated registry. Developer tools are disabled by default. No AI-generated unrestricted shell command is accepted.

## URLs and external access

External URLs are restricted to `http` and `https`. Provider connections remain in main. Online TTS is selected only by the configured voice mode.

## Verification

```powershell
npm run check:security
npm run check:ipc
npm run check:data
```

Report whether a check used a real provider, real microphone, or a development mock. Never include API keys, local secrets, or personal data in logs or bug reports.
