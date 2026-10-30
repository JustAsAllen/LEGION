#!/usr/bin/env python3
"""
context_watcher.py -- rebuild LEGION_CONTEXT.md on every change to this project.

Watches the project folder with watchdog and, on any create / modify / open /
close / move / delete, regenerates LEGION_CONTEXT.md from scratch: a directory
tree followed by the exact contents of every file, each in a fenced code block
under its project-relative path.

The output file is written whole every time. Nothing is read back, appended to,
or merged with an earlier run, and no pre-existing prompt file is consulted --
the document is a pure function of what is on disk at that instant.

Self-exclusion is the whole ballgame. The watcher must ignore, permanently and
without exception:

  * .git, node_modules, __pycache__, virtualenv folders, and editor/tool caches
  * release/, artifacts/ and the other build and test output folders
  * LEGION_CONTEXT.md itself

The last one is the loop that bites. The rebuild writes LEGION_CONTEXT.md,
which is a modification of a file inside the watched tree, which schedules
another rebuild, which writes the file again, forever. It is excluded at the
event filter *and* at the file scan, so no rebuild can be scheduled by it.

Usage:
    python context_watcher.py                 # watch this folder, rebuild forever
    python context_watcher.py --once          # one build, then exit
    python context_watcher.py --root <dir>    # watch somewhere else
"""

from __future__ import annotations

import argparse
import hashlib
import os
import signal
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError:
    sys.stderr.write(
        "context_watcher.py needs watchdog:\n    pip install watchdog\n"
    )
    raise SystemExit(2)


OUTPUT_NAME = "LEGION_CONTEXT.md"

# Directories excluded from the tree, from the embedded contents, and from the
# event stream that triggers a rebuild. node_modules and .git are large enough
# to turn a single save into tens of thousands of filesystem events; release/
# and artifacts/ hold hundreds of megabytes of build and screenshot output.
IGNORED_DIRS = frozenset(
    {
        # version control, dependencies, caches
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        ".cache",
        "htmlcov",
        "coverage",
        # virtual environments
        ".venv",
        "venv",
        "env",
        ".env-venv",
        "virtualenv",
        "site-packages",
        ".conda",
        # build and test output
        "release",
        "dist",
        "out",
        "win-unpacked",
        "artifacts",
        # editors
        ".idea",
        ".vscode",
    }
)

# Never embedded without a second thought, and flagged in the document header
# when present, because their whole purpose is to hold credentials.
SECRET_NAMES = frozenset({".env", "secrets.json", "settings.json"})
SECRET_SUFFIXES = (".secret", ".pem", ".key", ".pfx", ".p12")

LANGUAGES = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".json": "json",
    ".jsonc": "json",
    ".md": "markdown",
    ".html": "html",
    ".css": "css",
    ".py": "python",
    ".bat": "batch",
    ".vbs": "vbscript",
    ".ps1": "powershell",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "bash",
    ".xml": "xml",
    ".sql": "sql",
    ".txt": "text",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".example": "ini",
}

_DIR = object()
_FILE = object()
_SKIPPED = object()


# --------------------------------------------------------------------------
# filesystem scan
# --------------------------------------------------------------------------


