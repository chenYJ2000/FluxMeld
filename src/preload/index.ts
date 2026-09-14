import { contextBridge, ipcRenderer } from 'electron'
import { createClientApi, type ClientTransport } from '../shared/clientApi'

const transport: ClientTransport = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),

  on: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  send: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send(channel, ...args)
  },
}

const electronAPI = createClientApi(transport, { platform: 'electron' })

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
