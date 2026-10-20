'use strict';
// Speed test against Cloudflare's public speed endpoints.
// Uses Electron's net.fetch (Chromium network stack) so it honours the Windows/corporate proxy.
const { net } = require('electron');
const crypto = require('crypto');

const BASE = 'https://speed.cloudflare.com';
const HDRS = { 'Cache-Control': 'no-cache' };
const now = () => performance.now();
const rnd = () => Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function abortErr() { const e = new Error('ABORTED'); e.name = 'AbortError'; return e; }

async function meta(signal) {
  const empty = { ip: null, isp: null, colo: null, city: null, country: null };
  try {
    const r = await net.fetch(`${BASE}/meta?r=${rnd()}`, { headers: HDRS, signal });
    if (r.ok) {
      const j = await r.json();
      return { ip: j.clientIp || null, isp: j.asOrganization || null, colo: j.colo || null, city: j.city || null, country: j.country || null };
    }
  } catch { if (signal && signal.aborted) throw abortErr(); }
  try {
    const r = await net.fetch(`${BASE}/cdn-cgi/trace?r=${rnd()}`, { headers: HDRS, signal });
    const kv = Object.fromEntries((await r.text()).trim().split('\n').map((l) => l.split('=')));
    return { ...empty, ip: kv.ip || null, colo: kv.colo || null, country: kv.loc || null };
  } catch { if (signal && signal.aborted) throw abortErr(); }
  return empty;
}

// HTTP round-trip latency. Server processing time (server-timing header) is subtracted.
async function latency({ count = 12, signal, onProgress } = {}) {
  const s = [];
  for (let i = 0; i < count; i++) {
    if (signal && signal.aborted) throw abortErr();
    const t0 = now();
    const r = await net.fetch(`${BASE}/__down?bytes=0&r=${rnd()}`, { headers: HDRS, signal });
    await r.arrayBuffer();
    let dt = now() - t0;
    const st = /dur=([\d.]+)/.exec(r.headers.get('server-timing') || '');
    if (st) dt = Math.max(0.5, dt - parseFloat(st[1]));
    if (i > 0) { // first request carries the TLS handshake: discard
      s.push(dt);
      onProgress && onProgress({ phase: 'latency', value: dt, pct: i / (count - 1) });
    }
  }
  const sorted = [...s].sort((a, b) => a - b);
  let j = 0;
  for (let i = 1; i < s.length; i++) j += Math.abs(s[i] - s[i - 1]);
  return { ping: sorted[Math.floor(sorted.length / 2)], jitter: s.length > 1 ? j / (s.length - 1) : 0 };
}

// Multi-stream throughput for a fixed duration. First ~1.5 s (TCP ramp-up) is excluded.
async function throughput({ kind, durationMs, streams, signal, onProgress }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort);

  const t0 = now();
  const end = t0 + durationMs;
  const warm = t0 + Math.min(1500, durationMs * 0.2);
  let bytes = 0, warmBytes = null, warmAt = null, lastErr = null;
  const upBuf = kind === 'up' ? crypto.randomBytes(8 * 1024 * 1024) : null;

  const dlWorker = async () => {
    while (now() < end && !ctrl.signal.aborted) {
      try {
        const res = await net.fetch(`${BASE}/__down?bytes=25000000&r=${rnd()}`, { headers: HDRS, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (now() >= end || ctrl.signal.aborted) { reader.cancel().catch(() => {}); break; }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        lastErr = e; await sleep(250);
      }
    }
  };

  const ulWorker = async () => {
    let size = 256 * 1024; // grows while requests finish under 1 s
    while (now() < end && !ctrl.signal.aborted) {
      try {
        const t = now();
        const res = await net.fetch(`${BASE}/__up?r=${rnd()}`, {
          method: 'POST',
          headers: { ...HDRS, 'Content-Type': 'text/plain' },
          body: upBuf.subarray(0, size),
          signal: ctrl.signal
        });
        await res.arrayBuffer();
        if (!res.ok) throw new Error('HTTP ' + res.status);
        bytes += size;
        if (now() - t < 1000 && size < upBuf.length) size *= 2;
      } catch (e) {
        if (ctrl.signal.aborted) return;
        lastErr = e; await sleep(250);
      }
    }
  };

  let lastB = 0, lastT = t0, ema = 0;
  const timer = setInterval(() => {
    const t = now();
    if (warmBytes === null && t >= warm) { warmBytes = bytes; warmAt = t; }
    const inst = ((bytes - lastB) * 8) / ((t - lastT) / 1000) / 1e6;
    ema = ema ? ema * 0.7 + inst * 0.3 : inst;
    lastB = bytes; lastT = t;
    onProgress && onProgress({ phase: kind === 'up' ? 'upload' : 'download', value: ema, pct: Math.min(1, (t - t0) / durationMs) });
  }, 250);

  await Promise.all(Array.from({ length: streams }, kind === 'up' ? ulWorker : dlWorker));
  clearInterval(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (signal && signal.aborted) throw abortErr();
  if (bytes === 0) throw lastErr || new Error('NO DATA RECEIVED');

  const tEnd = now();
  const b0 = warmBytes === null ? 0 : warmBytes;
  const ts = warmAt === null ? t0 : warmAt;
  return ((bytes - b0) * 8) / ((tEnd - ts) / 1000) / 1e6;
}

async function run({ signal, onProgress, durationSec = 8 } = {}) {
  onProgress && onProgress({ phase: 'meta', pct: 0 });
  const m = await meta(signal);
  const lat = await latency({ signal, onProgress });
  const down = await throughput({ kind: 'down', durationMs: durationSec * 1000, streams: 4, signal, onProgress });
  const up = await throughput({ kind: 'up', durationMs: durationSec * 1000, streams: 3, signal, onProgress });
  return { down: r2(down), up: r2(up), ping: r1(lat.ping), jitter: r1(lat.jitter), ...m, server: 'speed.cloudflare.com' };
}

module.exports = { run, meta };
