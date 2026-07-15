# Hide List Premade Module

Readable user-plugin source reference for the built-in Hide List module.

This folder is a premade user-plugin source reference for the native built-in module.
It does not replace the native panel; it shows how a third-party plugin can subscribe to the same public events and APIs.

## Install

1. Open Plugin Manager.
2. Choose Install From Folder.
3. Select this folder.
4. Enable the installed plugin if needed.

## Permissions

- `ui.panel`
- `engine.control`
- `engine.snapshot`
- `events.room`
- `events.chat`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Persistent username/account id block list
- Optional reason per hidden user
- Hide matching avatar sprites in the rendered room
- Filter matching say, shout, and whisper chat from Shockless chat history
- Reusable filters.setHiddenUsers API for custom plugins

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
