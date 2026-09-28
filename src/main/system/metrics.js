'use strict';

const os = require('os');
const si = require('systeminformation');

/** Real, machine-sourced system facts. No placeholders, no estimates. */

function pctSafe(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }

  async function staticInfo() {
  const [cpu, mem, osInfo, gpu, battery, time, versions] = await Promise.all([
    si.cpu().catch(() => null),
    si.mem().catch(() => null),
    si.osInfo().catch(() => null),
    si.graphics().catch(() => null),
    si.battery().catch(() => null),
    // si.time() is synchronous in system-information 5.x: it returns a plain
    // object, so Promise.resolve() adopts it instead of calling a missing
    // .catch() on it.
    Promise.resolve().then(() => si.time()).catch(() => null),
    si.versions().catch(() => null)
  ]);

  const gpus = (gpu && gpu.controllers) ? gpu.controllers : [];
  const primary = gpus.find((g) => g.model && !/microsoft basic/i.test(g.model)) || gpus[0] || null;

  return {
    cpu: {
      manufacturer: cpu ? cpu.manufacturer : null,
      model: cpu ? cpu.model : null,
      speedGhz: cpu && cpu.speed ? +(cpu.speed / 1000).toFixed(2) : null,
      cores: cpu ? cpu.cores : null,
      physicalCores: cpu ? cpu.physicalCores : null,
      brand: cpu && cpu.brand ? cpu.brand.trim() : null
    },
    memory: {
      totalBytes: mem ? mem.total : null,
      freeBytes: mem ? mem.free : null,
      usedBytes: mem ? mem.active : null
    },
    gpu: primary ? { model: primary.model, vendor: primary.vendor, vramBytes: primary.vram || null } : null,
    battery: battery && battery.hasBattery
      ? {
          hasBattery: true,
          percent: pctSafe(battery.percent),
          isCharging: !!battery.isCharging,
          secondsRemaining: battery.timeRemaining || null
        }
      : { hasBattery: false, percent: null, isCharging: null, secondsRemaining: null },
    os: osInfo ? { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, arch: osInfo.arch, hostname: osInfo.hostname } : null,
    host: {
      hostname: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime()),
      processUptimeSeconds: Math.floor(process.uptime()),
      user: os.userInfo().username,
      platform: process.platform,
      appVersion: (() => { try { return require('../../package.json').version; } catch (_) { return '1.0.0'; } })(),
      nodeVersion: process.versions.node,
      electronVersion: (() => { try { return process.versions.electron; } catch (_) { return null; } })()
    },
    time: time ? { current: time.current, timezone: time.timezone, timezoneName: time.timezoneName, uptime: time.uptime } : null,
    versions: versions ? { node: versions.node, electron: versions.electron, chrome: versions.chrome, v8: versions.v8 } : null
  };
}

let networkCache = { at: 0, value: null };

async function networkInfo(force) {
  const now = Date.now();
  if (!force && networkCache.value && now - networkCache.at < 15000) return networkCache.value;

  const [iface, latency] = await Promise.all([
    si.networkInterfaces().catch(() => []),
    si.inetLatency().catch(() => -1)
  ]);

  const active = (iface || []).filter((n) => !n.internal);
  const withIp = active.filter((n) => n.ip4 && n.ip4 !== '127.0.0.1');
  const primary = withIp[0] || active[0] || null;

  // A successful latency probe is the honest reachability signal available
  // here. A failed probe does not prove the machine is offline — it can be a
  // blocked ICMP — so "unknown" is reported rather than a hard false.
  const reachable = latency >= 0;

  const value = {
    online: reachable ? true : null,
    latencyMs: reachable ? Math.round(latency) : null,
    activeInterface: primary ? primary.iface : null,
    ip4: primary ? primary.ip4 : null,
    mac: primary ? primary.mac : null,
    type: primary ? primary.type : null,
    interfaces: active.slice(0, 8).map((n) => ({ iface: n.iface, type: n.type, ip4: n.ip4, ip6: n.ip6, mac: n.mac })),
    totalDown: null,
    totalUp: null,
    probe: reachable ? Math.round(latency) : null
  };
  networkCache = { at: now, value };
  return value;
}

async function currentLoad() {
  const [cpuLoad, mem, battery, temps] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.battery().catch(() => null),
    si.cpuTemperature().catch(() => null)
  ]);

  const memPct = mem && mem.total ? +((mem.active / mem.total) * 100).toFixed(1) : null;

  return {
    cpuPct: cpuLoad ? pctSafe(cpuLoad.currentLoad) : null,
    memPct,
    memUsedBytes: mem ? mem.active : null,
    memTotalBytes: mem ? mem.total : null,
    batteryPct: battery && battery.hasBattery ? pctSafe(battery.percent) : null,
    batteryCharging: battery && battery.hasBattery ? !!battery.isCharging : null,
    cpuTempC: temps && typeof temps.main === 'number' ? Math.round(temps.main) : null,
    processCpuPct: null,
    processMemBytes: process.memoryUsage().rss
  };
}

async function diskInfo() {
  const fsSize = await si.fsSize().catch(() => []);
  const drives = (Array.isArray(fsSize) ? fsSize : [fsSize]).filter(Boolean)
    .filter((d) => d.size > 0)
    .map((d) => ({ mount: d.mount, fs: d.fs, type: d.type, sizeBytes: d.size, usedBytes: d.used, usePct: d.use }));
  const root = drives.find((d) => /^[A-Za-z]:\\?$/.test(d.mount)) || drives[0] || null;
  return { drives, root };
}

module.exports = { staticInfo, currentLoad, networkInfo, diskInfo };
