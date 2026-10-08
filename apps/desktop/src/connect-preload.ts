/**
 * The connect screen's bridge (a local page; remote pages get no preload at all): connect to an
 * address, and read or follow what the app wants shown (the current server, an error).
 */
import { contextBridge, ipcRenderer } from "electron";

type State = { server: string | null; error: string | null };

contextBridge.exposeInMainWorld("aatmiqDesktop", {
  connect: (address: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> => ipcRenderer.invoke("connect", String(address)),
  state: (): Promise<State | null> => ipcRenderer.invoke("connect:state"),
  onState: (fn: (s: State) => void) => {
    ipcRenderer.on("connect:update", (_e, s: State) => fn(s));
  },
});
