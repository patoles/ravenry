// The window's only door to the main process. The page is sandboxed: it
// gets these calls and nothing else.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The daemon connection's MessagePort cannot cross the context bridge, so it
// is posted to the page as a window message.
ipcRenderer.on('daemon:port', (e, info: { socket: string; req: number }) => {
  window.postMessage({ type: 'ravenry:daemon-port', socket: info.socket, req: info.req }, '*', e.ports);
});
ipcRenderer.on('daemon:error', (_e, req: number, message: string, where: string) => {
  window.postMessage({ type: 'ravenry:daemon-error', req, message, where }, '*');
});

const on = (channel: string) => (cb: (...args: unknown[]) => void) => {
  const fn = (_e: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => { ipcRenderer.removeListener(channel, fn); };
};

contextBridge.exposeInMainWorld('ravenry', {
  config: () => ipcRenderer.invoke('app:config'),
  connectDaemon: (req: number, socket?: string) => ipcRenderer.send('daemon:connect', req, socket || null),
  resetDaemon: () => ipcRenderer.send('daemon:reset'),
  daemonSockets: () => ipcRenderer.invoke('daemon:sockets'),
  hubState: () => ipcRenderer.invoke('hub:state'),
  hubGet: (p: string) => ipcRenderer.invoke('hub:get', p),
  hubPost: (p: string, body: unknown) => ipcRenderer.invoke('hub:post', p, body),
  hubAnswer: (body: unknown) => ipcRenderer.invoke('hub:answer', body),
  onHubState: on('hub:state'),
  onHubStatus: on('hub:status'),
  onCommand: on('command'),
  folders: (root?: string) => ipcRenderer.invoke('local:folders', root),
  assistants: () => ipcRenderer.invoke('local:assistants'),
  shortPath: (p: string) => ipcRenderer.invoke('local:short', p),
  chooseFolder: () => ipcRenderer.invoke('local:choose-folder'),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (patch: Record<string, unknown>) => ipcRenderer.send('store:set', patch),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  openPath: (p: string) => ipcRenderer.send('open-path', p),
  copyText: (text: string) => ipcRenderer.send('copy-text', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read') as Promise<string>,
  hubCall: (method: string, p: string, body?: unknown) => ipcRenderer.invoke('hub:call', method, p, body),
  focusWindow: () => ipcRenderer.send('focus-window'),
  log: (line: string) => ipcRenderer.send('app:log', String(line).slice(0, 2000)),
  // The switch from the npm board (main/npmswitch.ts).
  npmState: () => ipcRenderer.invoke('npm:state'),
  npmSwitch: () => ipcRenderer.invoke('npm:switch'),
  npmNotNow: () => ipcRenderer.invoke('npm:not-now'),
  npmBack: () => ipcRenderer.invoke('npm:back'),
  npmConfirmBack: (on: boolean) => ipcRenderer.invoke('npm:confirm-back', on),
  onNpm: on('npm:state'),
});
