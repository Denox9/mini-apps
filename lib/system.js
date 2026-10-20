'use strict';
// OS probes: ICMP ping, TCP probe, gateway, Wi-Fi, adapters/VPN, connections, byte counters.
// Windows-first (netsh / PowerShell / netstat). Other OSes degrade gracefully.
const { execFile } = require('child_process');
const netNode = require('net');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const HOST_RE = /^[a-zA-Z0-9.\-:]{1,253}$/;
const VPN_RE = /vpn|anyconnect|cisco|fortinet|forticlient|globalprotect|pangp|palo ?alto|tap-windows|wintun|wireguard|openvpn|juniper|pulse secure|ivanti|zscaler|check ?point|sonicwall|netextender|f5 |big-ip|nordlynx|tailscale/i;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    });
  });
}

// -EncodedCommand avoids every quoting problem when passing scripts to PowerShell.
function ps(script, timeout = 10000) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], timeout);
}

function parseJsonArray(txt) {
  try {
    const v = JSON.parse(txt.trim().replace(/^\uFEFF/, ''));
    return Array.isArray(v) ? v : v ? [v] : [];
  } catch { return null; }
}

const validHost = (h) => typeof h === 'string' && HOST_RE.test(h);

async function ping(host, timeoutMs = 1500) {
  if (!validHost(host)) return { host, ok: false, ms: null, t: Date.now() };
  const args = IS_WIN
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
  const t0 = performance.now();
  const r = await run('ping', args, timeoutMs + 3000);
  // Windows returns exit 0 for "Destination host unreachable", so require a TTL line.
  const ok = IS_WIN ? /TTL=/i.test(r.out) : r.ok;
  let ms = null;
  const m = r.out.match(/[=<]\s*([\d.]+)\s*ms/i);
  if (ok) ms = m ? Math.max(parseFloat(m[1]), 0.5) : Math.round(performance.now() - t0);
  return { host, ok, ms, t: Date.now() };
}

function tcpCheck(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!validHost(host)) return resolve({ host, port, ok: false, ms: null, t: Date.now() });
    const t0 = performance.now();
    const sock = new netNode.Socket();
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ host, port, ok, ms: ok ? Math.round((performance.now() - t0) * 10) / 10 : null, t: Date.now() });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    sock.connect(port, host);
  });
}

// One entry point for monitor + watchlist: port given -> TCP connect time, else ICMP.
const probe = (host, port, timeoutMs) => (port ? tcpCheck(host, port, timeoutMs) : ping(host, timeoutMs));

async function gateway() {
  if (IS_WIN) {
    const r = await ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1).NextHop");
    const ip = r.out.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' ? ip : null;
  }
  const r = await run('sh', ['-c', 'ip route show default 2>/dev/null || route -n get default 2>/dev/null']);
  const m = r.out.match(/(?:via|gateway:)\s*(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

async function wifi() {
  if (!IS_WIN) return null;
  const r = await run('netsh', ['wlan', 'show', 'interfaces']);
  if (!r.out) return null;
  const kv = {};
  r.out.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (m) { const k = m[1].toLowerCase(); if (!(k in kv)) kv[k] = m[2].trim(); }
  });
  if (!kv.state) return null;
  return {
    name: kv.name || null,
    state: kv.state,
    ssid: kv.ssid || null,
    signal: kv.signal ? parseInt(kv.signal, 10) : null,
    radio: kv['radio type'] || null,
    channel: kv.channel || null,
    rx: kv['receive rate (mbps)'] ? parseFloat(kv['receive rate (mbps)']) : null,
    tx: kv['transmit rate (mbps)'] ? parseFloat(kv['transmit rate (mbps)']) : null
  };
}

async function adapters() {
  if (!IS_WIN) return [];
  const r = await ps('ConvertTo-Json -Compress -InputObject @(Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed)');
  return parseJsonArray(r.out) || [];
}

function detectVpn(list) {
  const hit = (list || []).find((a) => a.Status === 'Up' && VPN_RE.test(`${a.Name} ${a.InterfaceDescription}`));
  return hit ? { active: true, name: hit.InterfaceDescription || hit.Name } : { active: false, name: null };
}

async function connections() {
  if (!IS_WIN) return null;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$p=@{}; Get-Process | ForEach-Object { $p[[int]$_.Id]=$_.ProcessName }',
    "$c = Get-NetTCPConnection -State Established | Where-Object { $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' } | ForEach-Object { [pscustomobject]@{ p=$p[[int]$_.OwningProcess]; id=[int]$_.OwningProcess; l=\"$($_.LocalAddress):$($_.LocalPort)\"; r=\"$($_.RemoteAddress):$($_.RemotePort)\" } }",
    'ConvertTo-Json -Compress -InputObject @($c)'
  ].join('\n');
  const r = await ps(script, 15000);
  return parseJsonArray(r.out) || [];
}

// Total bytes in/out. netstat -e is a native exe = far cheaper than spawning PowerShell every 2 s.
async function netCounters() {
  if (IS_WIN) {
    const r = await run('netstat', ['-e'], 4000);
    const m = r.out.match(/^\s*Bytes\s+(\d+)\s+(\d+)/m);
    return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null;
  }
  try {
    let rx = 0, tx = 0;
    fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).forEach((l) => {
      const [name, rest] = l.split(':');
      if (!rest || name.trim() === 'lo') return;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]); tx += Number(f[8]);
    });
    return { rx, tx };
  } catch { return null; }
}

module.exports = { validHost, ping, tcpCheck, probe, gateway, wifi, adapters, detectVpn, connections, netCounters };
