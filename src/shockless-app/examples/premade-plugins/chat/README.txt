# Chat Premade Module

Readable user-plugin source reference for the built-in Chat module.

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
- `events.room`
- `engine.snapshot`
- `events.chat`
- `chat.send`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Send room chat
- Talk/whisper/shout/system filters
- Display clear
- Runtime chat history
- Packet-backed CHAT/CHAT_2/CHAT_3 fallback rows
- Room entry/clear markers from runtime room events

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
