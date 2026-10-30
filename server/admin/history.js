// Local health observations for the owner console. Gaps are unknown, not inferred outages.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const HOURS = 48;
const RETENTION = HOURS * 60;

/** Probe the actual game listener, including an IPv6-only or explicitly bound address. */
export function probeGameServer(server) {
  const address = server.address();
  if (!server.listening || !address || typeof address === 'string') return Promise.resolve(false);
  const host = address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ host, port: address.port, path: '/healthz', agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 65_536) req.destroy();
      });
      res.on('end', () => {
        try { finish(res.statusCode === 200 && JSON.parse(body).ok === true); } catch { finish(false); }
      });
      res.on('error', () => finish(false));
    });
    req.setTimeout(3000, () => req.destroy());
    req.on('error', () => finish(false));
    req.on('close', () => finish(false));
  });
}

/** Persist observations next to the admin state without touching announcements or bans. */
export function createServiceHistory({ file, probe, now = Date.now, log = console, sampleMs = MINUTE }) {
  const samples = new Map(); // minute since epoch -> true / false; a failure wins within a minute
  let lastCheck = null, timer = null, inFlight = null, closed = false;
  let storageOk = true, canWrite = true, needsCompact = false, writes = 0;

  const prune = () => {
    const first = Math.floor(now() / MINUTE) - RETENTION + 1;
    for (const minute of samples.keys()) if (minute < first) { samples.delete(minute); needsCompact = true; }
  };

  async function load() {
    try {
      const contents = await fs.readFile(file, 'utf8');
      if (contents && !contents.endsWith('\n')) needsCompact = true;
      const current = Math.floor(now() / MINUTE);
      for (const line of contents.split('\n')) {
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (!Number.isSafeInteger(item.minute) || item.minute > current || typeof item.ok !== 'boolean') { needsCompact = true; continue; }
          samples.set(item.minute, samples.get(item.minute) === false ? false : item.ok);
        } catch { needsCompact = true; /* a partially written last line is not an observation */ }
      }
      prune();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        canWrite = false; storageOk = false;
        log.warn?.('[admin] cannot read service history', error);
      }
    }
  }

  async function save(minute, ok) {
    if (!canWrite) return;
    let temp = null;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      if (needsCompact || writes >= 60) {
        temp = `${file}.${randomUUID()}.tmp`;
        const lines = [...samples.entries()].sort((a, b) => a[0] - b[0]).map(([m, value]) => JSON.stringify({ minute: m, ok: value }));
        await fs.writeFile(temp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, file);
        needsCompact = false; writes = 0;
      } else {
        await fs.appendFile(file, JSON.stringify({ minute, ok }) + '\n', { mode: 0o600 });
        writes++;
      }
      storageOk = true;
    } catch (error) {
      if (storageOk) log.warn?.('[admin] cannot save service history', error);
      storageOk = false; needsCompact = true;
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
    }
  }

  async function sample() {
    if (closed || inFlight) return inFlight;
    inFlight = (async () => {
      let ok = false;
      try { ok = (await probe()) === true; } catch { /* a failed probe is an observed failure */ }
      if (closed) return;
      const at = now(), minute = Math.floor(at / MINUTE);
      lastCheck = { at, ok };
      const old = samples.get(minute);
      const value = old === false ? false : ok;
      samples.set(minute, value);
      prune();
      if (old !== value || needsCompact) await save(minute, value);
    })();
    try { await inFlight; } finally { inFlight = null; }
  }

  function snapshot() {
    const end = Math.floor(now() / MINUTE) + 1;
    const buckets = Array.from({ length: HOURS }, (_, i) => {
      const first = end - (HOURS - i) * 60;
      let healthy = 0, failed = 0;
      for (let m = first; m < first + 60; m++) {
        if (samples.get(m) === true) healthy++;
        else if (samples.get(m) === false) failed++;
      }
      const missing = 60 - healthy - failed;
      const status = failed ? 'failed' : !healthy ? 'unknown' : missing ? 'partial' : 'healthy';
      return { from: first * MINUTE, to: (first + 60) * MINUTE, healthy, failed, missing, status };
    });
    return { lastCheck, storageOk, buckets };
  }

  return {
    async start() {
      await load();
      await sample();
      if (!closed) { timer = setInterval(() => { void sample(); }, sampleMs); timer.unref(); }
    },
    sample, snapshot,
    async close() { closed = true; if (timer) clearInterval(timer); await inFlight; },
  };
}
