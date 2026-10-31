// 창(renderer)에 내놓는 API. 창에는 Node와 Electron을 열지 않고 이 함수들만 준다.
import { contextBridge, ipcRenderer } from 'electron';
import type { DogentApi, UiMessage } from './ipc';

const api: DogentApi = {
  init: () => ipcRenderer.invoke('dogent:init'),
  send: (text) => ipcRenderer.invoke('dogent:send', text),
  run: (id, values) => ipcRenderer.invoke('dogent:run', id, values),
  answer: (id, value) => ipcRenderer.invoke('dogent:answer', id, value),
  stop: () => ipcRenderer.invoke('dogent:stop'),
  skills: () => ipcRenderer.invoke('dogent:skills'),
  systems: () => ipcRenderer.invoke('dogent:systems'),
  page: () => ipcRenderer.invoke('dogent:page'),
  browsers: () => ipcRenderer.invoke('dogent:browsers'),
  selectBrowser: (which) => ipcRenderer.invoke('dogent:select-browser', which),
  excelDocs: () => ipcRenderer.invoke('dogent:excel-docs'),
  show: (path) => ipcRenderer.invoke('dogent:show', path),
  open: (path) => ipcRenderer.invoke('dogent:open', path),
  options: (patch) => ipcRenderer.invoke('dogent:options', patch),
  token: () => ipcRenderer.invoke('dogent:token'),
  extension: (register) => ipcRenderer.invoke('dogent:extension', register),
  setConfig: (key, value) => ipcRenderer.invoke('dogent:set-config', key, value),
  connectors: () => ipcRenderer.invoke('dogent:connectors'),
  connectPreview: (text) => ipcRenderer.invoke('dogent:connect-preview', text),
  connectAdd: (text) => ipcRenderer.invoke('dogent:connect-add', text),
  connectProbe: (name) => ipcRenderer.invoke('dogent:connect-probe', name),
  connectPatch: (name, patch) => ipcRenderer.invoke('dogent:connect-patch', name, patch),
  connectRemove: (name) => ipcRenderer.invoke('dogent:connect-remove', name),
  onUi: (listener) => {
    const handler = (_e: unknown, message: UiMessage) => listener(message);
    ipcRenderer.on('dogent:ui', handler);
    return () => ipcRenderer.off('dogent:ui', handler);
  },
};

contextBridge.exposeInMainWorld('dogent', api);
