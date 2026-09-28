/** Small formatting helpers shared across the interface. */

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtBytes(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const b = Number(n);
  if (b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtPct(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return `${Math.round(Number(n))}%`;
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '—';
  const s = Math.floor(Number(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function parseRgb(str, fallback = [53, 200, 255]) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(String(str || ''));
  if (!m) return fallback;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
