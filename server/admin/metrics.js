import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const execute = promisify(execFile);

const cpu = () => os.cpus().reduce((sum, c) => {
  sum.idle += c.times.idle;
  sum.total += Object.values(c.times).reduce((a, b) => a + b, 0);
  return sum;
}, { idle: 0, total: 0 });

export async function linuxNetwork() {
  const text = await fs.readFile('/proc/net/dev', 'utf8');
  return text.split('\n').slice(2).reduce((sum, line) => {
    const [iface, rest] = line.split(':');
    if (!rest || iface.trim() === 'lo') return sum;
    const values = rest.trim().split(/\s+/).map(Number);
    sum.rx += values[0]; sum.tx += values[8];
    return sum;
  }, { rx: 0, tx: 0 });
}

async function hostNetwork() {
  if (process.platform !== 'win32') return linuxNetwork();
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000 });
  const result = JSON.parse(stdout);
  return (Array.isArray(result) ? result : [result]).reduce((sum, item) => ({
    rx: sum.rx + Number(item.ReceivedBytes || 0), tx: sum.tx + Number(item.SentBytes || 0),
  }), { rx: 0, tx: 0 });
}

export function createMetrics({ root, sampleMs = 2000 }) {
  let previousCpu = cpu(), previousNet = null, previousAt = Date.now();
  let current = { sampledAt: null, cpuPercent: null, memory: null, disk: null, network: null };
  let busy = false;
  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now(), elapsed = (now - previousAt) / 1000, nextCpu = cpu();
      const delta = nextCpu.total - previousCpu.total;
      const memory = { total: os.totalmem(), available: os.freemem(), processRss: process.memoryUsage().rss };
      if (process.platform === 'linux') {
        try {
          const info = await fs.readFile('/proc/meminfo', 'utf8');
          const hit = /^MemAvailable:\s+(\d+)/m.exec(info);
          if (hit) memory.available = Number(hit[1]) * 1024;
        } catch { /* os.freemem is the portable fallback */ }
      }
      memory.used = memory.total - memory.available;
      let disk = null, network = null;
      try {
        const stat = await fs.statfs(root);
        disk = { total: stat.blocks * stat.bsize, available: stat.bavail * stat.bsize,
          used: (stat.blocks - stat.bfree) * stat.bsize };
      } catch { /* an unavailable mount is displayed as unavailable */ }
      try {
        const net = await hostNetwork();
        network = { receivedBytes: net.rx, sentBytes: net.tx,
          downBytesPerSec: previousNet && elapsed > 0 ? Math.max(0, (net.rx - previousNet.rx) / elapsed) : null,
          upBytesPerSec: previousNet && elapsed > 0 ? Math.max(0, (net.tx - previousNet.tx) / elapsed) : null };
        previousNet = net;
      } catch { /* unavailable counters remain explicitly null */ }
      current = { sampledAt: now, cpuPercent: delta > 0 ? Math.max(0, Math.min(100, (1 - (nextCpu.idle - previousCpu.idle) / delta) * 100)) : null,
        cores: os.cpus().length, loadAverage: os.loadavg(), memory, disk, network, hostUptimeSec: os.uptime() };
      previousCpu = nextCpu; previousAt = now;
    } finally { busy = false; }
  }
  const timer = setInterval(() => { void sample(); }, sampleMs);
  timer.unref();
  void sample();
  return { snapshot: () => structuredClone(current), close: () => clearInterval(timer) };
}
