'use strict';

/**
 * Desktop control.
 *
 * Everything here is curated and typed: LEGION can inspect windows, move focus,
 * read or replace the clipboard, capture the screen, drive the media keys, post
 * a notification, or lock the session. It never accepts a free-form shell
 * string, and every action that leaves the machine or destroys state is routed
 * through the confirmation gate in the registry.
 *
 * The Win32 helpers are compiled once per PowerShell invocation. A tool call is
 * already a subprocess, so the ~200 ms Add-Type cost is not on the hot path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RISK, ToolError } = require('./registry');

const WIN32 = [
  "Add-Type @'",
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class LegionWindow {',
  '  public long Hwnd { get; set; }',
  '  public string Title { get; set; }',
  '  public int Pid { get; set; }',
  '  public bool Focused { get; set; }',
  '  public bool Minimized { get; set; }',
  '}',
  'public class LegionWin {',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  public static List<LegionWindow> List() {',
  '    var res = new List<LegionWindow>();',
  '    var fg = GetForegroundWindow();',
  '    EnumWindows((h, l) => {',
  '      if (!IsWindowVisible(h)) return true;',
  '      var sb = new StringBuilder(512);',
  '      GetWindowText(h, sb, 512);',
  '      var t = sb.ToString();',
  '      if (t.Length == 0) return true;',
  '      uint pid = 0;',
  '      GetWindowThreadProcessId(h, out pid);',
  '      res.Add(new LegionWindow { Hwnd = h.ToInt64(), Title = t, Pid = (int)pid, Focused = h == fg, Minimized = IsIconic(h) });',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return res;',
  '  }',
  '  public static bool Focus(long h) {',
  '    var p = new IntPtr(h);',
  '    if (IsIconic(p)) ShowWindow(p, 9);',
  '    return SetForegroundWindow(p);',
  '  }',
  '  public static bool Show(long h, int cmd) { return ShowWindow(new IntPtr(h), cmd); }',
  '  public static bool Close(long h) { return PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }',
  '  public static void Tap(byte vk) {',
  '    keybd_event(vk, 0, 0, UIntPtr.Zero);',
  '    keybd_event(vk, 0, 2, UIntPtr.Zero);',
  '  }',
  '}',
  "'@"
].join('\n');

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-Command'];

function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function b64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function runPs(ctx, script, timeout) {
  return ctx.run('powershell', POWERSHELL.concat(script), { timeout: timeout || 15000, system: true });
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** Enumerate visible top-level windows, newest focus first. */
async function listWindows(ctx) {
  const script = [
    WIN32,
    '$map=@{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $map[[int]$_.Id]=$_.ProcessName }',
    '$out=@(); foreach($w in [LegionWin]::List()){',
    '  $out += [pscustomobject]@{ hwnd=$w.Hwnd; title=$w.Title; process=$map[[int]$w.Pid]; pid=$w.Pid; focused=$w.Focused; minimized=$w.Minimized }',
    '}',
    '$out | ConvertTo-Json -Compress'
  ].join('\n');
  const res = await runPs(ctx, script, 15000);
  const parsed = parseJson(res.stdout);
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return list
    .filter((w) => w && w.title)
    .map((w) => ({
      hwnd: Number(w.hwnd),
      title: String(w.title),
      process: w.process ? String(w.process) : null,
      pid: Number(w.pid) || null,
      focused: !!w.focused,
      minimized: !!w.minimized
    }))
    .sort((a, b) => Number(b.focused) - Number(a.focused));
}

function resolveWindow(list, target) {
  const q = String(target == null ? '' : target).trim().toLowerCase();
  if (!q) return { error: 'A window title, process name, or hwnd is required.' };
  if (/^\d+$/.test(q)) {
    const byHwnd = list.find((w) => w.hwnd === Number(q));
    return byHwnd ? { win: byHwnd } : { error: `No visible window has hwnd ${q}.` };
  }
  const matches = list.filter((w) =>
    w.title.toLowerCase().includes(q) || String(w.process || '').toLowerCase() === q);
  if (!matches.length) return { error: `No visible window matches "${target}".` };
  if (matches.length > 1) {
    const exact = matches.filter((w) => w.title.toLowerCase() === q);
    if (exact.length === 1) return { win: exact[0] };
    return {
      ambiguous: true,
      message: `"${target}" matches ${matches.length} windows. Pass a longer title or an hwnd.`,
      candidates: matches.slice(0, 8)
    };
  }
  return { win: matches[0] };
}