def snapshot(root: Path, output_name: str):
    """Walk the tree once. Returns (included relative paths, excluded dirs)."""
    files: list[str] = []
    skipped: list[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == os.curdir:
            rel_dir = ""

        keep = []
        for name in dirnames:
            rel = os.path.join(rel_dir, name) if rel_dir else name
            if name in IGNORED_DIRS or is_output(rel, output_name):
                skipped.append(rel.replace(os.sep, "/"))
            else:
                keep.append(name)
        # Prune in place so os.walk never descends into an excluded folder.
        dirnames[:] = sorted(keep, key=str.lower)

        for name in filenames:
            rel = os.path.join(rel_dir, name) if rel_dir else name
            rel = rel.replace(os.sep, "/")
            if is_output(rel, output_name):
                continue
            files.append(rel)

    return sorted(files, key=str.lower), sorted(skipped, key=str.lower)


def is_output(rel: str, output_name: str) -> bool:
    """True for the generated file, including any temp sibling we might use."""
    base = rel.rsplit("/", 1)[-1]
    return base == output_name or base.startswith(f".{output_name}.")


def is_secret(rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1].lower()
    return base in SECRET_NAMES or base.endswith(SECRET_SUFFIXES)


def is_excluded_path(path: Path, root: Path, output_name: str) -> bool:
    """True if any component of the path is excluded. Mirrors snapshot()."""
    try:
        rel = os.path.relpath(str(path), str(root))
    except ValueError:
        return True
    if rel.startswith(os.pardir):
        return True
    parts = rel.replace(os.sep, "/").split("/")
    return any(part in IGNORED_DIRS for part in parts) or is_output(
        rel.replace(os.sep, "/"), output_name
    )


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def build_tree(files: list[str], skipped: list[str]):
    node: dict = {}
    for rel in skipped:
        parts = rel.split("/")
        cur = node
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = _SKIPPED
    for rel in files:
        parts = rel.split("/")
        cur = node
        for part in parts[:-1]:
            nxt = cur.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                cur[part] = nxt
            cur = nxt
        cur[parts[-1]] = _FILE
    return node


def render_tree(node: dict, root_name: str, lines: list[str], prefix: str = "") -> None:
    entries = sorted(
        node.items(),
        key=lambda kv: (kv[1] is _FILE, (kv[0] if kv[1] is not _FILE else kv[0]).lower()),
    )
    for index, (name, value) in enumerate(entries):
        last = index == len(entries) - 1
        branch = "└── " if last else "├── "
        if value is _SKIPPED:
            lines.append(f"{prefix}{branch}{name}/  (excluded)")
        elif value is _FILE:
            lines.append(f"{prefix}{branch}{name}")
        else:
            lines.append(f"{prefix}{branch}{name}/")
            render_tree(value, name, lines, prefix + ("    " if last else "│   "))


def looks_binary(data: bytes) -> bool:
    """Decide text vs binary from the bytes themselves, not the extension."""
    if b"\x00" in data[:8192]:
        return True
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    control = sum(
        1
        for ch in text[:8192]
        if ord(ch) < 32 and ch not in "\t\n\r\f\x1b\x0c"
    )
    return control > 0


def fence_for(content: str) -> str:
    """A fence longer than the longest backtick run inside the content."""
    longest = 0
    run = 0
    for ch in content:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    return "`" * max(3, longest + 1)


def human_size(count: int) -> str:
    return f"{count:,} bytes"


def render(root: Path, output_name: str) -> tuple[str, dict]:
    files, skipped = snapshot(root, output_name)
    total_bytes = 0
    binaries = 0
    embedded = 0
    unreadable: list[str] = []
    secret_files = [rel for rel in files if is_secret(rel)]

    out: list[str] = []
    out.append("# LEGION -- Project Context")
    out.append("")
    out.append(
        f"Generated {datetime.now().astimezone().isoformat(timespec='seconds')} "
        "by `context_watcher.py`."
    )
    out.append("")
    out.append(f"- Root: `{root}`")
    out.append(f"- Files included: **{len(files)}**")
    out.append(f"- Excluded directories present: **{len(skipped)}**")
    out.append(
        "- Always excluded: "
        + ", ".join(f"`{name}/`" for name in sorted(IGNORED_DIRS))
        + f", `{output_name}`"
    )
    out.append("")
    out.append(
        "This document is rebuilt from scratch on every change to the project. "
        "Nothing here is hand-written, appended incrementally, or merged with a "
        "previous build, and no existing prompt file is read to produce it. "
        "Text files appear byte-for-byte as they are on disk."
    )
    if secret_files:
        out.append("")
        out.append(
            "> **Warning:** credential-bearing files are included below -- "
            + ", ".join(f"`{rel}`" for rel in secret_files)
            + ". Treat this document as sensitive."
        )
    out.append("")
    out.append("## Directory tree")
    out.append("")
    out.append("```")
    out.append(f"{root.name}/")
    render_tree(build_tree(files, skipped), root.name, out)
    out.append("```")
    out.append("")
    out.append("## File contents")
    out.append("")

    for rel in files:
        path = root / rel
        out.append(f"### `{rel}`")
        out.append("")
        try:
            data = path.read_bytes()
        except OSError as exc:
            unreadable.append(rel)
            out.append(f"*Unreadable: {exc.strerror or exc}*")
            out.append("")
            continue

        digest = hashlib.sha256(data).hexdigest()
        total_bytes += len(data)

        if not data:
            out.append("*Empty file, 0 bytes.*")
            out.append("")
            continue

        if looks_binary(data):
            binaries += 1
            out.append(
                f"*Binary, {human_size(len(data))}, sha256 `{digest}`. "
                "Contents are not embedded as text; the hash identifies the exact "
                "bytes on disk.*"
            )
            out.append("")
            continue

        embedded += 1
        content = data.decode("utf-8")
        lines = content.count("\n") + (0 if content.endswith("\n") else 1)
        out.append(
            f"*{lines} line{'s' if lines != 1 else ''}, {human_size(len(data))}, "
            f"sha256 `{digest}`*"
        )
        out.append("")
        fence = fence_for(content)
        lang = LANGUAGES.get(path.suffix.lower(), "")
        out.append(f"{fence}{lang}")
        # The list is rejoined with "\n" below, and that separator is the
        # newline terminating the content's last line. Dropping exactly one
        # trailing newline here keeps the block byte-exact: an extra one would
        # add a blank line the file does not contain. A file that does not end
        # in a newline gets one from the join, which is what puts the closing
        # fence on a line of its own.
        out.append(content[:-1] if content.endswith("\n") else content)
        out.append(fence)
        out.append("")

    stats = {
        "files": len(files),
        "bytes": total_bytes,
        "binaries": binaries,
        "embedded": embedded,
        "skipped": len(skipped),
        "unreadable": unreadable,
        "secrets": secret_files,
    }
    return "\n".join(out) + "\n", stats


def write_output(target: Path, markdown: str) -> None:
    # newline="" is load-bearing. The default text mode translates every "\n"
    # to "\r\n" on write, which would make every embedded file differ from the
    # copy on disk by the time it reaches the second line.
    with open(target, "w", encoding="utf-8", newline="") as handle:
        handle.write(markdown)


# --------------------------------------------------------------------------
# watcher
# --------------------------------------------------------------------------


class ContextHandler(FileSystemEventHandler):
    """Forwards every filesystem event to the rebuild scheduler."""

    def __init__(self, root: Path, output_name: str, schedule, log):
        self.root = root
        self.output_name = output_name
        self.schedule = schedule
        self.log = log

    def on_any_event(self, event):
        if event.event_type == "modified":
            return  # a close/open pair covers it, and it doubles the noise
        candidates = [event.src_path]
        dest = getattr(event, "dest_path", None)
        if dest:
            candidates.append(dest)

        for raw in candidates:
            if not raw:
                continue
            try:
                path = Path(raw)
            except (TypeError, ValueError):
                continue
            if is_excluded_path(path, self.root, self.output_name):
                continue
            self.schedule(path, event.event_type)
            return


class Rebuilder(threading.Thread):
    """Coalesces bursts of events into one rebuild, and never overlaps two."""

    def __init__(self, root: Path, output_name: str, delay: float, log):
        super().__init__(name="rebuilder", daemon=True)
        self.root = root
        self.output = root / output_name
        self.delay = delay
        self.log = log
        self._wake = threading.Event()
        self._halt = threading.Event()
        self._reason: str | None = None
        self._build_lock = threading.Lock()

    def request(self, path: Path, event_type: str) -> None:
        try:
            shown = path.relative_to(self.root).as_posix()
        except ValueError:
            shown = str(path)
        self._reason = f"{event_type}: {shown}"
        self._wake.set()

    def stop(self) -> None:
        self._halt.set()
        self._wake.set()

    def run(self) -> None:
        while not self._halt.is_set():
            self._wake.wait()
            if self._halt.is_set():
                break
            self._wake.clear()

            # Editors and compilers write in several steps. Sleeping the
            # debounce window and ignoring everything that lands inside it
            # turns five events into one rebuild instead of five.
            deadline = time.monotonic() + self.delay
            while time.monotonic() < deadline and not self._halt.is_set():
                time.sleep(0.05)

            reason = self._reason or "startup"
            self._reason = None
            self.build(reason)

    def build(self, reason: str) -> None:
        with self._build_lock:
            started = time.monotonic()
            try:
                markdown, stats = render(self.root, self.output.name)
                write_output(self.output, markdown)
            except Exception as exc:  # never let the watcher die
                self.log(f"rebuild FAILED ({reason}): {exc!r}")
                return
            elapsed = (time.monotonic() - started) * 1000
            size = self.output.stat().st_size
            self.log(
                f"rebuilt {self.output.name} after {reason} -- "
                f"{stats['files']} files, {stats['embedded']} embedded, "
                f"{stats['binaries']} binary, {size:,} bytes, {elapsed:.0f} ms"
            )
            for rel in stats["unreadable"]:
                self.log(f"  unreadable: {rel}")
            if stats["secrets"]:
                self.log(
                    "  WARNING credential-bearing file included: "
                    + ", ".join(stats["secrets"])
                )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "root",
        nargs="?",
        default=str(Path(__file__).resolve().parent),
        help="folder to watch (default: the folder holding this script)",
    )
    parser.add_argument("--output", default=OUTPUT_NAME, help="generated filename")
    parser.add_argument(
        "--debounce",
        type=float,
        default=0.6,
        help="seconds of quiet before rebuilding (default: 0.6)",
    )
    parser.add_argument(
        "--once", action="store_true", help="build once and exit"
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        sys.stderr.write(f"not a directory: {root}\n")
        return 2

    started = datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"watching {root} (started {started})", flush=True)

    def log(message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] {message}", flush=True)

    rebuilder = Rebuilder(root, args.output, max(0.0, args.debounce), log)
    rebuilder.build("startup")

    if args.once:
        return 0

    handler = ContextHandler(root, args.output, rebuilder.request, log)
    observer = Observer()
    # ignore_patterns is honoured by the Linux emitter and not by the Windows
    # one. Losing it costs CPU, not correctness: the handler filters anyway.
    try:
        observer.schedule(handler, str(root), recursive=True)
    except Exception as exc:
        log(f"scheduling without ignore patterns: {exc!r}")
        observer.schedule(handler, str(root), recursive=True)

    observer.start()
    rebuilder.start()
    log(f"watching for changes; rebuild writes {args.output} in the same folder")
    log("Ctrl+C to stop")

    stopping = threading.Event()

    def handle_signal(signum, _frame):
        log(f"signal {signum} received, shutting down")
        stopping.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, handle_signal)
            except (ValueError, OSError):
                pass

    try:
        while not stopping.is_set():
            stopping.wait(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join(timeout=5)
        rebuilder.stop()
        rebuilder.join(timeout=5)
        log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())