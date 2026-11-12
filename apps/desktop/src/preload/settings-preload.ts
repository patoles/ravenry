// The Settings window's only door to the main process (src/main/settings.ts).

import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (...args: unknown[]) => void) => {
  const fn = (_e: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => { ipcRenderer.removeListener(channel, fn); };
};

contextBridge.exposeInMainWorld('ravenrySettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  importTheme: () => ipcRenderer.invoke('settings:import-theme'),
  onChange: on('settings:changed'),
  onShowTab: on('settings:show-tab'),
  window: () => ipcRenderer.invoke('settings:window'),
  size: (height: number) => ipcRenderer.send('settings:size', height),
  tab: (tab: string) => ipcRenderer.send('settings:tab', tab),
  repeats: { get: () => ipcRenderer.invoke('repeats:get'), set: (on: boolean) => ipcRenderer.invoke('repeats:set', on) },
  skills: { get: () => ipcRenderer.invoke('skills:get'), set: (kind: string, on: boolean) => ipcRenderer.invoke('skills:set', kind, on), setHooks: (kind: string, on: boolean) => ipcRenderer.invoke('hooks:set', kind, on), onChange: on('skills:changed') },
});
