// PNG-01 NetMon — renderer. Event-driven: main pushes samples/progress/mood, we paint.
(() => {
  'use strict';
  const api = window.png01;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const RM = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const INK = '#0A0A0A', ACC = '#FF5A1F', GRAY = '#A0A3A0', HAIR = 'rgba(10,10,10,.14)';
  const FONT = '10px "JetBrains Mono", Consolas, monospace';
  const VIEWS = ['dash', 'system', 'monitor', 'servers', 'conn', 'log', 'config'];
  const GB = 1073741824;
  const LHM_URL = 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor';

  const S = {
    settings: {}, history: [], samples: [], events: [], servers: {}, link: {},
    mood: { mood: 'ok', stats: {}, diag: '' }, testing: false, view: 'dash', conns: [], traffic: null,
    pc: { info: null, samples: [] }
  };

  const MOODS = {
    fast:     { label: 'FAST',     jp: '高速',   line: 'FULL THROTTLE. LINK SATURATED WITH JOY.' },
    ok:       { label: 'NOMINAL',  jp: '正常',   line: 'ALL SYSTEMS NOMINAL. STANDING BY.' },
    slow:     { label: 'SLOW',     jp: '低速',   line: 'BANDWIDTH LOW. PUSHING HARDER...' },
    unstable: { label: 'UNSTABLE', jp: '不安定', line: 'PACKETS DROPPING. FEELING DIZZY.' },
    offline:  { label: 'OFFLINE',  jp: '危険',   line: 'NO SIGNAL. ENTERING SLEEP MODE.' },
    testing:  { label: 'TESTING',  jp: '測定中', line: 'MEASURING. STAND CLEAR FROM THIS AREA.' }
  };

  // ---------- format ----------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`; };
  const fmtDate = (t) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const fmtMbps = (v) => (v == null || !isFinite(v) ? '---' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  const fmtMs = (v) => (v == null || !isFinite(v) ? '---' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const fmtPct = (v) => (v == null || !isFinite(v) ? '---' : v >= 99.95 ? '100' : v.toFixed(1));
  const fmtGB = (b) => (b == null ? '--' : (b / GB >= 100 ? (b / GB).toFixed(0) : (b / GB).toFixed(1)) + ' GB');
  const fmtRate = (b) => (b == null ? '--' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/S' : (b / 1024).toFixed(0) + ' KB/S');
  const fmtDur = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}S`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}M ${pad(s % 60)}S` : `${Math.floor(m / 60)}H ${pad(m % 60)}M`;
  };
  const fmtUptime = (sec) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}D ${pad(h)}H ${pad(m)}M` : `${pad(h)}H ${pad(m)}M`;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const scaleLog = (v) => Math.min(1, Math.log10(1 + Math.max(0, v || 0)) / Math.log10(1001));

  // ---------- seven-segment helpers ----------
  const seg = (id, txt, min) => Seg.render(typeof id === 'string' ? $(id) : id, txt, { min });
  function countUp(id, to, fmt, min) {
    if (to == null || RM()) return seg(id, fmt(to), min);
    const t0 = performance.now(), d = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / d);
      seg(id, fmt(to * (1 - Math.pow(1 - k, 3))), min);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 20-cell bar meter; cells at/over `hotFrom` (0..1) turn orange
  function bar20(el, frac, hotFrom = 0.8) {
    const n = Math.round(Math.max(0, Math.min(1, frac || 0)) * 20);
    const key = n + '|' + hotFrom;
    if (el._b === key) return;
    el._b = key;
    el.innerHTML = Array.from({ length: 20 }, (_, i) => `<i class="${i < n ? (i >= Math.round(hotFrom * 20) ? 'hot' : 'on') : ''}"></i>`).join('');
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    $('#toast-msg').textContent = msg;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
  }

  // ---------- gauge (log scale 0–1000 Mbps, 270° sweep) ----------
  function createGauge(host) {
    const cx = 150, cy = 150, r = 118;
    const P = (a, rr = r) => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
    const [sx, sy] = P(135), [ex, ey] = P(45);
    const arc = `M${sx.toFixed(2)} ${sy.toFixed(2)} A${r} ${r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
    const L = r * 1.5 * Math.PI;
    let ticks = '';
    for (let i = 0; i <= 54; i++) {
      const a = 135 + (270 * i) / 54;
      const [x1, y1] = P(a, r - 10), [x2, y2] = P(a, r - 15);
      ticks += `<line class="g-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000].forEach((v) => {
      const a = 135 + 270 * scaleLog(v);
      const [x1, y1] = P(a, r - 8), [x2, y2] = P(a, r - 22), [lx, ly] = P(a, r - 34);
      ticks += `<line class="g-tick major" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      ticks += `<text class="g-lbl" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle">${v >= 1000 ? '1K' : v}</text>`;
    });
    host.innerHTML = `<svg viewBox="0 0 300 250" role="img" aria-label="Speed gauge">
      <path d="${arc}" class="g-track"/>
      <path d="${arc}" class="g-fill" stroke-dasharray="${L.toFixed(1)}" stroke-dashoffset="${L.toFixed(1)}"/>
      ${ticks}
      <g class="g-needle" style="transform:rotate(135deg)"><polygon points="150,146 ${150 + r - 28},150 150,154"/></g>
      <rect class="g-hub" x="143" y="143" width="14" height="14" transform="rotate(45 150 150)"/>
      <text class="g-val" x="150" y="212" text-anchor="middle">0.00</text>
      <text class="g-unit" x="150" y="228" text-anchor="middle">MBPS</text>
    </svg>`;
    const fill = $('.g-fill', host), needle = $('.g-needle', host), val = $('.g-val', host);
    return {
      set(v) {
        const f = scaleLog(v);
        fill.style.strokeDashoffset = String(L * (1 - f));
        needle.style.transform = `rotate(${135 + 270 * f}deg)`;
        val.textContent = fmtMbps(v);
      }
    };
  }
  let gauge;

  // ---------- canvas helpers ----------
  function fit(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    return { ctx, W: w, H: h };
  }

  function grid(ctx, pl, pt, pw, ph, W, max, rows = 4, suffix = '') {
    ctx.strokeStyle = HAIR; ctx.lineWidth = 1; ctx.fillStyle = INK; ctx.textAlign = 'right';
    for (let i = 0; i <= rows; i++) {
      const yy = Math.round(pt + (ph * i) / rows) + 0.5;
      ctx.beginPath(); ctx.moveTo(pl, yy); ctx.lineTo(pl + pw, yy); ctx.stroke();
      ctx.fillText(String(Math.round(max * (1 - i / rows))) + suffix, pl - 6, yy + 3);
    }
    ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(pl + 0.5, pt); ctx.lineTo(pl + 0.5, pt + ph); ctx.stroke();
  }

  function series(ctx, data, get, x, y, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'miter'; ctx.setLineDash(dash || []); ctx.beginPath();
    let pen = false;
    data.forEach((s, i) => {
      const v = get(s);
      if (v == null) { pen = false; return; }
      if (!pen) { ctx.moveTo(x(i), y(v)); pen = true; } else ctx.lineTo(x(i), y(v));
    });
    ctx.stroke(); ctx.setLineDash([]);
  }

  function drawLatency(cv, n) {
    const f = fit(cv); if (!f) return;
    const { ctx, W, H } = f;
    const data = S.samples.slice(-n);
    const pl = 38, pr = 10, pt = 8, pb = 18, pw = W - pl - pr, ph = H - pt - pb;
    const vals = [];
    data.forEach((s) => { if (s.wan != null) vals.push(s.wan); if (s.gw != null) vals.push(s.gw); });
    const max = Math.ceil((Math.max(40, pct(vals, 0.98) || 0) * 1.2) / 20) * 20;
    const y = (v) => pt + ph - (Math.min(v, max) / max) * ph;
    const off = n - data.length;
    const x = (i) => pl + (pw * (i + off)) / Math.max(1, n - 1);

    grid(ctx, pl, pt, pw, ph, W, max);
    const bw = Math.max(2, pw / n);
    ctx.fillStyle = ACC;
    data.forEach((s, i) => { if (s.wan == null) ctx.fillRect(x(i) - bw / 2, pt, bw, ph); });
    series(ctx, data, (s) => s.gw, x, y, GRAY, 1);
    series(ctx, data, (s) => s.wan, x, y, INK, 1.5);

    const last = data[data.length - 1];
    if (last && last.wan != null) {
      const lx = x(data.length - 1), ly = y(last.wan);
      ctx.fillStyle = ACC; ctx.fillRect(lx - 4, ly - 4, 8, 8);
      ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(lx - 3.5, ly - 3.5, 7, 7);
    }
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    if (data[0]) ctx.fillText(fmtTime(data[0].t), x(0), H - 4);
    ctx.textAlign = 'right'; ctx.fillText('NOW_', W - pr, H - 4);
    if (!data.length) { ctx.textAlign = 'center'; ctx.fillText('// AWAITING SAMPLES', pl + pw / 2, pt + ph / 2); }
  }

  // CPU / MEM / DISK in %, TEMP in °C — all share the 0–100 axis.
  function drawLoad(cv) {
    const f = fit(cv); if (!f) return;
    const { ctx, W, H } = f;
    const n = 150;
    const data = S.pc.samples.slice(-n);
    const pl = 38, pr = 10, pt = 8, pb = 18, pw = W - pl - pr, ph = H - pt - pb;
    const y = (v) => pt + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;
    const off = n - data.length;
    const x = (i) => pl + (pw * (i + off)) / (n - 1);
    grid(ctx, pl, pt, pw, ph, W, 100);

    const th = S.settings.cpuAlertPct;
    if (th) {
      ctx.strokeStyle = ACC; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(pl, y(th)); ctx.lineTo(W - pr, y(th)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.fillText(`CPU ALERT ${th}%`, W - pr - 4, y(th) - 5);
    }
    series(ctx, data, (s) => (s.disk ? s.disk.active : null), x, y, INK, 1, [3, 3]);
    series(ctx, data, (s) => s.mem.pct, x, y, GRAY, 2);
    series(ctx, data, (s) => s.temp, x, y, ACC, 1.5);
    series(ctx, data, (s) => s.cpu, x, y, INK, 2);

    ctx.fillStyle = INK; ctx.textAlign = 'left';
    if (data[0]) ctx.fillText(fmtTime(data[0].t), x(0), H - 4);
    ctx.textAlign = 'right'; ctx.fillText('NOW_', W - pr, H - 4);
    if (!data.length) { ctx.textAlign = 'center'; ctx.fillText('// AWAITING SAMPLES', pl + pw / 2, pt + ph / 2); }
  }

  function drawTimeline(cv) {
    const f = fit(cv); if (!f) return;
    const { ctx, W, H } = f;
    const now = Date.now(), span = 24 * 3600e3, t0 = now - span;
    const x = (t) => ((t - t0) / span) * W;
    const top = 6, bh = H - 26;
    ctx.fillStyle = INK; ctx.fillRect(0, top + bh / 2, W, 1);
    if (S.samples[0]) ctx.fillRect(x(S.samples[0].t), top + bh / 2 - 3, W - x(S.samples[0].t), 7);
    ctx.fillStyle = ACC;
    S.events.forEach((e) => { if (e.end > t0) { const a = x(Math.max(e.start, t0)); ctx.fillRect(a, top, Math.max(3, x(e.end) - a), bh); } });
    if (S.mood.outageStart) { const a = x(S.mood.outageStart); ctx.fillRect(a, top, Math.max(3, W - a), bh); }
    ctx.fillStyle = INK; ctx.textAlign = 'center';
    for (let h = 0; h <= 24; h += 3) {
      const t = t0 + h * 3600e3, xx = Math.round(x(t)) + 0.5;
      ctx.fillRect(xx, top + bh, 1, 5);
      const d = new Date(t);
      ctx.fillText(h === 24 ? 'NOW' : `${pad(d.getHours())}:${pad(d.getMinutes())}`, Math.min(W - 14, Math.max(14, xx)), H - 3);
    }
  }

  function drawLog(cv) {
    const f = fit(cv); if (!f) return;
    const { ctx, W, H } = f;
    const data = S.history.slice(0, 40).reverse();
    const pl = 42, pr = 10, pt = 10, pb = 20, pw = W - pl - pr, ph = H - pt - pb;
    const max = Math.ceil((Math.max(10, ...data.map((d) => Math.max(d.down, d.up))) * 1.15) / 10) * 10;
    const y = (v) => pt + ph - (v / max) * ph;
    grid(ctx, pl, pt, pw, ph, W, max);
    if (!data.length) { ctx.textAlign = 'center'; ctx.fillText('// NO TESTS LOGGED · RUN A TEST FROM [DASH]', pl + pw / 2, pt + ph / 2); return; }
    const slot = pw / 40, bw = Math.max(3, slot * 0.38);
    data.forEach((d, i) => {
      const xx = pl + slot * i + slot * 0.1;
      ctx.fillStyle = INK; ctx.fillRect(xx, y(d.down), bw, pt + ph - y(d.down));
      ctx.fillStyle = GRAY; ctx.fillRect(xx + bw + 1, y(d.up), bw, pt + ph - y(d.up));
    });
    const base = S.mood.baseline;
    if (base) {
      ctx.strokeStyle = ACC; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(pl, y(base)); ctx.lineTo(W - pr, y(base)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.fillText(`BASE ${fmtMbps(base)}`, pl + 4, y(base) - 5);
    }
    ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.fillText(fmtDate(data[0].t) + ' ' + fmtTime(data[0].t), pl, H - 4);
    ctx.textAlign = 'right'; ctx.fillText('LATEST', W - pr, H - 4);
  }

  // ---------- views ----------
  function go(v) {
    S.view = v;
    $$('.nav-btn').forEach((b) => {
      const on = b.dataset.view === v;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.view').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
    if (v === 'system') renderSystem();
    paint();
    if (v === 'conn' && !S.conns.length) scanConns();
  }

  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (S.view === 'dash') drawLatency($('#chart-dash'), 120);
      if (S.view === 'system') drawLoad($('#chart-sys'));
      if (S.view === 'monitor') { drawLatency($('#chart-mon'), Math.min(720, Math.max(120, S.samples.length))); drawTimeline($('#timeline')); renderMonitorStats(); }
      if (S.view === 'log') drawLog($('#chart-log'));
    });
  }

  function renderMood() {
    const m = S.mood.mood || 'ok';
    document.documentElement.dataset.mood = m;
    document.documentElement.classList.toggle('is-testing', m === 'testing' || S.testing);
    const M = MOODS[m] || MOODS.ok;
    $('#mood-label').textContent = M.label;
    $('#mood-jp').textContent = M.jp;
    $('#mood-line').textContent = M.line;
    $('#hdr-status-text').textContent = M.label;
    const st = S.mood.stats || {};
    seg('#seg-loss', st.loss != null ? String(Math.round(st.loss * 100)) : '---', 3);
    $('#baseline').textContent = S.mood.baseline ? fmtMbps(S.mood.baseline) : 'CALIBRATING';
    $('#log-base').textContent = S.mood.baseline ? fmtMbps(S.mood.baseline) : '--';
    $('#k-diag').textContent = S.mood.diag || 'NO FAULTS';
  }

  function showResult(r, animate) {
    if (!r) {
      ['#seg-down', '#seg-up', '#seg-ping', '#seg-jitter'].forEach((id) => seg(id, '---', id === '#seg-down' ? 4 : 3));
      return;
    }
    const f = animate ? countUp : (id, v, fmt, min) => seg(id, fmt(v), min);
    f('#seg-down', r.down, fmtMbps, 4);
    f('#seg-up', r.up, fmtMbps, 3);
    f('#seg-ping', r.ping, fmtMs, 3);
    f('#seg-jitter', r.jitter, fmtMs, 3);
    $('#last-time').textContent = fmtDate(r.t) + ' ' + fmtTime(r.t);
    $('#colo').textContent = r.colo || '--';
    if (gauge) gauge.set(r.down);
  }

  function renderLink() {
    const L = S.link || {}, w = L.wifi, m = L.meta || {};
    if (w && w.ssid) {
      $('#k-wifi').innerHTML = `${esc(w.ssid)} <span class="dim">${w.signal != null ? w.signal + '%' : ''}${w.rx ? ' · ' + w.rx + 'M' : ''}</span>`;
    } else $('#k-wifi').textContent = w && w.state ? String(w.state).toUpperCase() : 'WIRED / N/A';
    const bars = Math.round(((w && w.signal) || 0) / 10);
    $('#wifi-meter').innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${i < bars ? 'on' : ''}" style="height:${30 + i * 7}%"></i>`).join('');
    $('#k-vpn').innerHTML = L.vpn && L.vpn.active ? `<span class="tag tag-ink">ACTIVE</span><span class="dim">${esc(L.vpn.name)}</span>` : '<span class="tag">OFF</span>';
    const lastGw = [...S.samples].reverse().find((s) => s.gw != null);
    $('#k-gw').innerHTML = L.gateway ? `${esc(L.gateway)} <span class="dim">${lastGw ? fmtMs(lastGw.gw) + ' MS' : 'NO REPLY'}</span>` : '--';
    $('#k-isp').textContent = m.isp ? String(m.isp).toUpperCase() : '--';
    $('#k-ip').innerHTML = m.ip ? `${esc(m.ip)} <span class="dim">${esc([m.city, m.country].filter(Boolean).join(' / ').toUpperCase())}</span>` : '--';
  }

  function renderTraffic() {
    const t = S.traffic;
    bar20($('#rx-bar'), scaleLog(t ? t.rx : 0));
    bar20($('#tx-bar'), scaleLog(t ? t.tx : 0));
    $('#rx-val').textContent = t ? fmtMbps(t.rx) + ' M' : '--';
    $('#tx-val').textContent = t ? fmtMbps(t.tx) + ' M' : '--';
  }

  // ---------- SYSTEM ----------
  function renderSysMini(p) {
    const st = S.settings;
    const set = (id, txt, hot) => { const el = $(id); el.textContent = txt; el.classList.toggle('hot', !!hot); };
    set('#sm-cpu', p ? Math.round(p.cpu) + '%' : '--', p && p.cpu >= st.cpuAlertPct);
    set('#sm-mem', p ? Math.round(p.mem.pct) + '%' : '--', p && p.mem.pct >= st.memAlertPct);
    set('#sm-temp', p && p.temp != null ? Math.round(p.temp) + '°' : '--', p && p.temp != null && p.temp >= st.tempAlertC);
  }

  function renderSystem() {
    const info = S.pc.info, st = S.settings;
    const smp = S.pc.samples, p = smp[smp.length - 1];
    if (info) {
      $('#sys-host').textContent = String(info.host).toUpperCase();
      $('#sys-cpu-model').textContent = String(info.cpuModel).toUpperCase();
      $('#sys-cores').textContent = info.cores;
      $('#sys-ram').textContent = fmtGB(info.totalMem);
    }
    $('#cpu-th').textContent = st.cpuAlertPct + '%';
    $('#vol-th').textContent = st.diskFreeAlertPct;
    $('#temp-th').textContent = st.tempAlertC;
    if (!p) return;
    $('#sys-uptime').textContent = fmtUptime(p.uptime);

    // big readouts
    const cpuHot = p.cpu >= st.cpuAlertPct, memHot = p.mem.pct >= st.memAlertPct;
    const tHot = p.temp != null && p.temp >= st.tempAlertC;
    const dHot = p.disk.active != null && p.disk.active >= 90;
    $('#sb-cpu').classList.toggle('alert', cpuHot);
    $('#sb-mem').classList.toggle('alert', memHot);
    $('#sb-disk').classList.toggle('alert', dHot);
    $('#sb-temp').classList.toggle('alert', tHot);

    seg('#seg-cpu', fmtPct(p.cpu), 4);
    bar20($('#bar-cpu'), p.cpu / 100, st.cpuAlertPct / 100);
    const recent = smp.filter((s) => s.t > p.t - 60000).map((s) => s.cpu);
    $('#cpu-peak').textContent = recent.length ? Math.round(Math.max(...recent)) + '%' : '--';

    seg('#seg-mem', fmtPct(p.mem.pct), 4);
    bar20($('#bar-mem'), p.mem.pct / 100, st.memAlertPct / 100);
    $('#mem-used').textContent = `${fmtGB(p.mem.used)} / ${fmtGB(p.mem.total)}`;
    $('#mem-free').textContent = fmtGB(p.mem.total - p.mem.used);

    seg('#seg-disk', p.disk.active == null ? '---' : fmtPct(p.disk.active), 4);
    bar20($('#bar-disk'), (p.disk.active || 0) / 100, 0.9);
    $('#disk-rd').textContent = p.disks.length ? fmtRate(p.disk.rd) : 'N/A';
    $('#disk-wr').textContent = p.disks.length ? fmtRate(p.disk.wr) : 'N/A';

    seg('#seg-temp', p.temp == null ? '---' : p.temp.toFixed(1), 4);
    bar20($('#bar-temp'), (p.temp || 0) / 110, st.tempAlertC / 110);
    $('#temp-name').textContent = p.tempName || (p.tsrc === 'PENDING' ? 'READING...' : 'NO SENSOR');
    $('#temp-src').textContent = p.tsrc;

    // per-core meters
    $('#core-count').textContent = `${p.cores.length} LOGICAL`;
    const host = $('#cores');
    if (host.children.length !== p.cores.length) {
      host.innerHTML = p.cores.map((_, i) => `<div class="core"><div class="cm"><i></i></div><span>${pad(i)}</span></div>`).join('');
    }
    p.cores.forEach((v, i) => {
      const bar = host.children[i].firstChild.firstChild;
      bar.style.height = v + '%';
      bar.classList.toggle('hot', v >= st.cpuAlertPct);
    });

    // volumes
    $('#vol-body').innerHTML = p.vols.length ? p.vols.map((v) => {
      const freePct = 100 - v.usedPct, low = freePct < st.diskFreeAlertPct;
      return `<tr>
        <td><span class="lamp ${low ? 'down' : 'ok'}" title="${low ? 'LOW SPACE' : 'OK'}"></span></td>
        <td><b>${esc(v.id)}</b></td><td>${esc(String(v.label || '--').toUpperCase())}</td>
        <td><span class="ubar"><i class="${low ? 'hot' : ''}" style="width:${v.usedPct}%"></i></span></td>
        <td class="num">${v.usedPct.toFixed(1)}%</td><td class="num">${fmtGB(v.free)}</td><td class="num">${fmtGB(v.size)}</td></tr>`;
    }).join('') : `<tr class="empty"><td colspan="7">// ${p.tsrc === 'PENDING' ? 'READING VOLUMES...' : 'NO DATA (WINDOWS ONLY)'}</td></tr>`;

    // physical disks
    $('#pdisk-body').innerHTML = p.disks.length ? p.disks.map((d) => `<tr>
      <td><b>${esc(d.n)}</b></td>
      <td><span class="ubar"><i class="${d.active >= 90 ? 'hot' : ''}" style="width:${d.active}%"></i></span></td>
      <td class="num">${fmtRate(d.rd)}</td><td class="num">${fmtRate(d.wr)}</td><td class="num">${d.q}</td></tr>`).join('')
      : `<tr class="empty"><td colspan="5">// ${p.tsrc === 'PENDING' ? 'READING DISKS...' : 'NO DATA (WINDOWS ONLY)'}</td></tr>`;

    // thermal sensors
    $('#sensors').innerHTML = p.temps.length ? p.temps.map((t) => {
      const hot = t.c >= st.tempAlertC;
      return `<div class="sensor ${hot ? 'hot' : ''}">
        <span class="kind k-${t.kind}">${t.kind}</span>
        <span class="sn">${esc(t.n)}<small>${esc(t.hw)}</small></span>
        <span class="ubar"><i class="${hot ? 'hot' : ''}" style="width:${Math.min(100, (t.c / 110) * 100)}%"></i></span>
        <b>${t.c.toFixed(1)}°</b></div>`;
    }).join('') : '';
    renderTempNote(p.tsrc, p.temps.length);
  }

  function renderTempNote(src, n) {
    const note = $('#temp-note');
    let msg = '';
    if (src === 'PENDING') msg = 'READING SENSORS... 温度センサー確認中';
    else if (src === 'ACPI') msg = 'SOURCE = ACPI THERMAL ZONE. THIS IS A MOTHERBOARD ESTIMATE, NOT THE CPU DIE, AND ON MANY PCS IT NEVER CHANGES. FOR REAL CPU / GPU / SSD TEMPS RUN LIBREHARDWAREMONITOR (AS ADMIN) — PNG-01 PICKS IT UP AUTOMATICALLY WITHIN 60S.';
    else if (src === 'NONE' || src === 'UNAVAILABLE' || !n) msg = 'NO TEMPERATURE SENSOR READABLE WITHOUT HELP. RUN LIBREHARDWAREMONITOR (AS ADMIN) TO EXPOSE CPU / GPU / SSD SENSORS VIA WMI — PNG-01 PICKS IT UP AUTOMATICALLY WITHIN 60S.' + (src === 'UNAVAILABLE' ? ' DISK SAMPLER ALSO FAILED TO START (POWERSHELL BLOCKED?).' : '');
    note.hidden = !msg;
    if (!msg) return;
    const key = src + n;
    if (note._k === key) return;
    note._k = key;
    note.innerHTML = `<div class="hazard" aria-hidden="true"></div><p>${esc(msg)}${src === 'PENDING' ? '' : ' <a href="#" id="lhm-link">[ GET LIBREHARDWAREMONITOR ]</a>'}</p>`;
  }

  // ---------- MONITOR ----------
  function renderMonitorStats() {
    const data = S.samples.slice(-720);
    const wan = data.filter((s) => s.wan != null).map((s) => s.wan);
    const gw = data.filter((s) => s.gw != null).map((s) => s.gw);
    const loss = data.length ? (1 - wan.length / data.length) * 100 : null;
    const day = Date.now() - 86400e3;
    const ev = S.events.filter((e) => e.end > day);
    const down = ev.reduce((a, e) => a + (e.end - Math.max(e.start, day)), 0);
    const st = S.mood.stats || {};
    const cells = [
      ['WAN AVG', 'MS', fmtMs(mean(wan)), false],
      ['WAN P95', 'MS', fmtMs(pct(wan, 0.95)), (pct(wan, 0.95) || 0) > 150],
      ['WAN MIN', 'MS', fmtMs(wan.length ? Math.min(...wan) : null), false],
      ['GW AVG', 'MS', fmtMs(mean(gw)), (mean(gw) || 0) > 20],
      ['JITTER', 'MS', fmtMs(st.jitter), (st.jitter || 0) > 30],
      ['LOSS', '%', loss == null ? '---' : loss.toFixed(1), (loss || 0) > 2],
      ['DROPS 24H', 'N', String(ev.length + (S.mood.outageStart ? 1 : 0)), ev.length > 0],
      ['DOWN 24H', 'MIN', (down / 60000).toFixed(1), down > 0]
    ];
    const host = $('#mon-stats');
    if (host.children.length !== cells.length) {
      host.innerHTML = cells.map((c, i) => `<div class="cell stat" data-i="${i}"><div class="cell-label"><span>${c[0]}</span><span>${c[1]}</span></div><div class="seg seg-md" role="img"></div></div>`).join('');
    }
    cells.forEach((c, i) => {
      const el = host.children[i];
      el.classList.toggle('alert', !!c[3]);
      Seg.render($('.seg', el), c[2], { min: 3 });
    });
  }

  function renderEvents() {
    const tb = $('#events-body');
    $('#ev-count').textContent = `${S.events.length} EVENTS`;
    tb.innerHTML = S.events.length
      ? S.events.slice(0, 200).map((e) => `<tr><td>${fmtDate(e.start)} ${fmtTime(e.start)}</td><td>${fmtTime(e.end)}</td><td class="num">${fmtDur(e.end - e.start)}</td><td>${esc(e.target)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="4">// NO OUTAGES RECORDED · 正常</td></tr>';
  }

  function sparkSvg(arr) {
    const n = 40, w = 120, h = 18;
    const vals = arr.filter((v) => v != null);
    const max = Math.max(5, ...vals);
    const off = n - arr.length;
    let pts = '', drops = '';
    arr.forEach((v, i) => {
      const x = ((i + off) / (n - 1)) * w;
      if (v == null) drops += `<rect x="${(x - 1).toFixed(1)}" y="0" width="2" height="${h}"/>`;
      else pts += `${x.toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)} `;
    });
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${drops}<polyline points="${pts.trim()}"/></svg>`;
  }

  function renderServers() {
    const list = S.settings.servers || [];
    $('#srv-count').textContent = `${list.length} NODES`;
    $('#srv-body').innerHTML = list.length ? list.map((s) => {
      const st = S.servers[s.id] || {};
      const lamp = st.ok === true ? 'ok' : st.ok === false ? 'down' : '';
      const up = st.total ? ((st.okCount / st.total) * 100).toFixed(1) + '%' : '--';
      return `<tr>
        <td><span class="lamp ${lamp}" title="${lamp ? lamp.toUpperCase() : 'PENDING'}"></span></td>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.host)}${s.port ? ':' + s.port : ''}</td>
        <td>${s.port ? 'TCP' : 'ICMP'}</td>
        <td class="num">${st.ok ? fmtMs(st.ms) : st.ok === false ? 'TIMEOUT' : '...'}</td>
        <td class="num">${up}</td>
        <td>${sparkSvg(st.spark || [])}</td>
        <td><button class="btn btn-del" data-del="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">[X]</button></td>
      </tr>`;
    }).join('') : '<tr class="empty"><td colspan="8">// NO NODES REGISTERED</td></tr>';
  }

  async function scanConns() {
    $('#conn-status').textContent = 'SCANNING...';
    const r = await api.invoke('sys:connections').catch(() => null);
    if (r === null) { $('#conn-status').textContent = 'WINDOWS ONLY'; S.conns = []; renderConns(); return; }
    S.conns = r;
    $('#conn-status').textContent = `SCANNED ${fmtTime(Date.now())}`;
    renderConns();
  }

  function renderConns() {
    const q = $('#conn-filter').value.trim().toLowerCase();
    const rows = S.conns.filter((c) => !q || `${c.p} ${c.id} ${c.l} ${c.r}`.toLowerCase().includes(q))
      .sort((a, b) => String(a.p).localeCompare(String(b.p)));
    const counts = {};
    rows.forEach((c) => { counts[c.p || 'UNKNOWN'] = (counts[c.p || 'UNKNOWN'] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const max = top.length ? top[0][1] : 1;
    $('#conn-bars').innerHTML = top.length
      ? top.map(([p, n]) => `<div class="hbar"><span>${esc(String(p).toUpperCase())}</span><span class="track"><span class="fill" style="display:block;width:${(n / max) * 100}%"></span></span><b>${n}</b></div>`).join('')
      : '<p class="micro dim">// NO DATA</p>';
    $('#conn-count').textContent = `${rows.length} LINKS`;
    $('#conn-body').innerHTML = rows.length
      ? rows.slice(0, 500).map((c) => `<tr><td><b>${esc(String(c.p || '?').toUpperCase())}</b></td><td class="num">${esc(c.id)}</td><td>${esc(c.l)}</td><td>${esc(c.r)}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="4">// NO ESTABLISHED CONNECTIONS</td></tr>';
  }

  function renderLog() {
    $('#log-count').textContent = String(S.history.length);
    $('#log-body').innerHTML = S.history.length ? S.history.slice(0, 300).map((h) => `<tr>
      <td>${fmtDate(h.t)} ${fmtTime(h.t)}</td><td class="num"><b>${fmtMbps(h.down)}</b></td><td class="num">${fmtMbps(h.up)}</td>
      <td class="num">${fmtMs(h.ping)}</td><td class="num">${fmtMs(h.jitter)}</td><td>${esc(String(h.isp || '--').toUpperCase())}</td>
      <td>${h.vpn ? '[X]' : '[ ]'}</td><td>${esc(h.ssid || '--')}</td><td>${esc(String(h.trigger || '').toUpperCase())}</td></tr>`).join('')
      : '<tr class="empty"><td colspan="9">// LOG EMPTY</td></tr>';
    paint();
  }

  const CFG_NUM = ['monitorIntervalSec', 'autoTestMin', 'testDurationSec', 'slowPct', 'cpuAlertPct', 'memAlertPct', 'tempAlertC', 'diskFreeAlertPct'];
  function renderSettings() {
    const s = S.settings, f = $('#cfg-form');
    f.monitorTarget.value = s.monitorTarget || '';
    f.monitorPort.value = s.monitorPort || '';
    CFG_NUM.forEach((k) => { f[k].value = String(s[k]); });
    f.alerts.checked = !!s.alerts;
    f.closeToTray.checked = !!s.closeToTray;
    const tgt = s.monitorTarget + (s.monitorPort ? ':' + s.monitorPort : '');
    $('#mon-target').textContent = tgt;
    $('#mon-target2').textContent = tgt;
    $('#mon-method').textContent = s.monitorPort ? 'TCP' : 'ICMP';
    $('#mon-int').textContent = s.monitorIntervalSec + 'S';
  }

  // ---------- ticker + clock ----------
  function renderTicker() {
    const last = S.samples[S.samples.length - 1];
    const h = S.history[0];
    const p = S.pc.samples[S.pc.samples.length - 1];
    const items = [
      'PNG-01 ON DUTY',
      `WAN <em>${last && last.wan != null ? fmtMs(last.wan) + 'MS' : 'NO REPLY'}</em>`,
      `GW ${last && last.gw != null ? fmtMs(last.gw) + 'MS' : '--'}`,
      `VPN ${S.link.vpn && S.link.vpn.active ? '<em>ACTIVE</em>' : 'OFF'}`,
      h ? `LAST TEST ${fmtMbps(h.down)}▼ / ${fmtMbps(h.up)}▲ MBPS` : 'NO TEST LOGGED',
      p ? `CPU <em>${Math.round(p.cpu)}%</em> MEM ${Math.round(p.mem.pct)}%${p.temp != null ? ` TEMP ${Math.round(p.temp)}°C` : ''}` : 'SYS --',
      `STATUS <em>${(MOODS[S.mood.mood] || MOODS.ok).label}</em>`,
      'SECURITY PROTOCOL ACTIVE', '想像力を動力源', 'GO STRAIGHT OR RIGHT', 'CLASS GRM-976', 'BATTERY CHARGED +5HP'
    ].map((t) => `<span>${t} //</span>`).join('');
    $('#ticker').innerHTML = items + items;
  }

  function startClock() {
    const tick = () => { $('#clock').textContent = fmtTime(Date.now()); };
    tick(); setInterval(tick, 1000);
  }

  // ---------- speed test UI ----------
  function setPhase(t) { $('#phase').textContent = t; }
  function setProg(p) { $('#prog-bar').style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; }
  function setTesting(on) {
    S.testing = on;
    document.documentElement.classList.toggle('is-testing', on);
    $('#btn-test').textContent = on ? '[ ABORT ]' : '[ RUN TEST ]';
  }

  function onProgress(p) {
    switch (p.phase) {
      case 'start':
        setTesting(true); setProg(0); gauge.set(0);
        ['#seg-down', '#seg-up', '#seg-ping', '#seg-jitter'].forEach((id) => seg(id, '---', id === '#seg-down' ? 4 : 3));
        setPhase(`// 00 HANDSHAKE${p.trigger !== 'manual' ? ' · ' + String(p.trigger).toUpperCase() : ''}`);
        break;
      case 'meta': setPhase('// 00 LOCATING NODE'); break;
      case 'latency': setPhase('// 01 LATENCY PROBE'); seg('#seg-ping', fmtMs(p.value), 3); setProg(p.pct * 0.1); break;
      case 'download': setPhase('// 02 DOWNLOAD ▼ 4 STREAMS'); gauge.set(p.value); seg('#seg-down', fmtMbps(p.value), 4); setProg(0.1 + p.pct * 0.45); break;
      case 'upload': setPhase('// 03 UPLOAD ▲ 3 STREAMS'); gauge.set(p.value); seg('#seg-up', fmtMbps(p.value), 3); setProg(0.55 + p.pct * 0.45); break;
      case 'done':
        setTesting(false); setProg(1); showResult(p.result, true);
        setPhase(`// COMPLETE · ${fmtMbps(p.result.down)} ▼ ${fmtMbps(p.result.up)} ▲ · LOGGED`);
        S.link.meta = { ip: p.result.ip, isp: p.result.isp, colo: p.result.colo, city: p.result.city, country: p.result.country };
        renderLink(); renderTicker();
        break;
      case 'error':
        setTesting(false); setProg(0); showResult(S.history[0], false);
        setPhase(`// FAULT · ${p.error}`);
        if (p.error !== 'ABORTED') toast(`SPEED TEST FAILED: ${p.error}. CHECK THAT SPEED.CLOUDFLARE.COM IS REACHABLE (PROXY / FIREWALL).`);
        break;
    }
  }

  // ---------- bindings ----------
  function bind() {
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
    document.addEventListener('keydown', (e) => { if (e.altKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); go(VIEWS[+e.key - 1]); } });

    $('#btn-test').addEventListener('click', () => {
      if (S.testing) api.invoke('speedtest:cancel');
      else api.invoke('speedtest:run');
    });

    $('#temp-note').addEventListener('click', (e) => {
      if (e.target.id === 'lhm-link') { e.preventDefault(); api.invoke('app:openUrl', LHM_URL); }
    });

    $('#srv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const host = $('#srv-host').value.trim();
      const r = await api.invoke('servers:add', { name: $('#srv-name').value.trim() || host, host, port: $('#srv-port').value || null });
      if (!r.ok) return toast(r.error || 'INVALID NODE');
      S.settings.servers = r.servers;
      e.target.reset(); renderServers();
    });
    $('#btn-srv-check').addEventListener('click', () => api.invoke('servers:check'));
    $('#srv-body').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del]'); if (!b) return;
      const r = await api.invoke('servers:remove', b.dataset.del);
      S.settings.servers = r.servers; renderServers();
    });

    $('#btn-scan').addEventListener('click', scanConns);
    $('#conn-filter').addEventListener('input', renderConns);

    $('#btn-export').addEventListener('click', async () => {
      const r = await api.invoke('history:export');
      if (r && r.ok) toast(`EXPORTED // ${r.path}`);
    });
    $('#btn-clear').addEventListener('click', async () => {
      if (!window.confirm('CLEAR ALL SPEED TEST RECORDS? THIS ALSO RESETS THE BASELINE.')) return;
      await api.invoke('history:clear');
    });

    $('#cfg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const patch = { monitorTarget: f.monitorTarget.value.trim(), monitorPort: f.monitorPort.value || null, alerts: f.alerts.checked, closeToTray: f.closeToTray.checked };
      CFG_NUM.forEach((k) => { patch[k] = +f[k].value; });
      S.settings = await api.invoke('settings:set', patch);
      renderSettings(); renderSystem(); toast('CONFIG SAVED // MONITOR RESTARTED');
    });
    $('#btn-open-data').addEventListener('click', () => api.invoke('app:openData'));

    new ResizeObserver(() => paint()).observe($('#main'));
  }

  function subscribe() {
    api.on('monitor:sample', (s) => {
      S.samples.push(s);
      if (S.samples.length > 1440) S.samples.shift();
      paint();
    });
    api.on('pc:sample', (p) => {
      S.pc.samples.push(p);
      if (S.pc.samples.length > 300) S.pc.samples.shift();
      renderSysMini(p);
      if (S.view === 'system') { renderSystem(); paint(); }
    });
    api.on('state:mood', (m) => { S.mood = m; renderMood(); });
    api.on('speedtest:progress', onProgress);
    api.on('servers:status', (st) => { S.servers = st; renderServers(); });
    api.on('events:update', (ev) => { S.events = ev; renderEvents(); paint(); });
    api.on('history:update', (h) => { S.history = h; renderLog(); if (!h.length) showResult(null); });
    api.on('link:update', (l) => { S.link = l; renderLink(); });
    api.on('traffic:update', (t) => { S.traffic = t; renderTraffic(); });
    api.on('settings:update', (s) => { S.settings = s; renderSettings(); renderServers(); });
  }

  async function init() {
    gauge = createGauge($('#gauge'));
    bind();
    subscribe();
    const boot = await api.invoke('state:get');
    Object.assign(S, {
      settings: boot.settings, history: boot.history, samples: boot.samples, events: boot.events,
      servers: boot.servers, mood: boot.mood, link: boot.link, pc: boot.pc || { info: null, samples: [] }
    });
    $('#cfg-version').textContent = boot.version;
    $('#cfg-data').textContent = boot.dataPath;
    renderSettings(); renderMood(); renderLink(); renderTraffic(); renderEvents(); renderServers(); renderLog(); renderConns();
    renderSysMini(S.pc.samples[S.pc.samples.length - 1]);
    showResult(S.history[0], true);
    renderTicker(); setInterval(renderTicker, 10000);
    startClock();
    paint();
  }

  init();
})();
