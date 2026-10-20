// Seven-segment SVG renderer. Unlit segments stay visible as faint "ghost" segments (LCD look).
(function () {
  'use strict';
  const W = 40, H = 72, T = 8, G = 1.5, ADV = 50, DOT = 14;
  const L = T / 2, R = W - T / 2, TOP = T / 2, MID = H / 2, BOT = H - T / 2;
  const hz = (x1, x2, y) => `${x1},${y} ${x1 + T / 2},${y - T / 2} ${x2 - T / 2},${y - T / 2} ${x2},${y} ${x2 - T / 2},${y + T / 2} ${x1 + T / 2},${y + T / 2}`;
  const vt = (x, y1, y2) => `${x},${y1} ${x + T / 2},${y1 + T / 2} ${x + T / 2},${y2 - T / 2} ${x},${y2} ${x - T / 2},${y2 - T / 2} ${x - T / 2},${y1 + T / 2}`;
  const SEG = {
    a: hz(L + G, R - G, TOP), b: vt(R, TOP + G, MID - G), c: vt(R, MID + G, BOT - G), d: hz(L + G, R - G, BOT),
    e: vt(L, MID + G, BOT - G), f: vt(L, TOP + G, MID - G), g: hz(L + G, R - G, MID)
  };
  const MAP = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
    '-': 'g', ' ': '', _: 'd', E: 'adefg', r: 'eg', o: 'cdeg', F: 'aefg', A: 'abcefg', L: 'def', n: 'ceg', P: 'abefg',
    H: 'bcefg', d: 'bcdeg', b: 'cdefg', C: 'adef', t: 'defg', U: 'bcdef'
  };
  const KEYS = 'abcdefg'.split('');

  function render(el, text, opts) {
    if (!el) return;
    text = String(text == null ? '---' : text);
    const min = (opts && opts.min) || 0;
    const key = text + '|' + min;
    if (el._seg === key) return;
    el._seg = key;

    const items = [];
    for (const ch of text) items.push(ch === '.' || ch === ':' ? { dot: true } : { ch });
    let digits = items.filter((i) => !i.dot).length;
    while (digits < min) { items.unshift({ ch: ' ' }); digits++; }

    let x = 0, out = '';
    for (const it of items) {
      if (it.dot) { out += `<rect class="on" x="${x - 4}" y="${H - T}" width="${T}" height="${T}"/>`; x += DOT - 4; continue; }
      const on = MAP[it.ch] != null ? MAP[it.ch] : '';
      out += `<g transform="translate(${x} 0)">` + KEYS.map((s) => `<polygon class="${on.includes(s) ? 'on' : 'off'}" points="${SEG[s]}"/>`).join('') + '</g>';
      x += ADV;
    }
    const w = Math.max(x - (ADV - W), 1);
    el.setAttribute('aria-label', text.trim());
    el.innerHTML = `<svg viewBox="-10 -2 ${w + 14} ${H + 4}" preserveAspectRatio="xMinYMid meet" aria-hidden="true"><g transform="skewX(-6)">${out}</g></svg>`;
  }

  window.Seg = { render };
})();
