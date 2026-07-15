declare module "electron" {
  import type { EventEmitter } from "node:events";

  export const app: {
    whenReady(): Promise<void>;
    quit(): void;
    on(event: "activate" | "window-all-closed" | "before-quit", listener: (...args: unknown[]) => void): void;
    getPath(name: "appData" | "userData"): string;
    setName(name: string): void;
    isPackaged: boolean;
  };

  export class BrowserWindow {
    constructor(options?: Record<string, unknown>);
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    show(): void;
    close(): void;
    isDestroyed(): boolean;
    setContentSize(width: number, height: number): void;
    setMinimumSize(width: number, height: number): void;
    setResizable(resizable: boolean): void;
    setTitle(title: string): void;
    webContents: WebContents;
    static getAllWindows(): BrowserWindow[];
  }

  export interface WebContents extends EventEmitter {
    send(channel: string, ...args: unknown[]): void;
    executeJavaScript<T = unknown>(code: string): Promise<T>;
    openDevTools(options?: Record<string, unknown>): void;
  }

  export const dialog: {
    showOpenDialog(window: BrowserWindow | null, options: Record<string, unknown>): Promise<{
      canceled: boolean;
      filePaths: string[];
    }>;
  };

  export const ipcMain: {
    handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: Record<string, unknown>): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: any, ...args: any[]) => void): void;
    removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void;
  };

  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
}
