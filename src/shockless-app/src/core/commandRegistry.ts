import type { CommandDefinition } from "../shared/command.js";

export const commands: readonly CommandDefinition[] = [
  {
    id: "shell.togglePluginDock",
    pluginId: "connection",
    label: "Toggle Plugin Dock",
    summary: "Collapse or expand the Shockless plugin dock without touching game input.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "local-shell",
      sourcePaths: ["src/core/shellStore.ts", "src/renderer/ui/App.tsx"],
    },
  },
  {
    id: "engine.launchEmbedded",
    pluginId: "connection",
    label: "Launch Embedded Shockless",
    summary: "Attach the selected ready Shockless client profile inside the Shockless GameHost.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-webcontents",
      sourcePaths: [
        "src/main/shocklessEmbed.ts",
        "src/main/clientLibrary.ts",
        "standalone/src/main/staticServer.ts",
        "standalone/src/main/relay.ts",
      ],
      notes: "Uses selected profile metadata and current settings; no client version is hardcoded.",
    },
  },
  {
    id: "engine.consoleStart",
    pluginId: "connection",
    label: "Console Start Client",
    summary: "Start the selected or targeted client through the backtick console command bus.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-webcontents",
      sourcePaths: [
        "src/main/multiSessionManager.ts start/launch command",
        "src/main/shocklessEmbed.ts",
        "src/main/clientLibrary.ts",
      ],
      notes: "Runs the same selected-client start path as the Start button; target prefixes can start a specific client or all clients.",
    },
  },
  {
    id: "client.importReference",
    pluginId: "connection",
    label: "Import Or Build Client Profile",
    summary: "Register an existing Shockless profile folder, or build a playable profile from a compiled client folder when no matching cache exists.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "local-shell",
      sourcePaths: ["src/main/clientLibrary.ts", "src/main/profileImportRunner.ts", "standalone/src/main/profileImporter.ts", "src/renderer/ui/App.tsx"],
      notes:
        "Profile folders are registered by reference. Compiled client folders are validated dynamically, matched to an existing ready cache when possible, or compiled through the bundled Shockless importer into the app clients root; v4 does not hardcode build folders or duplicate existing profile output.",
    },
  },
  {
    id: "info.lookupPublicUser",
    pluginId: "info",
    label: "Lookup Public User",
    summary: "Look up an explicit Habbo name through the official Origins public users API.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "src/main/originsUserLookup.ts",
        "Shockless docs/REMOTE_PLAY_API.md GET /api/users",
        "https://origins.habbo.com/api/public/users?name=<name>",
      ],
      notes: "This does not read private friends lists or mutate the game; it only normalizes public profile data.",
    },
  },
  {
    id: "room.readSummary",
    pluginId: "room",
    label: "Read Room Summary",
    summary: "Read current room mode, id, owner, users, and object counts from Shockless dev state.",
    status: "mapped",
    risk: "read-only",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Shockless docs/DEV_AUTOMATION_API.md",
        "Shockless docs/REMOTE_PLAY_API.md",
      ],
    },
  },
  {
    id: "room.showHotelView",
    pluginId: "room",
    label: "Show Hotel View",
    summary: "Leave the current room through Shockless helpers and return to hotel view.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: ["Shockless docs/DEV_AUTOMATION_API.md", "window.__engine.dev.showHotelView"],
    },
  },
  {
    id: "room.enterPrivate",
    pluginId: "room",
    label: "Enter Private Room",
    summary: "Enter a private flat through the generated Navigator Component prepare-room-entry path.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: ["Shockless docs/DEV_AUTOMATION_API.md", "window.__engine.dev.enterPrivateRoom"],
    },
  },
  {
    id: "room.enterPublic",
    pluginId: "room",
    label: "Enter Public Room",
    summary: "Enter a public room through the generated Navigator public node prepare-room-entry path.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: ["Shockless src/app/main.ts dev.enterPublicRoom", "Navigator Component.prepareRoomEntry(public node)"],
      notes: "Accepts a room name, node id, unit string id, port, or empty query for the first cached public room.",
    },
  },
  {
    id: "room.openNavigator",
    pluginId: "room",
    label: "Open Navigator",
    summary: "Open the Navigator window through Shockless helpers.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: ["Shockless docs/DEV_AUTOMATION_API.md", "window.__engine.dev.navigatorView"],
    },
  },
  {
    id: "room.stageClick",
    pluginId: "room",
    label: "Walk / Stage Click",
    summary: "Click the live Shockless stage through Director pointer events for mapped walk/click tests.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/room_tab.py room interaction controls",
        "Shockless docs/DEV_AUTOMATION_API.md",
        "window.__engine.dev.stageClick",
      ],
      notes: "Routes through Director pointer events; the active room decides whether the click becomes walking, selection, or no-op.",
    },
  },
  {
    id: "room.captureScreenshot",
    pluginId: "dev-tools",
    label: "Capture Game Screenshot",
    summary: "Capture the embedded game surface for visual QA and regression evidence.",
    status: "mapped",
    risk: "read-only",
    route: {
      kind: "shockless-webcontents",
      sourcePaths: [
        "Shockless standalone/src/main/main.ts",
        "Shockless docs/DEV_AUTOMATION_API.md",
      ],
    },
  },
  {
    id: "devTools.gpuDiagnostics",
    pluginId: "dev-tools",
    label: "GPU Diagnostics",
    summary: "Report launch GPU switches and WebGL renderer/vendor facts for visible or hidden clients.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "src/main/main.ts Electron GPU launch switches",
        "src/main/multiSessionManager.ts gpu command",
        "src/renderer/ui/App.tsx gpu console fallback",
      ],
      notes:
        "`gpu` is source-backed for hidden/headless clients through the command bus and for the selected visible client through the renderer console. Hardware acceleration is enabled by default and can be disabled from Dev Tools for the next app restart.",
    },
  },
  {
    id: "chat.sendMessage",
    pluginId: "chat",
    label: "Send Chat Message",
    summary: "Send a chat line through a mapped Shockless input/action path.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/chat_tab.py",
        "Shockless docs/DEV_AUTOMATION_API.md",
        "window.__engine.dev.sendChat",
      ],
      notes: "Routes through the live Director room chat field and fails visibly if no chat field is present.",
    },
  },
  {
    id: "social.sendPrivateMessage",
    pluginId: "social",
    label: "Send Private Message",
    summary: "Send a private messenger line through the scoped v3-equivalent Social relay packet.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 packet_names.json MESSENGER_SENDMSG",
        "src/shared/socialRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts scoped Social control packets",
      ],
      notes: "Console command: message <friend-or-id> <message>. Payload uses header 33 with recipient count, account id, and Shockwave string text.",
    },
  },
  {
    id: "social.requestFriend",
    pluginId: "social",
    label: "Send Friend Request",
    summary: "Send a friend request through the scoped v3-equivalent Social relay packet.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 packet_names.json FRIENDLIST_FRIENDREQUEST",
        "src/shared/socialRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts scoped Social control packets",
      ],
      notes: "Console command: adduser <name>. Payload uses header 39 with a Shockwave string username.",
    },
  },
  {
    id: "social.friendLifecycle",
    pluginId: "social",
    label: "Friend Lifecycle Actions",
    summary: "Refresh requests, accept/decline requests, remove friends, and follow friends using mapped v3 packet shapes.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 packet_names.json FRIENDLIST_GETFRIENDREQUESTS/ACCEPTFRIEND/DECLINEFRIEND/REMOVEFRIEND/FOLLOW_FRIEND",
        "generated/scripts/hh_friend_list/External/ParentScript_4_-_Friend_List_Component_Class.ts",
        "generated/scripts/hh_friend_list/External/ParentScript_3_-_Friend_List_Interface_Class.ts",
        "src/shared/socialRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts scoped Social control packets",
      ],
      notes:
        "Console commands: requests, accept <request>, decline <request>, follow <friend>, removefriend <friend>. Payloads use headers 233, 37, 38, 262, and 40 with the same count/id list shapes as v3/generated source.",
    },
  },
  {
    id: "user.readSourceState",
    pluginId: "user",
    label: "Read User State",
    summary: "Read room user objects plus safe session username, room, and rights fields into the User panel.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/user_tab.py on_room_users/on_account_info/on_user_status",
        "Habbpy v3 habbpy/gui_dashboard.py _handle_room_users/_handle_status/_handle_chat",
        "window.__engine.roomObjects().users",
        "window.__engine.objectProps('Session').pitemlist",
      ],
      notes:
        "Does not read or persist password/email/TOTP session keys. Missing v3 profile fields stay out of the normal panel until mapped.",
    },
  },
  {
    id: "user.copyProfileData",
    pluginId: "user",
    label: "Copy User Profile Data",
    summary: "Copy selected parsed user fields and store parsed figure strings locally without sending game traffic.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/user_tab.py copy/store look controls",
        "src/renderer/ui/App.tsx Local Profile Tools",
        "window.__engine.roomObjects().users parsed userState fields",
      ],
      notes:
        "Clipboard/profile snapshot and stored-look list are local renderer actions. Store Look is enabled only when runtime data exposes a figure string.",
    },
  },
  {
    id: "user.sourceWindowActions",
    pluginId: "user",
    label: "User Actions",
    summary: "Wave, dance, stop dance, carry drink, and apply look route through scoped v3-equivalent relay packets.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/user_tab.py _wave/_dance/_stop_dance/_carry_drink/_apply_look",
        "src/shared/userRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts scoped User control packets",
      ],
      notes:
        "Uses the local relay control channel for the exact v3 packet headers 94 Wave, 93 Dance/Stop, 80 Carry Drink, and 44 Apply Look. Mimic now uses a separate relay-log forwarding path instead of arbitrary raw packet injection.",
    },
  },
  {
    id: "user.mimicForwarding",
    pluginId: "multi-account",
    label: "User Mimic Forwarding",
    summary: "Forward whitelisted v3-style avatar/chat/action packets from one source client to other sessions.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/user_tab.py _mimic_toggle",
        "Habbpy v3 session forwarding/mimic paths",
        "src/shared/mimicRelayPackets.ts",
        "src/main/multiSessionManager.ts mimic poller",
        "src/main/relay/originsRelayV4.ts mimic control scope",
      ],
      notes:
        "Mimic tails decoded relay logs for the source client, validates whitelisted movement/chat/action packets, suppresses short duplicate bursts, and forwards through each target client's scoped relay control port. Sensitive login/key/unique-id packets are refused.",
    },
  },
  {
    id: "multiAccount.newVisibleClient",
    pluginId: "multi-account",
    label: "New Visible Client",
    summary: "Start a blank visible Shockless runtime for manual login and select it.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "src/main/multiSessionManager.ts commandNewClient",
        "src/renderer/ui/App.tsx session add button",
        "src/main/shocklessEmbed.ts",
      ],
      notes:
        "Uses the selected ready profile and normal per-client static/relay ports. No credentials are read or stored; the user logs in manually through the visible game view.",
    },
  },
  {
    id: "multiAccount.loadSessions",
    pluginId: "multi-account",
    label: "Load Accounts",
    summary: "Start multiple hidden Shockless runtime clients from a local account file or encrypted account store.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "src/main/multiSessionManager.ts commandLoad/commandAccounts",
        "src/main/encryptedAccountStore.ts",
        "multiclient-accounts.txt local test shape",
      ],
      notes:
        "Credentials are read only from user-provided local files or encrypted app-data store and are not hardcoded in source or printed in command output.",
    },
  },
  {
    id: "multiAccount.summonClients",
    pluginId: "multi-account",
    label: "Summon Clients",
    summary: "Bring target clients to the configured main account through friend-follow or private-room entry.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "src/main/multiSessionManager.ts commandSummon",
        "src/shared/socialRelayPackets.ts FOLLOW_FRIEND",
        "Shockless docs/DEV_AUTOMATION_API.md enterPrivateRoom",
      ],
      notes:
        "Friend targets use FOLLOW_FRIEND [262]. Non-friend or forced room targets use Navigator Component.prepareRoomEntry with the main private room id.",
    },
  },
  {
    id: "items.readRoomObjects",
    pluginId: "items",
    label: "Read Room Items",
    summary: "Read live floor/passive/wall room object rows and enrich them with cached Origins furnidata names.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/items_tab.py",
        "window.__engine.roomObjects()",
        "src/main/furnidata.ts",
        "Origins furnidata gamedata cache",
      ],
      notes: "Reads local runtime data only; Bobba pricing remains pending because v4 does not copy the v3 private API key.",
    },
  },
  {
    id: "inventory.requestHand",
    pluginId: "inventory",
    label: "Request Hand Inventory",
    summary: "Open/read the hand inventory through the Room_bar hand icon and Room_container.pItemList.",
    status: "ready",
    risk: "source-routed-action",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/inventory_tab.py",
        "Habbpy v3 habbpy/gui_dashboard.py request_inventory",
        "Shockless Container Hand Class.open",
        "Room_bar:int_hand_image",
        "window.__engine.objectProps('Room_container')",
      ],
      notes:
        "Does not inject raw GETSTRIP from v4; it clicks the hand control when closed and reads the generated Room_container pItemList.",
    },
  },
  {
    id: "packetLog.readRelayLog",
    pluginId: "packet-log",
    label: "Read Relay Packet Log",
    summary: "Tail the embedded Shockless relay log and parse client/server packet rows, payload byte counts, decrypted bodies, v3 names, and decoded packet-family fields into the Packet Log panel.",
    status: "ready",
    risk: "read-only",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/packet_log_tab.py",
        "Habbpy v3 habbpy/gui_dashboard.py add_packet",
        "Shockless resources/relay/origins-relay.mjs ORIGINS_LOG_PACKETS",
        "src/main/relay/originsRelayV4.ts",
        "src/main/relayLog.ts",
        "src/shared/packetNames.ts",
      ],
      notes:
        "Current Shockless parser reads relay header/size rows, derives payload byte counts, annotates v3 packet names, parses full escaped packet bodies when launched through the Shockless relay wrapper, and decodes chat, user, room-object, inventory, wall-item, social, and info packet families. Sensitive client payloads are redacted; remaining packet-family decoders should be ported incrementally.",
    },
  },
  {
    id: "injection.rawPacketSend",
    pluginId: "injection",
    label: "Send Raw Packet",
    summary: "Build and send validated raw Shockwave packets from the Injection panel or backtick console.",
    status: "ready",
    risk: "advanced",
    route: {
      kind: "shockless-webcontents",
      sourcePaths: [
        "src/shared/shockwavePacketExpression.ts",
        "src/shared/shockwavePluginPacketBuilder.ts",
        "src/main/relay/originsRelayV4.ts",
      ],
      notes:
        "Supports server and client targets, byte escapes, typed WEDGIE expressions, finite repetition, session targeting, saved packets, and sent history.",
    },
  },
  {
    id: "automation.summary",
    pluginId: "automation",
    label: "Automation Group Summary",
    summary: "Show comfort automation status and helper coverage.",
    status: "mapped",
    risk: "read-only",
    route: {
      kind: "local-shell",
      sourcePaths: [
        "src/plugins/registry.ts",
        "src/renderer/ui/App.tsx",
      ],
      notes: "Public automation stays focused on comfort helpers and wall-item workflows; private dev modules are not bundled.",
    },
  },
  {
    id: "wallMover.readWallItems",
    pluginId: "wall-mover",
    label: "Read Wall Items",
    summary: "Read live wall item rows and target fields for the Wall Mover panel.",
    status: "mapped",
    risk: "read-only",
    route: {
      kind: "shockless-dev-api",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/wallmover_tab.py",
        "Habbpy v3 habbpy/wallmover.py",
        "window.__engine.roomObjects().wallItems",
      ],
      notes: "The panel reads live wall item rows and packet-backed fallbacks, then feeds the mapped move and pickup controls.",
    },
  },
  {
    id: "wallMover.moveActions",
    pluginId: "wall-mover",
    label: "Wall Move Actions",
    summary: "Nudge, flip, step, and pickup controls route through scoped v3 wall item packets.",
    status: "mapped",
    risk: "automation",
    route: {
      kind: "habbpy-v3-port",
      sourcePaths: [
        "Habbpy v3 habbpy/tabs/wallmover_tab.py",
        "Habbpy v3 habbpy/wallmover.py MoveItem/AddStripItem headers",
        "src/shared/wallMoverRelayPackets.ts",
        "src/main/relay/originsRelayV4.ts Wall Mover control scope",
      ],
      notes: "Uses v3-equivalent MoveItem [91] and pickup/AddStripItem [67] packets through the local relay control boundary.",
    },
  },
];

export function getCommandsForPlugin(pluginId: string): readonly CommandDefinition[] {
  return commands.filter((command) => command.pluginId === pluginId);
}
