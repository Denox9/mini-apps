'use strict';
// PC monitor: CPU (total + per core), memory, disk activity, volume space, temperatures.
//
// CPU + memory come from Node's os module (no process spawn, near-zero cost).
// Disk + temperature need WMI, so ONE long-lived PowerShell sampler is started and streams
// one JSON line per tick. This avoids spawning PowerShell every 2 s.
//
// Temperature sources, best first:
//   LHM  = LibreHardwareMonitor running (WMI root/LibreHardwareMonitor): real CPU/GPU/SSD sensors
//   OHM  = OpenHardwareMonitor running (WMI root/OpenHardwareMonitor)
//   ACPI = Windows thermal-zone counter: board/zone estimate, not the CPU die; often static
//   NONE = nothing readable on this PC
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';

// No backticks or "${" inside: this lives in a JS template string.
const PS_SAMPLER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Read-Temps([string]$only) {
  if ($only -eq '' -or $only -eq 'LHM' -or $only -eq 'OHM') {
    foreach ($ns in @('root/LibreHardwareMonitor', 'root/OpenHardwareMonitor')) {
      $tag = 'OHM'
      if ($ns -like '*Libre*') { $tag = 'LHM' }
      if ($only -ne '' -and $only -ne $tag) { continue }
      $s = @(Get-CimInstance -Namespace $ns -ClassName Sensor -Filter "SensorType='Temperature'" -ErrorAction SilentlyContinue)
      if ($s.Count -gt 0) {
        return @{ src = $tag; list = @($s | ForEach-Object { @{ n = $_.Name; id = $_.Identifier; v = $_.Value } }) }
      }
    }
  }
  if ($only -eq '' -or $only -eq 'ACPI') {
    $z = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue)
    if ($z.Count -gt 0) {
      return @{ src = 'ACPI'; list = @($z | ForEach-Object { @{ n = $_.Name; id = 'acpi'; hk = $_.HighPrecisionTemperature; k = $_.Temperature } }) }
    }
    $a = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue)
    if ($a.Count -gt 0) {
      return @{ src = 'ACPI'; list = @($a | ForEach-Object { @{ n = $_.InstanceName; id = 'acpi'; hk = $_.CurrentTemperature } }) }
    }
  }
  return @{ src = 'NONE'; list = @() }
}

