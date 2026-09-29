# LEGION bundled Piper runtime

Place the Windows Piper CLI and one compatible ONNX voice model in this folder.

Expected layout:

- `piper.exe`
- `<voice-name>.onnx`

LEGION discovers this directory automatically in development and from
`resources/piper` in packaged Windows builds. The settings panel reports the
detected model as **Piper ready**.

Do not commit a model or executable unless its redistribution terms are
compatible with this repository. The current Piper integration accepts a local
user-supplied runtime/model as well as a bundled pair.

Piper is used as the offline neural tier after the voice pack and online neural
voice, and before Windows SAPI.
