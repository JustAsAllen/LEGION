# Voice System

## End-to-end flow

```text
user speaks
  -> renderer getUserMedia and audio tap
  -> main-process VAD and resampling
  -> Whisper or Windows System.Speech
  -> normal AI conversation turn
  -> streamed response
  -> TTS synthesis
  -> renderer Web Audio playback
```

Microphone activation is explicit unless the user enables the opt-in launch setting. Permission, empty input, device, language, and recognizer failures are surfaced with typed errors or visible status.

## Recognition

`voice:capture*` carries renderer audio frames to main. The capture path preserves echo cancellation, noise suppression, automatic gain control, mono input, VAD segmentation, and 16 kHz WAV conversion. Recognition modes are `auto`, `whisper`, and `sapi`; `auto` uses Whisper when available and otherwise captured-audio System.Speech.

The optional wake listener uses the Windows default input and yields the device while a capture or synthesis is active. Continuous mode is opt-in and re-arms after silence and speech output.

## Speech output

The TTS order is:

1. Exact voice-pack clip from `voicepack/`.
2. Edge neural online voice in `auto` mode.
3. Optional Piper executable and ONNX model.
4. Windows SAPI fallback.

`offline` skips the network; `pack-only` returns silence when no exact clip exists. Renderer playback is interruptible and uses one active audio source, analyser, and cleanup path.

## Configuration

Settings control voice name, rate, volume, mute, source mode, continuous listening, wake phrase, STT engine, Whisper paths/model/language, silence threshold, and maximum capture duration. See `src/main/config.js` for defaults.

## Verification

```powershell
npm run check:voice
npm run check:voicepack
npm run check:simvoice
```

The voice checks distinguish real Windows SAPI/device behavior from development-only simulated voice.