const ACTIONS = Object.freeze({
  focus: { code: null, label: 'focus' },
  minimize: { code: 6, label: 'minimize' },
  maximize: { code: 3, label: 'maximize' },
  restore: { code: 9, label: 'restore' }
});

const MEDIA_KEYS = Object.freeze({
  playpause: 0xB3,
  next: 0xB0,
  prev: 0xB1,
  stop: 0xB2,
  mute: 0xAD,
  volumeup: 0xAF,
  volumedown: 0xAE
});

module.exports = function registerDesktopTools(registry) {
  registry.register({
    name: 'desktop_windows',
    category: 'apps',
    risk: RISK.READ,
    description: 'List visible desktop windows with their hwnd, owning process and focus state.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many windows to return. Default 30.' }
      }
    },
    async handler({ limit }, ctx) {
      const windows = await listWindows(ctx);
      const n = Math.min(Number(limit) || 30, 50);
      return { count: windows.length, windows: windows.slice(0, n) };
    }
  });

  registry.register({
    name: 'desktop_window',
    category: 'apps',
    risk: RISK.SYSTEM,
    description: 'Focus, minimize, maximize, restore or close a visible window. Identify it by title, process name or hwnd.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close'] },
        target: { type: 'string', description: 'Window title substring, process name, or numeric hwnd.' }
      },
      required: ['action', 'target']
    },
    confirm(args) {
      if (args.action !== 'close') return null;
      return {
        message: `This will ask "${args.target}" to close. Unsaved work in that window may be lost.`,
        impact: 'Closing a window you did not open'
      };
    },
    async handler({ action, target }, ctx) {
      const list = await listWindows(ctx);
      const found = resolveWindow(list, target);
      if (found.error) throw new ToolError(found.error, 'E_NOT_FOUND');
      if (found.ambiguous) return { actioned: false, reason: 'ambiguous', message: found.message, candidates: found.candidates };

      const win = found.win;
      const spec = ACTIONS[action];
      let script;
      if (action === 'close') script = `${WIN32}\n[void][LegionWin]::Close(${win.hwnd}); 'ok'`;
      else if (action === 'focus') script = `${WIN32}\n[void][LegionWin]::Focus(${win.hwnd}); 'ok'`;
      else script = `${WIN32}\n[void][LegionWin]::Show(${win.hwnd}, ${spec.code}); 'ok'`;

      await runPs(ctx, script, 15000);
      return { actioned: true, action, window: { hwnd: win.hwnd, title: win.title, process: win.process } };
    }
  });

  registry.register({
    name: 'desktop_clipboard_read',
    category: 'system',
    risk: RISK.READ,
    description: 'Read the current text on the clipboard. Text can contain passwords or private data, so approval is required.',
    parameters: { type: 'object', properties: {} },
    confirm() {
      return {
        message: 'LEGION will read the clipboard and send its text to the AI provider as tool output.',
        impact: 'Clipboard contents may include passwords or private data'
      };
    },
    async handler(_args, ctx) {
      const res = await runPs(ctx, "$t=Get-Clipboard -Raw -ErrorAction SilentlyContinue; if($null -eq $t){''}else{$t}", 12000);
      const text = String(res.stdout || '').replace(/\r\n$/, '');
      const clipped = text.length > 20000;
      return {
        empty: text.length === 0,
        chars: text.length,
        text: text.slice(0, 20000),
        truncated: clipped
      };
    }
  });

  registry.register({
    name: 'desktop_clipboard_write',
    category: 'system',
    risk: RISK.WRITE,
    description: 'Replace the clipboard text with the supplied string.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 50000, description: 'Text to place on the clipboard.' }
      },
      required: ['text']
    },
    confirm(args) {
      const n = String(args.text || '').length;
      return {
        message: `This will replace the clipboard with ${n} character${n === 1 ? '' : 's'}.`,
        impact: 'The previous clipboard contents will be lost'
      };
    },
    async handler({ text }, ctx) {
      const script = [
        `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}'));`,
        'Set-Clipboard -Value $t;',
        "'ok'"
      ].join('\n');
      await runPs(ctx, script, 12000);
      return { written: true, chars: String(text).length };
    }
  });

  registry.register({
    name: 'desktop_screenshot',
    category: 'system',
    risk: RISK.READ,
    description: 'Capture the whole desktop to a PNG in the temp folder and return its path and size.',
    parameters: { type: 'object', properties: {} },
    confirm() {
      return {
        message: 'LEGION will capture the screen, including any visible private content, and save it to the temp folder.',
        impact: 'A screenshot of everything currently on screen'
      };
    },
    timeoutMs: 20000,
    async handler(_args, ctx) {
      const dir = path.join(os.tmpdir(), 'legion-screens');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `legion-${Date.now()}.png`);
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
        '$g=[System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)',
        `$bmp.Save('${psQuote(file)}',[System.Drawing.Imaging.ImageFormat]::Png)`,
        '$g.Dispose(); $bmp.Dispose()',
        '"{0}x{1}" -f $b.Width,$b.Height'
      ].join('\n');
      const res = await runPs(ctx, script, 18000);
      let size = null;
      try { size = fs.statSync(file).size; } catch (_) { /* capture may have failed */ }
      if (!size) throw new ToolError('The screen capture did not produce a file.', 'E_CAPTURE');
      const dims = String(res.stdout || '').trim().split('x');
      return {
        path: file,
        bytes: size,
        width: Number(dims[0]) || null,
        height: Number(dims[1]) || null
      };
    }
  });

  registry.register({
    name: 'desktop_media',
    category: 'system',
    risk: RISK.SYSTEM,
    description: 'Send a media key: playpause, next, prev, stop, mute, volumeup or volumedown.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['playpause', 'next', 'prev', 'stop', 'mute', 'volumeup', 'volumedown'] },
        repeat: { type: 'integer', minimum: 1, maximum: 10, description: 'For volume keys. Default 1.' }
      },
      required: ['action']
    },
    async handler({ action, repeat }, ctx) {
      const vk = MEDIA_KEYS[action];
      if (!vk) throw new ToolError(`Unknown media action "${action}".`, 'E_INPUT');
      const n = Math.max(1, Math.min(Number(repeat) || 1, 10));
      const taps = Array.from({ length: n }, (_, i) =>
        `[LegionWin]::Tap(0x${vk.toString(16).toUpperCase()})${i < n - 1 ? '; [System.Threading.Thread]::Sleep(55)' : ''}`
      );
      const script = [WIN32, taps.join('\n'), "'ok'"].join('\n');
      await runPs(ctx, script, 12000);
      return { sent: action, repeat: n };
    }
  });

  registry.register({
    name: 'desktop_notify',
    category: 'system',
    risk: RISK.WRITE,
    description: 'Show a Windows notification with a title and body.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 64, description: 'Notification title.' },
        body: { type: 'string', maxLength: 256, description: 'Notification body.' }
      },
      required: ['title']
    },
    async handler({ title, body }, ctx) {
      const script = [
        `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
        `$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body || '')}'))`,
        'try {',
        '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
        '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
        '  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
        '  $safeTitle=[Security.SecurityElement]::Escape($title)',
        '  $safeBody=[Security.SecurityElement]::Escape($body)',
        '  $xml.LoadXml("<toast><visual><binding template=\'ToastGeneric\'><text>$safeTitle</text><text>$safeBody</text></binding></visual></toast>")',
        '  $toast=New-Object Windows.UI.Notifications.ToastNotification $xml',
        "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
        '  "toast"',
        '} catch {',
        '  Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '  $ni=New-Object System.Windows.Forms.NotifyIcon',
        '  $ni.Icon=[System.Drawing.SystemIcons]::Information',
        '  $ni.Visible=$true',
        '  $ni.ShowBalloonTip(4000,$title,$body,[System.Windows.Forms.ToolTipIcon]::None)',
        '  Start-Sleep -Milliseconds 4200',
        '  $ni.Dispose()',
        '  "balloon"',
        '}'
      ].join('\n');
      const res = await runPs(ctx, script, 12000);
      return { shown: true, channel: String(res.stdout || '').trim() || 'toast' };
    }
  });

  registry.register({
    name: 'desktop_lock',
    category: 'system',
    risk: RISK.DESTRUCTIVE,
    description: 'Lock the Windows session immediately. The user must sign back in to continue.',
    parameters: { type: 'object', properties: {} },
    confirm() {
      return {
        message: 'This will lock the Windows session and require a sign-in before anything can continue.',
        impact: 'The desktop becomes inaccessible until you unlock it',
        destructive: true
      };
    },
    async handler(_args, ctx) {
      await ctx.run('rundll32.exe', ['user32.dll,LockWorkStation'], { timeout: 8000, system: true });
      return { locked: true };
    }
  });
};

module.exports.listWindows = listWindows;
module.exports.MEDIA_KEYS = MEDIA_KEYS;
