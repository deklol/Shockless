# Injection Premade Module

Readable user-plugin source reference for the built-in Injection module.

This folder is a premade user-plugin source reference for the native built-in module.
It does not replace the native panel; it shows how a third-party plugin can subscribe to the same public events and APIs.

## Install

1. Open Plugin Manager.
2. Choose Install From Folder.
3. Select this folder.
4. Enable the installed plugin if needed.

## Permissions

- `ui.panel`
- `console.commands`
- `packet.inject`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Raw WEDGIE and expression packet input
- Send to server or client
- Live header, name, and length validation
- Selected-session or all-session targeting
- Finite repeat with interval control
- Persistent saved packets and sent history

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
