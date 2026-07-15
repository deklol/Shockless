# Wall Item Anywhere Premade Module

Readable user-plugin source reference for the built-in Wall Item Anywhere module.

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
- `actions.wallItems`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Native wall item drag/drop remains the placement flow
- Off-wall cursor positions are treated as valid wall item locations
- Dragged wall items switch from faded to valid while outside the visible wall
- Reusable wallItems.setAnywherePlacementEnabled API for custom plugins

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
