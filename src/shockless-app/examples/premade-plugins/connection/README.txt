# Connection Premade Module

Readable user-plugin source reference for the built-in Connection module.

This folder is a premade user-plugin source reference for the native built-in module.
It does not replace the native panel; it shows how a third-party plugin can subscribe to the same public events and APIs.

## Install

1. Open Plugin Manager.
2. Choose Install From Folder.
3. Select this folder.
4. Enable the installed plugin if needed.

## Permissions

- `ui.panel`
- `ui.status`
- `console.commands`
- `events.session`
- `engine.snapshot`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Session list and active session selection
- Compiled client import/build and Shockless profile registration
- Profile selection and launch
- Client state, traffic, crypto/status facts
- Lifecycle controls

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
