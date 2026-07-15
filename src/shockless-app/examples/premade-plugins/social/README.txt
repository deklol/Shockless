# Social Premade Module

Readable user-plugin source reference for the built-in Social module.

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
- `ui.overlay`
- `console.commands`
- `events.room`
- `engine.snapshot`
- `events.chat`
- `events.packet`
- `packet.read`
- `actions.social`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Packet-backed friends list
- Friend search
- Packet-backed private messages
- Private message top-right notifications
- Packet-backed friend requests
- Scoped private message relay command
- Scoped friend request relay command
- Friend request accept/decline controls
- Friend remove/follow controls
- Friend request refresh control
- Badge summary
- Visitors split
- Chat split
- Profile lookup

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
