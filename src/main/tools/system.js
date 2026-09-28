'use strict';

const si = require('systeminformation');
const metrics = require('../system/metrics');
const { RISK, ToolError } = require('./registry');

const gb = (b) => (typeof b === 'number' ? +(b / 1073741824).toFixed(2) : null);

function humanBytes(b) {
  if (typeof b !== 'number') return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function uptime() {
  const s = metrics.staticInfo;
  const st = await s();
  return {
    hostUptimeSeconds: st.host.uptimeSeconds,
    legionUptimeSeconds: st.host.processUptimeSeconds,
    formatted: formatDuration(st.host.uptimeSeconds)
  };
}

function formatDuration(sec) {
  if (typeof sec !== 'number') return 'unknown';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = function registerSystemTools(registry) {
  registry.register({
    name: 'system_cpu',
    category: 'system',
    risk: RISK.READ,
    description: 'Read live CPU utilisation, load average, per-core usage and temperature.',
    parameters: { type: 'object', properties: { includeCores: { type: 'boolean', description: 'Include per-core percentages.' } } },
    async handler({ includeCores }) {
      const [load, temps, cpu] = await Promise.all([
        si.currentLoad().catch(() => null),
        si.cpuTemperature().catch(() => null),
        si.cpu().catch(() => null)
      ]);
      return {
        cpuPct: load ? Math.round(load.currentLoad) : null,
        loadAverage: load ? load.avgLoad : null,
        perCore: includeCores && load ? load.cpus.map((c) => Math.round(c.load)) : undefined,
        temperatureC: temps && typeof temps.main === 'number' ? Math.round(temps.main) : null,
        model: cpu ? cpu.model : null,
        cores: cpu ? cpu.cores : null
      };
    }
  });

  registry.register({
    name: 'system_memory',
    category: 'system',
    risk: RISK.READ,
    description: 'Read physical memory usage.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const m = await si.mem().catch(() => null);
      if (!m) throw new ToolError('Memory information is unavailable.');
      return {
        usedBytes: m.active, totalBytes: m.total, freeBytes: m.free,
        usedPct: +((m.active / m.total) * 100).toFixed(1),
        human: { used: humanBytes(m.active), total: humanBytes(m.total) }
      };
    }
  });

  registry.register({
    name: 'system_full_status',
    category: 'system',
    risk: RISK.READ,
    description: 'Read a complete snapshot: CPU, RAM, GPU, battery, storage and network.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const [stat, load, net, disk] = await Promise.all([
        metrics.staticInfo(), metrics.currentLoad(), metrics.networkInfo(true), metrics.diskInfo()
      ]);
      return {
        cpu: { ...stat.cpu, usagePct: load.cpuPct, temperatureC: load.cpuTempC },
        memory: { usedPct: load.memPct, used: humanBytes(load.memUsedBytes), total: humanBytes(load.memTotalBytes) },
        gpu: stat.gpu,
        battery: stat.battery,
        storage: disk.drives.map((d) => ({ mount: d.mount, used: humanBytes(d.usedBytes), total: humanBytes(d.sizeBytes), usePct: d.usePct })),
        network: { online: net.online, latencyMs: net.latencyMs, interface: net.activeInterface, ip4: net.ip4, type: net.type },
        os: stat.os, host: stat.host, legionMemoryMB: +(process.memoryUsage().rss / 1048576).toFixed(1)
      };
    }
  });

  registry.register({
    name: 'system_battery',
    category: 'system',
    risk: RISK.READ,
    description: 'Read battery charge level and charging state.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const b = await si.battery().catch(() => null);
      if (!b || !b.hasBattery) return { hasBattery: false, note: 'This machine has no battery.' };
      return {
        hasBattery: true, percent: Math.round(b.percent), isCharging: !!b.isCharging,
        minutesRemaining: b.timeRemaining || null,
        minutesToFull: b.timeToFull || null
      };
    }
  });

  registry.register({
    name: 'system_network',
    category: 'system',
    risk: RISK.READ,
    description: 'Read network connectivity, latency and active interface.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const n = await metrics.networkInfo(true);
      return { online: n.online, latencyMs: n.latencyMs, interface: n.activeInterface, ip4: n.ip4, type: n.type, mac: n.mac };
    }
  });

  registry.register({
    name: 'system_processes',
    category: 'system',
    risk: RISK.READ,
    description: 'List running processes, optionally filtered by name and sorted by CPU or memory.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Substring match on process name.' },
        sortBy: { type: 'string', enum: ['cpu', 'mem'], description: 'Sort key. Default cpu.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return. Default 15.' }
      }
    },
    async handler({ filter, sortBy, limit }) {
      const n = Math.min(Number(limit) || 15, 50);
      let list = await si.processes().catch(() => []);
      if (filter) {
        const f = filter.toLowerCase();
        list = list.filter((p) => String(p.name).toLowerCase().includes(f));
      }
      list.sort((a, b) => (sortBy === 'mem' ? (b.memr || 0) - (a.memr || 0) : (b.cpu || 0) - (a.cpu || 0)));
      return {
        count: list.length,
        processes: list.slice(0, n).map((p) => ({ name: p.name, pid: p.pid, cpuPct: +Number(p.cpu || 0).toFixed(1), memMB: +(p.memr || 0) }))
      };
    }
  });

  registry.register({
    name: 'system_uptime',
    category: 'system',
    risk: RISK.READ,
    description: 'Report how long the machine and LEGION have been running.',
    parameters: { type: 'object', properties: {} },
    async handler() { return uptime(); }
  });

  registry.register({
    name: 'system_storage',
    category: 'system',
    risk: RISK.READ,
    description: 'Report disk usage for every mounted drive.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const d = await metrics.diskInfo();
      return { drives: d.drives.map((x) => ({ mount: x.mount, fs: x.fs, type: x.type, used: humanBytes(x.usedBytes), total: humanBytes(x.sizeBytes), usePct: x.usePct })) };
    }
  });
};

module.exports.humanBytes = humanBytes;
module.exports.formatDuration = formatDuration;
