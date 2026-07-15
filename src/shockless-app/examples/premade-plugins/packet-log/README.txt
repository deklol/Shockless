# Packet Log Premade Module

Readable user-plugin source reference for the built-in Packet Log module.

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
- `packet.read`
- `events.packet`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Relay log presence and packet counts
- Recent client/server header rows with v3 packet names
- Direction and session filters
- Display clear, export, wrap, and autoscroll
- Selected relay row detail
- Payload byte count, decrypted body, ASCII/hex, and decoded fields
- Room-object packet fields for objects, updates, adds, removes, plant data, and stuff data
- Full escaped v4 relay bodies with sensitive client payload redaction

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
