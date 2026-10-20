'use strict';
// Tiny JSON store in the app's userData folder. Atomic writes, debounced.
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const timers = {};
  const pending = {};
  const file = (n) => path.join(dir, n + '.json');

  function write(name) {
    const f = file(name);
    const tmp = f + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(pending[name]));
      fs.renameSync(tmp, f);
    } catch (e) {
      console.error('[store]', name, e.message);
    }
    delete pending[name];
  }

  return {
    dir,
    load(name, fallback) {
      try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
    },
    save(name, data) {
      pending[name] = data;
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => write(name), 400);
    },
    flush() {
      Object.keys(pending).forEach((n) => { clearTimeout(timers[n]); write(n); });
    }
  };
}

module.exports = { createStore };
