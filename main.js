'use strict';
// PNG-01 NetMon — main process: window, tray, network + PC monitor loops, alerts, IPC.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./lib/store');
const sys = require('./lib/system');
const speed = require('./lib/speedtest');
const { PcMonitor } = require('./lib/pcstats');

const DEFAULTS = {
  monitorTarget: '1.1.1.1',
  monitorPort: null,          // null = ICMP ping. Set 443 if ICMP is blocked on your network.
  monitorIntervalSec: 5,
  autoTestMin: 0,             // 0 = off
  testDurationSec: 8,
  slowPct: 30,                // "slow" = last test below X% of baseline
  alerts: true,
  closeToTray: true,
  // PC monitor thresholds
  cpuAlertPct: 90,            // sustained 60 s
  memAlertPct: 90,            // sustained 60 s
  tempAlertC: 85,             // sustained 30 s
  diskFreeAlertPct: 10,       // any fixed volume below X% free
  servers: [
    { id: 'gdns', name: 'GOOGLE DNS', host: '8.8.8.8', port: null },
    { id: 'cf443', name: 'CLOUDFLARE', host: '1.1.1.1', port: 443 },
    { id: 'protolab', name: 'PROTOLAB SRV', host: '10.193.20.153', port: 80 }
  ]
};
const MOOD_LABEL = { fast: 'FAST', ok: 'NOMINAL', slow: 'SLOW', unstable: 'UNSTABLE', offline: 'OFFLINE', testing: 'TESTING' };
const MAX_SAMPLES = 1440;
const MAX_PC_SAMPLES = 300;
const PC_RATE_VISIBLE = 2000, PC_RATE_HIDDEN = 10000;

let win = null, tray = null, store, settings, history, events;
let samples = [];
let serverStatus = {};
let linkInfo = { wifi: null, adapters: [], vpn: { active: false, name: null }, gateway: null, meta: null };
let testing = false, testAbort = null;
let moodState = { mood: 'ok', stats: {}, diag: '', outageStart: null, baseline: null };
let failStreak = 0, outageStart = null, gwEverOk = false;
let monitorTimer = null, serverTimer = null, autoTimer = null, monGen = 0;
let lastNet = null, quitting = false;
let pc = null, pcSamples = [], lastPc = null;
const pcOver = { cpu: null, mem: null, temp: null };
const lastNotify = {};

// ---------- boot ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.rx09.png01netmon');
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; if (pc) pc.stop(); if (store) store.flush(); });
  app.on('window-all-closed', () => { if (!settings || !settings.closeToTray) app.quit(); });
  app.whenReady().then(start);
}

function start() {
  Menu.setApplicationMenu(null);
  store = createStore(app.getPath('userData'));
  settings = sanitize({ ...DEFAULTS, ...store.load('settings', {}) });
  history = store.load('history', []);
  events = store.load('events', []);

  createWindow();
  createTray();
  registerIpc();

  refreshGateway().then(() => monitorTick(monGen));
  refreshLink();
  speed.meta().then((m) => { linkInfo.meta = m; send('link:update', linkInfo); }).catch(() => {});
  serversTick();
  scheduleAuto();
  startPc();

  setInterval(refreshGateway, 60000);
  setInterval(() => { if (isVisible()) refreshLink(); }, 20000);
  setInterval(() => { if (isVisible()) trafficTick(); else lastNet = null; }, 2000);
  powerMonitor.on('resume', () => { refreshGateway(); refreshLink(); });
}

// ---------- window + tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 960, minHeight: 640,
    backgroundColor: '#F2F2F2', show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F2F2F2', symbolColor: '#0A0A0A', height: 40 },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
      notify('tray-hint', 'PNG-01 STILL ON DUTY', 'Monitoring continues in the system tray.', 24 * 3600e3);
    }
  });
  // PC sampler runs fast only while you can see it.
  ['show', 'hide', 'minimize', 'restore'].forEach((ev) => win.on(ev, syncPcRate));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function toggleWindow() { if (win && win.isVisible() && !win.isMinimized()) win.hide(); else showWindow(); }
const isVisible = () => win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();