$tick = 0
$vols = @()
$temps = @{ src = 'NONE'; list = @() }
while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  try {
    $disks = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne '_Total' } |
      ForEach-Object { @{ n = $_.Name; idle = $_.PercentIdleTime; rd = $_.DiskReadBytesPersec; wr = $_.DiskWriteBytesPersec; q = $_.CurrentDiskQueueLength } })
    if ($tick % 5 -eq 0) {
      $vols = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue |
        ForEach-Object { @{ id = $_.DeviceID; label = $_.VolumeName; size = $_.Size; free = $_.FreeSpace } })
    }
    if ($tick % 30 -eq 0) { $temps = Read-Temps '' }
    elseif ($temps.src -ne 'NONE') { $temps = Read-Temps $temps.src }
    ConvertTo-Json -Compress -Depth 5 -InputObject @{ disks = $disks; vols = $vols; tsrc = $temps.src; temps = $temps.list }
  } catch {}
  $tick++
  Start-Sleep -Milliseconds $IntervalMs
}
`;

const BAD_SENSOR = /distance|tjmax|warning|critical|limit|threshold|resolution/i;
const round1 = (v) => Math.round(v * 10) / 10;

function classify(id) {
  const s = String(id || '').toLowerCase();
  if (s === 'acpi') return 'ZONE';
  if (/cpu/.test(s)) return 'CPU';
  if (/gpu/.test(s)) return 'GPU';
  if (/nvme|hdd|ssd|storage/.test(s)) return 'DISK';
  return 'BOARD';
}

function normTemps(list, src) {
  const out = [];
  (list || []).forEach((x) => {
    let c = null;
    if (src === 'LHM' || src === 'OHM') c = Number(x.v);
    else if (x.hk) c = Number(x.hk) / 10 - 273.15;
    else if (x.k) c = Number(x.k) - 273.15;
    if (!Number.isFinite(c) || c <= -20 || c >= 150 || BAD_SENSOR.test(x.n || '')) return;
    const id = String(x.id || '');
    const hw = id === 'acpi' ? 'ACPI' : id.split('/').filter(Boolean).slice(0, 2).join(' ').toUpperCase();
    out.push({ n: String(x.n || 'SENSOR').toUpperCase(), hw, kind: classify(id), c: round1(c) });
  });
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || b.c - a.c);
}

// Headline temperature: CPU package > hottest CPU sensor > hottest board/zone > hottest anything.
function pickTemp(temps) {
  const max = (arr) => arr.reduce((m, x) => (!m || x.c > m.c ? x : m), null);
  const cpu = temps.filter((t) => t.kind === 'CPU');
  return cpu.find((t) => /package|tctl|tdie/i.test(t.n)) || max(cpu) ||
    max(temps.filter((t) => t.kind === 'BOARD' || t.kind === 'ZONE')) || max(temps);
}

class PcMonitor extends EventEmitter {
  constructor() {
    super();
    this.interval = 2000;
    this.prev = null;
    this.timer = null;
    this.child = null;
    this.buf = '';
    this.fails = 0;
    this.killing = false;
    this.ext = { disks: [], vols: [], temps: [], tsrc: IS_WIN ? 'PENDING' : 'NONE', t: 0 };
  }

  info() {
    const c = os.cpus();
    return {
      host: os.hostname(),
      cpuModel: c.length ? c[0].model.replace(/\s+/g, ' ').trim() : 'UNKNOWN CPU',
      cores: c.length,
      totalMem: os.totalmem(),
      platform: `${os.type()} ${os.release()}`,
      uptime: os.uptime()
    };
  }

  start(ms) {
    this.running = true;
    this.interval = ms || this.interval;
    this.prev = this._cpuTimes();
    this._loop();
    if (IS_WIN) this._spawn();
  }

  setRate(ms) {
    if (ms === this.interval || !this.running) return;
    this.interval = ms;
    clearTimeout(this.timer);
    this._loop();
    if (IS_WIN) { this._kill(); this._spawn(); }
  }

  stop() { this.running = false; clearTimeout(this.timer); this._kill(); }

  // ---- CPU / memory (Node) ----
  _cpuTimes() {
    return os.cpus().map((c) => {
      const t = c.times;
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
    });
  }

  _loop() {
    if (!this.running) return;
    this.timer = setTimeout(() => { this._sample(); this._loop(); }, this.interval);
  }

  _sample() {
    const cur = this._cpuTimes();
    const cores = cur.map((c, i) => {
      const p = this.prev && this.prev[i];
      if (!p) return 0;
      const dt = c.total - p.total, di = c.idle - p.idle;
      return dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
    });
    this.prev = cur;
    const cpu = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;

    const total = os.totalmem(), free = os.freemem(); // on Windows freemem = "Available"
    const used = total - free;

    const e = this.ext;
    const disks = e.disks;
    const active = disks.length ? Math.max(...disks.map((d) => d.active)) : null;
    const rd = disks.reduce((a, d) => a + d.rd, 0), wr = disks.reduce((a, d) => a + d.wr, 0);
    const head = pickTemp(e.temps);
    const stale = IS_WIN && e.t && Date.now() - e.t > this.interval * 3 + 10000;

    this.emit('sample', {
      t: Date.now(),
      cpu: round1(cpu),
      cores: cores.map((v) => Math.round(v)),
      mem: { total, used, pct: round1((used / total) * 100) },
      disk: { active: active == null ? null : round1(active), rd, wr },
      disks, vols: e.vols, temps: e.temps, tsrc: e.tsrc,
      temp: head ? head.c : null, tempName: head ? `${head.hw} ${head.n}`.trim() : null,
      ext: !!e.t && !stale, uptime: os.uptime()
    });
  }

  // ---- PowerShell sampler (disk + temps) ----
  _spawn() {
    const script = `$IntervalMs = ${Math.max(1000, this.interval)}; $ParentPid = ${process.pid};\n${PS_SAMPLER}`;
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return this._failed(); }
    this.child = child;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim().replace(/^\uFEFF/, '');
        this.buf = this.buf.slice(i + 1);
        if (line.startsWith('{')) this._ingest(line);
      }
    });
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.killing) { this.killing = false; return; }
      this._failed();
    });
  }

  _failed() {
    this.fails++;
    if (!this.running) return;
    if (this.fails > 5) { this.ext.tsrc = 'UNAVAILABLE'; return; } // give up: CPU/MEM still work
    setTimeout(() => { if (this.running && !this.child) this._spawn(); }, 5000 * this.fails);
  }

  _kill() {
    if (this.child) { this.killing = true; try { this.child.kill(); } catch {} this.child = null; }
  }

  _ingest(line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    this.fails = 0;
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    this.ext = {
      t: Date.now(),
      tsrc: j.tsrc || 'NONE',
      disks: arr(j.disks).map((d) => ({
        n: String(d.n || '?').toUpperCase(),
        active: round1(Math.max(0, Math.min(100, 100 - Number(d.idle || 0)))),
        rd: Number(d.rd) || 0, wr: Number(d.wr) || 0, q: Number(d.q) || 0
      })),
      vols: arr(j.vols).filter((v) => Number(v.size) > 0).map((v) => ({
        id: v.id, label: v.label || '', size: Number(v.size), free: Number(v.free),
        usedPct: round1((1 - Number(v.free) / Number(v.size)) * 100)
      })),
      temps: normTemps(arr(j.temps), j.tsrc)
    };
  }
}

module.exports = { PcMonitor, normTemps, pickTemp };
