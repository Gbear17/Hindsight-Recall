/* SPDX-License-Identifier: GPL-3.0-only */
// Preload: expose safe IPC wrappers and receive broadcast events from main.
const {contextBridge, ipcRenderer} = require('electron');
const {EventEmitter} = require('events');
const emitter = new EventEmitter();

ipcRenderer.on('status:update', (_e, payload) => emitter.emit('status', payload));
ipcRenderer.on('log:line', (_e, line) => emitter.emit('log', line));

contextBridge.exposeInMainWorld('hindsight', {
  onStatus: (cb) => { emitter.on('status', cb); },
  onLog: (cb) => { emitter.on('log', cb); },
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enable) => ipcRenderer.invoke('autostart:set', enable),
  validateAutostart: () => ipcRenderer.invoke('autostart:validate'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (p) => ipcRenderer.invoke('prefs:set', p),
  debugValidate: () => ipcRenderer.invoke('autostart:validate'),
  captureStart: () => ipcRenderer.invoke('capture:start'),
  captureStop: () => ipcRenderer.invoke('capture:stop'),
  captureStatus: () => ipcRenderer.invoke('capture:status'),
  killOtherCaptures: () => ipcRenderer.invoke('capture:kill-others'),
  purgeData: () => ipcRenderer.invoke('data:purge'),
  debugLog: (line) => ipcRenderer.invoke('debug:log', line)
});
