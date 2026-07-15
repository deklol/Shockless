# Floor Item Anywhere Premade Module

Readable user-plugin source reference for the built-in Floor Item Anywhere module.

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
- `actions.furni`
- `storage`

## Capabilities Mirrored From The Built-In Module

- Native floor item drag/drop remains the placement flow
- Off-room cursor positions are projected onto the same floor coordinate plane
- Dragged floor items switch from faded to valid while outside visible floor bounds
- Synthetic off-room move commits use Origins' source precise floor-location packet
- Reusable furni.setAnywherePlacementEnabled API for custom plugins
- Reusable furni.setFloorItemLocation API for explicit precise floor moves

## Notes

- The plugin keeps state in plugin-scoped storage.
- Packet hooks observe and allow packets; they do not mutate traffic.
- Raw packet sends require `packet.inject` and the validated packet builder. Custom React panels and arbitrary console command registration remain reserved host phases.
