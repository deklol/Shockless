# Shockless Plugin Template

This folder is copied by Plugin Manager when a user creates a plugin.

Files:

- `shockless.plugin.json`: plugin metadata, schema UI surfaces, commands, hotkeys, and permissions.
- `plugin.js`: JavaScript module entry point running in the restricted Shockless worker host.

The template demonstrates:

- `ui.preview`: plugin-store preview content.
- `ui.settings`: plugin settings controls.
- `surfaces[].layout`: the plugin rail/panel UI.
- `icon`: one of the app icon keys documented in `docs/plugin-authoring.md`.
- `ui.onAction()`: handling button/toggle/input changes.
- `ui.setValue()`: updating host-rendered control values from plugin code.
- `buttonGrid`: reusable grouped buttons rendered by the host.
- `table.rowAction`: selectable rows that emit the clicked row key.
- `commands` and `hotkeys`: declared command metadata.

Do not store account files, passwords, tokens, webhook URLs, or local test credentials in plugin folders.

See `docs/plugin-authoring.md` and `docs/plugin-api-reference.md` in the Shockless source tree for the full schema and API reference.
