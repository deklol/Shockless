# Premade Plugin Modules

These folders are readable user-plugin versions of the built-in Shockless modules.
They are shipped as source references and installable examples, not as replacements for the native built-in panels.

To try one, open Plugin Manager, choose Install From Folder, and select one module folder such as `room` or `packet-log`.
The installed plugin id is prefixed with `premade-` so it does not collide with the native module id.

The generated code demonstrates the public plugin host API: session, runtime, room, chat, packet, and storage hooks.
It intentionally avoids credentials, webhook values, local account files, and hardcoded Habbo client versions.
