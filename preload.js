'use strict';
// Whitelisted bridge between renderer and main. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = ['state:get', 'settings:set', 'speedtest:run', 'speedtest:cancel', 'history:clear', 'history:export',
  'sys:connections', 'link:refresh', 'servers:add', 'servers:remove', 'servers:check', 'app:openData', 'app:openUrl'];
const EVENTS = ['monitor:sample', 'speedtest:progress', 'state:mood', 'servers:status', 'events:update',
  'history:update', 'link:update', 'traffic:update', 'settings:update', 'pc:sample'];

contextBridge.exposeInMainWorld('png01', {
  invoke: (ch, ...args) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('BLOCKED CHANNEL'))),
  on: (ch, cb) => {
    if (!EVENTS.includes(ch)) return () => {};
    const h = (_e, data) => cb(data);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  }
});
