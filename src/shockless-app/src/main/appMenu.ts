import { BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";

export interface AppMenuActions {
  readonly dataDir: string;
  readonly pluginsDir: string;
  readonly repoUrl: string;
  readonly issuesUrl: string;
  readonly clearSavedCredentials: () => void | Promise<void>;
  readonly clearSessionLogs: () => void | Promise<void>;
  readonly clearAllAppData: () => void | Promise<void>;
  readonly reloadPlugins: () => void;
  readonly shellUiHidden: boolean;
  readonly setShellUiHidden: (hidden: boolean) => void;
}

/** Replaces Electron's default menu with an app-specific one: data management
 * (open folder, clear credentials / logs / everything), plugins, and an About
 * entry that asks the renderer to show the themed in-app modal. */
export function applyAppMenu(window: BrowserWindow, actions: AppMenuActions): void {
  const confirmThen = async (title: string, detail: string, run: () => void | Promise<void>): Promise<void> => {
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["Cancel", title],
      defaultId: 0,
      cancelId: 0,
      title,
      message: `${title}?`,
      detail,
    });
    if (response !== 1) return;
    try {
      await run();
      await dialog.showMessageBox(window, {
        type: "info",
        buttons: ["OK"],
        message: `${title} - done.`,
        detail: "Restart Shockless to fully apply.",
      });
    } catch (error) {
      await dialog.showMessageBox(window, {
        type: "error",
        buttons: ["OK"],
        message: `${title} failed.`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Open Data Folder", click: () => void shell.openPath(actions.dataDir) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Hide UI",
          type: "checkbox",
          checked: actions.shellUiHidden,
          click: (item) => actions.setShellUiHidden(item.checked),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Data",
      submenu: [
        { label: "Open Data Folder", click: () => void shell.openPath(actions.dataDir) },
        { type: "separator" },
        {
          label: "Clear Saved Credentials…",
          click: () =>
            void confirmThen(
              "Clear Saved Credentials",
              "Removes the saved encrypted account store and the multiclient account list from this machine.",
              actions.clearSavedCredentials,
            ),
        },
        {
          label: "Clear Session Logs…",
          click: () => void confirmThen("Clear Session Logs", "Deletes all log files in the data folder.", actions.clearSessionLogs),
        },
        {
          label: "Clear All App Data…",
          click: () =>
            void confirmThen(
              "Clear All App Data",
              "Removes config, saved credentials, logs, plugins, and the client library. This cannot be undone.",
              actions.clearAllAppData,
            ),
        },
      ],
    },
    {
      label: "Plugins",
      submenu: [
        { label: "Open Plugins Folder", click: () => void shell.openPath(actions.pluginsDir) },
        { label: "Reload Plugins", click: () => actions.reloadPlugins() },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "About Shockless", click: () => window.webContents.send("shockless:show-about") },
        { type: "separator" },
        { label: "GitHub Repository", click: () => void shell.openExternal(actions.repoUrl) },
        { label: "Report an Issue", click: () => void shell.openExternal(actions.issuesUrl) },
        { type: "separator" },
        { label: "ProjectorRays Github", click: () => void shell.openExternal("https://github.com/ProjectorRays/ProjectorRays") },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
