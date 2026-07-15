# Welcome Message Plugin

Example Shockless user plugin built against the public worker-host API.

It subscribes to `room.userJoined`, ignores the selected account, applies a
short per-room/user cooldown, and sends room chat through `chat.send()`.

Install it through Plugin Manager with **Install Folder**, then choose this
folder. The manifest requests only the permissions it needs:

- `events.room`
- `chat.send`
- `storage`
- `engine.snapshot`
- `ui.panel`
