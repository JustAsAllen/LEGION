# Voice packs

Drop prerecorded clips in this folder and LEGION will play them instead of
synthesising those exact phrases. Anything it has no clip for is spoken by the
normal Windows SAPI engine as before.

## The shipped pack

`manifest.json` plus six clips synthesised with the same SAPI engine the app
falls back to, so a pack clip and a synthesised reply are the same kind of audio
in the same 24 kHz mono format. They exist as working examples, not as samples of
a particular voice. Regenerate them with:

```bash
npm run voicepack:sample
```

To use your own voice, overwrite the `.wav` files and edit the phrases in
`manifest.json`. Nothing in the app needs to change.

## Adding a clip

1. Record the phrase. `.wav` and `.mp3` both work; Chromium decodes either.
2. Name it anything, and add it to `manifest.json`:

```json
{ "phrase": "On it.", "file": "on-it.mp3" }
```

`phrase` is matched after normalisation: case, surrounding whitespace and
punctuation are ignored, so `"On it."`, `"on it"` and `"  ON IT! "` all hit the
same clip. Match it exactly as the app would say it, though — the leading
capital does not matter but the *words* do.

A file named after the phrase needs no manifest entry: `on-it.wav` or
`on-it.mp3` in this folder is found automatically. The manifest is the way to
map a phrase to an awkwardly named file, or to list what is available.

## Why matching is exact

There is deliberately no wildcard or catch-all entry. A catch-all would play one
clip for text that does not match it, so the mark would appear to say something
the app never said. A miss is not an error; it just means SAPI speaks that line.

## Notes

- Set `"enabled": false` in the manifest to ignore the whole pack without
  deleting it.
- A manifest entry whose file is missing, empty, or not real audio is skipped,
  and the phrase falls through to SAPI.
- Paths are resolved inside this folder. An entry like `../secrets.wav` is
  rejected.
- Edit the manifest while the app is running: the pack reloads when the file
  changes, no restart needed.
- `npm run check:voicepack` verifies the pack resolves, still falls through to
  SAPI for a miss, and refuses to read outside this folder.

Phrases worth clipping are the fixed ones the app reuses — greetings, "I didn't
understand that", confirmations. Clips of open-ended answers would need the
phrase to match exactly, which defeats the purpose.
