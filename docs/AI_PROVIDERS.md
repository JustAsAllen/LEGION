# AI Providers

## Provider contract

`src/main/ai/providers.js` normalizes Gemini, OpenAI, and Anthropic behind:

```text
chat({ system, messages, tools, temperature, maxTokens, signal, onDelta })
  -> { text, toolCalls, usage, model }
```

The engine owns context construction, bounded retries, cancellation, tool rounds, memory, and response events. Providers own URL/auth/body translation and streaming parsing.

## Supported providers

| Provider | Default model | Credential |
|---|---|---|
| Gemini | `gemini-3.5-flash` | `GEMINI_API_KEY` |
| OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` |
| Anthropic | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |

Models and supported OpenAI-compatible base URL settings are configured through the existing AI settings. Gemini may also read `GEMINI_MODEL` for the default model when no explicit model is saved.

## Credentials

Keys are read only in main from environment variables or Electron `userData/secrets.json`. Renderer APIs expose only configured/source status. Never log, serialize, or include a key in a tool result or UI event.

## Streaming and errors

All three cloud adapters stream when `onDelta` is supplied. Time-to-first-byte and idle-stream deadlines are separate. Pre-delta transient failures use bounded retries; once visible text is emitted, the request is not replayed. Cancellation aborts the provider request and active tool execution.

Stable error codes include `E_AI_AUTH`, `E_AI_RATE_LIMIT`, `E_AI_HTTP`, `E_AI_TIMEOUT`, `E_AI_STREAM`, `E_AI_MALFORMED`, `E_AI_CONN`, `E_NO_KEY`, `E_NO_PROVIDER`, and `E_ABORTED`.

## Validation

```powershell
$env:LEGION_LIVE_AI = '1'
$env:GEMINI_API_KEY = '<key>'
npm run check:ai
```

The live section is opt-in. Without credentials it must not be described as a live connectivity result.