const trayImg = (k) => nativeImage.createFromPath(path.join(__dirname, 'assets', `tray-${k}.png`));
function createTray() {
  tray = new Tray(trayImg('ok'));
  tray.on('click', toggleWindow);
  rebuildTrayMenu();
}
function trayTip() {
  const avg = moodState.stats.avg;
  let t = `PNG-01 // ${MOOD_LABEL[moodState.mood]}`;
  if (avg != null) t += ` // ${Math.round(avg)} MS`;
  if (lastPc) t += ` // CPU ${Math.round(lastPc.cpu)}% MEM ${Math.round(lastPc.mem.pct)}%`;
  if (lastPc && lastPc.temp != null) t += ` ${Math.round(lastPc.temp)}°C`;
  return t.slice(0, 127);
}
function rebuildTrayMenu() {
  if (!tray) return;
  const m = moodState.mood;
  tray.setImage(trayImg(m === 'offline' ? 'off' : m === 'slow' || m === 'unstable' ? 'alert' : 'ok'));
  tray.setToolTip(trayTip());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `STATUS: ${MOOD_LABEL[m]}`, enabled: false },
    { type: 'separator' },
    { label: 'Open PNG-01', click: showWindow },
    { label: 'Run speed test', enabled: !testing, click: () => { showWindow(); runSpeedTest('tray'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function notify(key, title, body, cooldownMs = 0) {
  if (!settings.alerts || !Notification.isSupported()) return;
  const t = Date.now();
  if (cooldownMs && lastNotify[key] && t - lastNotify[key] < cooldownMs) return;
  lastNotify[key] = t;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
  n.on('click', showWindow);
  n.show();
}

// ---------- settings ----------
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
const portOrNull = (p) => (p === null || p === '' || p === undefined ? null : clamp(p, 1, 65535, null));
function sanitize(s) {
  return {
    monitorTarget: sys.validHost(s.monitorTarget) ? s.monitorTarget : DEFAULTS.monitorTarget,
    monitorPort: portOrNull(s.monitorPort),
    monitorIntervalSec: clamp(s.monitorIntervalSec, 2, 60, 5),
    autoTestMin: [0, 15, 30, 60, 120].includes(+s.autoTestMin) ? +s.autoTestMin : 0,
    testDurationSec: clamp(s.testDurationSec, 5, 20, 8),
    slowPct: clamp(s.slowPct, 5, 90, 30),
    alerts: !!s.alerts,
    closeToTray: !!s.closeToTray,
    cpuAlertPct: clamp(s.cpuAlertPct, 50, 100, 90),
    memAlertPct: clamp(s.memAlertPct, 50, 100, 90),
    tempAlertC: clamp(s.tempAlertC, 40, 110, 85),
    diskFreeAlertPct: clamp(s.diskFreeAlertPct, 1, 50, 10),
    servers: Array.isArray(s.servers) ? s.servers.filter((x) => x && sys.validHost(x.host)).map((x) => ({
      id: String(x.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      name: String(x.name || x.host).toUpperCase().slice(0, 24),
      host: x.host,
      port: portOrNull(x.port)
    })) : DEFAULTS.servers
  };
}

// ---------- PC monitor ----------
function startPc() {
  pc = new PcMonitor();
  pc.on('sample', (s) => {
    lastPc = s;
    pcSamples.push(s);
    if (pcSamples.length > MAX_PC_SAMPLES) pcSamples.shift();
    send('pc:sample', s);
    checkPcAlerts(s);
    if (tray) tray.setToolTip(trayTip());
  });
  pc.start(isVisible() ? PC_RATE_VISIBLE : PC_RATE_HIDDEN);
}
function syncPcRate() { if (pc) pc.setRate(isVisible() ? PC_RATE_VISIBLE : PC_RATE_HIDDEN); }

// true once a condition has held for `ms`
function sustained(key, over, now, ms) {
  if (!over) { pcOver[key] = null; return false; }
  if (!pcOver[key]) pcOver[key] = now;
  return now - pcOver[key] >= ms;
}

function checkPcAlerts(s) {
  const now = s.t;
  if (sustained('cpu', s.cpu >= settings.cpuAlertPct, now, 60e3)) {
    notify('pc-cpu', 'CPU OVERLOAD // 過負荷', `CPU at ${Math.round(s.cpu)}% for over 1 minute.`, 10 * 60e3);
  }
  if (sustained('mem', s.mem.pct >= settings.memAlertPct, now, 60e3)) {
    notify('pc-mem', 'MEMORY HIGH // メモリ', `Memory at ${Math.round(s.mem.pct)}% (${(s.mem.used / 1073741824).toFixed(1)} GB used).`, 10 * 60e3);
  }
  if (sustained('temp', s.temp != null && s.temp >= settings.tempAlertC, now, 30e3)) {
    notify('pc-temp', 'OVERHEAT // 高温 警告', `${s.tempName || 'Sensor'} at ${Math.round(s.temp)}°C.`, 10 * 60e3);
  }
  (s.vols || []).forEach((v) => {
    const freePct = 100 - v.usedPct;
    if (freePct < settings.diskFreeAlertPct) {
      notify('pc-vol-' + v.id, 'DISK SPACE LOW // 容量不足', `${v.id} has ${(v.free / 1073741824).toFixed(1)} GB free (${freePct.toFixed(1)}%).`, 6 * 3600e3);
    }
  });
}

// ---------- live network monitor ----------
async function refreshGateway() {
  try { linkInfo.gateway = await sys.gateway(); } catch { linkInfo.gateway = null; }
}

async function monitorTick(gen) {
  if (gen !== monGen) return;
  const [wan, gw] = await Promise.all([
    sys.probe(settings.monitorTarget, settings.monitorPort, 1500),
    linkInfo.gateway ? sys.ping(linkInfo.gateway, 1000) : Promise.resolve(null)
  ]);
  if (gen !== monGen) return;

  const s = { t: Date.now(), wan: wan.ok ? wan.ms : null, gw: gw ? (gw.ok ? gw.ms : null) : undefined };
  if (gw && gw.ok) gwEverOk = true;

  if (s.wan === null) {
    failStreak++;
    if (failStreak === 3 && !outageStart) {
      outageStart = samples.length >= 2 ? samples[samples.length - 2].t : s.t;
      notify('offline', 'CONNECTION LOST // 危険', `${settings.monitorTarget} stopped responding.`, 60e3);
    }
  } else {
    if (outageStart) {
      const ev = { start: outageStart, end: s.t, target: settings.monitorTarget };
      events.unshift(ev);
      events = events.filter((e) => e.end > Date.now() - 30 * 86400e3).slice(0, 500);
      store.save('events', events);
      send('events:update', events);
      notify('online', 'BACK ONLINE', `Down for ${fmtDur(ev.end - ev.start)}.`);
      outageStart = null;
    }
    failStreak = 0;
  }

  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();
  send('monitor:sample', s);
  updateMood();
  monitorTimer = setTimeout(() => monitorTick(gen), settings.monitorIntervalSec * 1000);
}

function restartMonitor() {
  monGen++;
  clearTimeout(monitorTimer);
  failStreak = 0;
  monitorTimer = setTimeout(() => monitorTick(monGen), 300);
}

function baseline() {
  const d = history.slice(0, 10).map((h) => h.down).filter((v) => v > 0).sort((a, b) => a - b);
  return d.length >= 3 ? d[Math.floor(d.length / 2)] : null;
}

function computeMood() {
  const recent = samples.slice(-20);
  const ok = recent.filter((s) => s.wan !== null);
  const lat = ok.map((s) => s.wan);
  const loss = recent.length ? 1 - ok.length / recent.length : 0;
  let jitter = 0;
  for (let i = 1; i < lat.length; i++) jitter += Math.abs(lat[i] - lat[i - 1]);
  jitter = lat.length > 1 ? jitter / (lat.length - 1) : 0;
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  const gws = recent.filter((s) => s.gw != null).map((s) => s.gw);
  const gwAvg = gws.length ? gws.reduce((a, b) => a + b, 0) / gws.length : null;
  const stats = { loss, jitter, avg, gwAvg };

  const base = baseline();
  const last = history[0] && Date.now() - history[0].t < 2 * 3600e3 ? history[0] : null;
  const last3 = samples.slice(-3);
  const lastSample = samples[samples.length - 1];

  let mood = 'ok', diag = '';
  if (testing) mood = 'testing';
  else if (last3.length === 3 && last3.every((s) => s.wan === null)) {
    mood = 'offline';
    if (history[0] && Date.now() - history[0].t < 10 * 60e3) diag = 'ICMP MAY BE BLOCKED // SET PROBE PORT 443 IN CONFIG';
    else if (gwEverOk && lastSample && lastSample.gw != null) diag = 'UPSTREAM FAULT // ROUTER OK, INTERNET DOWN';
    else if (gwEverOk) diag = 'LOCAL LINK FAULT // CHECK WIFI OR CABLE';
    else diag = 'NO RESPONSE FROM ' + settings.monitorTarget;
  } else if (loss > 0.1 || jitter > 30) {
    mood = 'unstable';
    diag = `PACKET LOSS ${Math.round(loss * 100)}% // JITTER ${Math.round(jitter)} MS`;
  } else if ((last && base && last.down < base * (settings.slowPct / 100)) || (last && !base && last.down < 10) || (avg != null && avg > 150)) {
    mood = 'slow';
    diag = linkInfo.vpn.active ? 'VPN TUNNEL ACTIVE // MAY BE THROTTLING' : 'BANDWIDTH BELOW BASELINE';
  } else if ((last && base && last.down > base * 1.1) || (last && !base && last.down > 100)) {
    mood = 'fast';
  }
  return { mood, stats, diag, outageStart, baseline: base, testing };
}

function updateMood() {
  const prev = moodState.mood;
  moodState = computeMood();
  send('state:mood', moodState);
  if (prev !== moodState.mood) {
    rebuildTrayMenu();
    if (moodState.mood === 'unstable') notify('unstable', 'CONNECTION UNSTABLE // 不安定', moodState.diag, 10 * 60e3);
    if (moodState.mood === 'slow' && history[0]) {
      notify('slow', 'SPEED DROP // 低速', `Last test ${history[0].down} Mbps${moodState.baseline ? ` vs baseline ${moodState.baseline} Mbps` : ''}.`, 10 * 60e3);
    }
  } else if (tray) {
    tray.setToolTip(trayTip());
  }
}

// ---------- server watchlist ----------
async function serversTick() {
  clearTimeout(serverTimer);
  const list = settings.servers.slice();
  const results = await Promise.all(list.map((s) => sys.probe(s.host, s.port, 2500)));
  results.forEach((r, i) => {
    const s = list[i];
    const st = serverStatus[s.id] || (serverStatus[s.id] = { okCount: 0, total: 0, spark: [] });
    const wasOk = st.ok;
    Object.assign(st, { ok: r.ok, ms: r.ms, t: Date.now() });
    st.total++; if (r.ok) st.okCount++;
    st.spark.push(r.ok ? r.ms : null);
    if (st.spark.length > 40) st.spark.shift();
    if (wasOk === true && !r.ok) notify('srv-' + s.id, `SERVER DOWN: ${s.name}`, `${s.host}${s.port ? ':' + s.port : ''} is not responding.`, 5 * 60e3);
    if (wasOk === false && r.ok) notify('srvup-' + s.id, `SERVER BACK: ${s.name}`, `Responding in ${r.ms} ms.`);
  });
  send('servers:status', serverStatus);
  serverTimer = setTimeout(serversTick, 30000);
  return serverStatus;
}

// ---------- link / traffic ----------
async function refreshLink() {
  const [wifi, adapters] = await Promise.all([sys.wifi().catch(() => null), sys.adapters().catch(() => [])]);
  const vpn = sys.detectVpn(adapters);
  if (linkInfo.vpn.active !== vpn.active && linkInfo.t) {
    notify('vpn', vpn.active ? 'VPN CONNECTED' : 'VPN DISCONNECTED', vpn.active ? vpn.name : 'Direct connection.', 60e3);
  }
  linkInfo = { ...linkInfo, wifi, adapters, vpn, t: Date.now() };
  send('link:update', linkInfo);
  return linkInfo;
}

async function trafficTick() {
  const c = await sys.netCounters().catch(() => null);
  if (!c) return;
  const t = Date.now();
  if (lastNet && c.rx >= lastNet.rx && c.tx >= lastNet.tx) {
    const dt = (t - lastNet.t) / 1000;
    send('traffic:update', { rx: ((c.rx - lastNet.rx) * 8) / dt / 1e6, tx: ((c.tx - lastNet.tx) * 8) / dt / 1e6 });
  }
  lastNet = { ...c, t };
}

// ---------- speed test ----------
async function runSpeedTest(trigger) {
  if (testing) return { ok: false, error: 'BUSY' };
  testing = true;
  const ctrl = new AbortController();
  testAbort = ctrl;
  send('speedtest:progress', { phase: 'start', trigger });
  updateMood(); rebuildTrayMenu();
  try {
    const result = await speed.run({ signal: ctrl.signal, durationSec: settings.testDurationSec, onProgress: (p) => send('speedtest:progress', p) });
    await refreshLink().catch(() => {});
    const w = linkInfo.wifi;
    const rec = {
      t: Date.now(), trigger, ...result,
      vpn: linkInfo.vpn.active, vpnName: linkInfo.vpn.name,
      ssid: w && w.ssid ? w.ssid : null, signal: w && w.signal != null ? w.signal : null
    };
    linkInfo.meta = { ip: result.ip, isp: result.isp, colo: result.colo, city: result.city, country: result.country };
    history.unshift(rec);
    history = history.slice(0, 1000);
    store.save('history', history);
    testing = false;
    send('history:update', history);
    send('speedtest:progress', { phase: 'done', result: rec });
    return { ok: true, result: rec };
  } catch (e) {
    const error = ctrl.signal.aborted || e.name === 'AbortError' ? 'ABORTED' : String((e && e.message) || e).toUpperCase().slice(0, 120);
    send('speedtest:progress', { phase: 'error', error });
    return { ok: false, error };
  } finally {
    testing = false; testAbort = null;
    updateMood(); rebuildTrayMenu();
  }
}

function scheduleAuto() {
  clearInterval(autoTimer);
  if (settings.autoTestMin > 0) autoTimer = setInterval(() => runSpeedTest('auto'), settings.autoTestMin * 60e3);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => ({
    settings, history, samples, events, servers: serverStatus, mood: moodState, link: linkInfo,
    pc: { info: pc ? pc.info() : null, samples: pcSamples },
    version: app.getVersion(), dataPath: app.getPath('userData'), platform: process.platform
  }));
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = sanitize({ ...settings, ...(patch || {}) });
    store.save('settings', settings);
    restartMonitor(); scheduleAuto();
    send('settings:update', settings);
    return settings;
  });
  ipcMain.handle('speedtest:run', () => runSpeedTest('manual'));
  ipcMain.handle('speedtest:cancel', () => { if (testAbort) testAbort.abort(); return true; });
  ipcMain.handle('history:clear', () => {
    history = []; store.save('history', history);
    send('history:update', history); updateMood();
    return true;
  });
  ipcMain.handle('history:export', async () => {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const r = await dialog.showSaveDialog(win, { defaultPath: `png01-log-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    const cols = ['time', 'trigger', 'down_mbps', 'up_mbps', 'ping_ms', 'jitter_ms', 'isp', 'public_ip', 'colo', 'vpn', 'vpn_adapter', 'ssid', 'signal_pct'];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = history.map((h) => [new Date(h.t).toISOString(), h.trigger, h.down, h.up, h.ping, h.jitter, h.isp, h.ip, h.colo, h.vpn ? 'Y' : 'N', h.vpnName, h.ssid, h.signal].map(q).join(','));
    fs.writeFileSync(r.filePath, '\uFEFF' + [cols.join(','), ...rows].join('\r\n'));
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('sys:connections', () => sys.connections());
  ipcMain.handle('link:refresh', () => refreshLink());
  ipcMain.handle('servers:add', (_e, s) => {
    if (!s || !sys.validHost(String(s.host || '').trim())) return { ok: false, error: 'INVALID HOST' };
    settings = sanitize({ ...settings, servers: [...settings.servers, { name: s.name, host: String(s.host).trim(), port: s.port }] });
    store.save('settings', settings);
    serversTick();
    return { ok: true, servers: settings.servers };
  });
  ipcMain.handle('servers:remove', (_e, id) => {
    settings.servers = settings.servers.filter((x) => x.id !== id);
    delete serverStatus[id];
    store.save('settings', settings);
    send('servers:status', serverStatus);
    return { ok: true, servers: settings.servers };
  });
  ipcMain.handle('servers:check', () => serversTick());
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openUrl', (_e, url) => {
    if (/^https:\/\/(github\.com\/LibreHardwareMonitor|librehardwaremonitor\.net)/.test(String(url))) shell.openExternal(url);
    return true;
  });
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
