import type { PluginRegistryState } from "../../../shared/plugin";
import type { ConsoleCommandStateSnapshot } from "../../../shared/window-api";

const sceneFxPresetNames = [
  "none",
  "greyscale",
  "blackwhite",
  "sepia",
  "negative",
  "technicolor",
  "polaroid",
  "kodachrome",
  "browni",
  "nightvision",
  "vintage",
  "predator",
  "lsd",
  "matrix",
  "noise",
  "scanlines",
  "crt",
] as const;

const sceneFxPresetList = sceneFxPresetNames.join(", ");

interface PacketConsoleSuggestion {
  readonly command: string;
  readonly usage: string;
  readonly detail: string;
  readonly source?: "built-in" | "plugin" | "alias" | "binding" | "history";
}

function consoleSuggestion(command: string, usage: string, detail: string): PacketConsoleSuggestion {
  return { command, usage, detail };
}

const packetConsoleBuiltInSuggestions: readonly PacketConsoleSuggestion[] = [
  consoleSuggestion("@1", "@1 ", "Route the next command to client 1."),
  consoleSuggestion("@2", "@2 ", "Route the next command to client 2."),
  consoleSuggestion("@3", "@3 ", "Route the next command to client 3."),
  consoleSuggestion("@all", "@all ", "Route the next command to all clients."),
  consoleSuggestion("@main", "@main ", "Route the next command to the main client."),
  consoleSuggestion("@visible", "@visible ", "Route the next command to visible clients."),
  consoleSuggestion("@headless", "@headless ", "Route the next command to hidden/headless clients."),
  consoleSuggestion("?", "?", "Alias for help."),
  consoleSuggestion("accept", "accept <request-name-or-account-id>", "Accept a friend request."),
  consoleSuggestion("acceptfriend", "acceptfriend <request-name-or-account-id>", "Accept a friend request."),
  consoleSuggestion("accounts", "accounts import <file> --key-env <ENV_NAME>", "Import accounts into the encrypted local account store."),
  consoleSuggestion("accounts", "accounts list --key-env <ENV_NAME>", "List stored account labels without exposing credentials."),
  consoleSuggestion("accounts", "accounts load <count> --key-env <ENV_NAME> --headless", "Load sessions from the encrypted local account store."),
  consoleSuggestion("accounts", "accounts clear", "Remove the encrypted local account store."),
  consoleSuggestion("addclient", "addclient --label <name>", "Create a new visible client slot."),
  consoleSuggestion("adduser", "adduser <name>", "Send a friend request."),
  consoleSuggestion("alias", "alias", "List command aliases."),
  consoleSuggestion("alias", "alias <name> <expansion>", "Create a command alias."),
  consoleSuggestion("bind", "bind <key> <command>", "Bind a keyboard shortcut to a console command."),
  consoleSuggestion("bindings", "bindings", "List keyboard command bindings."),
  consoleSuggestion("carry", "carry", "Carry a drink through the relay action path."),
  consoleSuggestion("carrydrink", "carrydrink", "Carry a drink through the relay action path."),
  consoleSuggestion("chat", "chat <message>", "Send room chat from the target client."),
  consoleSuggestion("clear", "clear", "Clear visible console output."),
  consoleSuggestion("client", "client <id|label>", "Select a client session."),
  consoleSuggestion("clients", "clients", "List active client sessions."),
  consoleSuggestion("close", "close <id|label>", "Close one client session."),
  consoleSuggestion("close", "close all --keep-main", "Close all extra sessions and keep the main client."),
  consoleSuggestion("dance", "dance <1-4>", "Send a dance action."),
  consoleSuggestion("decline", "decline <request-name-or-account-id>", "Decline a friend request."),
  consoleSuggestion("declinefriend", "declinefriend <request-name-or-account-id>", "Decline a friend request."),
  consoleSuggestion("enterroom", "enterroom <flat-id>", "Enter a private room by id."),
  consoleSuggestion("enterPublic", "enterPublic <name|node|unit>", "Alias for public <name|node|unit>."),
  consoleSuggestion("enterPublicRoom", "enterPublicRoom <name|node|unit>", "Alias for public <name|node|unit>."),
  consoleSuggestion("exec", "exec <script-file>", "Execute a saved console command script."),
  consoleSuggestion("exec", "exec <script-file> --dry-run", "Validate a command script without executing it."),
  consoleSuggestion("filter", "filter <text>", "Alias for packet log text filtering."),
  consoleSuggestion("flat", "flat <flat-id>", "Alias for entering a private room by id."),
  consoleSuggestion("follow", "follow <friend-name-or-account-id>", "Follow a friend."),
  consoleSuggestion("followfriend", "followfriend <friend-name-or-account-id>", "Follow a friend."),
  ...sceneFxPresetNames.map((preset) => consoleSuggestion("fx", `fx ${preset}`, `Apply Pixi scene effect: ${preset}.`)),
  consoleSuggestion("sceneFilter", "sceneFilter <preset>", "Alias for fx <preset>."),
  consoleSuggestion("scene-filter", "scene-filter <preset>", "Alias for fx <preset>."),
  consoleSuggestion("fps", "fps", "Show frame timing."),
  consoleSuggestion("fps", "fps <limit>", "Set an FPS limit where supported."),
  consoleSuggestion("smoothAvatars", "smoothAvatars true|false", "Toggle presentation-only room motion interpolation."),
  consoleSuggestion("smoothAvatars", "smoothAvatars status", "Show room motion interpolation state."),
  consoleSuggestion("smoothUi", "smoothUi true|false", "Toggle source-window presentation budgeting."),
  consoleSuggestion("smoothUi", "smoothUi status", "Show source-window presentation budget state."),
  consoleSuggestion("perfTrace", "perfTrace true|false", "Capture long-frame diagnostics in performanceStats."),
  consoleSuggestion("perfTrace", "perfTrace last", "Show recent long-frame diagnostic samples."),
  consoleSuggestion("perfTrace", "perfTrace clear", "Clear captured long-frame samples."),
  consoleSuggestion("friend", "friend <name>", "Alias for adduser."),
  consoleSuggestion("friendrequests", "friendrequests", "Refresh friend requests."),
  consoleSuggestion("goto", "goto <flat-id>", "Alias for entering a private room by id."),
  consoleSuggestion("gpu", "gpu", "Show GPU and hardware acceleration state."),
  consoleSuggestion("hcdance", "hcdance <1-4>", "Send an HC dance action."),
  consoleSuggestion("headless", "@headless ", "Target hidden/headless clients."),
  consoleSuggestion("help", "help", "Show available console commands."),
  consoleSuggestion("hideFurni", "hideFurni true|false", "Hide or show room furniture in the selected visible runtime."),
  consoleSuggestion("hideFurni", "hideFurni on", "Hide room furniture."),
  consoleSuggestion("hideFurni", "hideFurni off", "Show room furniture."),
  consoleSuggestion("hideFurniture", "hideFurniture true|false", "Alias for hideFurni true|false."),
  consoleSuggestion("hideUsers", "hideUsers true|false", "Hide or show room users in the selected visible runtime."),
  consoleSuggestion("hideUsers", "hideUsers on", "Hide room users."),
  consoleSuggestion("hideUsers", "hideUsers off", "Show room users."),
  consoleSuggestion("hideUi", "hideUi true|false", "Hide or show source UI windows in the selected visible runtime."),
  consoleSuggestion("hideUi", "hideUi on", "Hide source UI windows."),
  consoleSuggestion("hideUi", "hideUi off", "Show source UI windows."),
  consoleSuggestion("hideInterface", "hideInterface true|false", "Alias for hideUi true|false."),
  consoleSuggestion("hideBulletin", "hideBulletin", "Hide the current bulletin/window prompt if one is open."),
  consoleSuggestion("hideBulletinBoard", "hideBulletinBoard", "Alias for hideBulletin."),
  consoleSuggestion("autoHideBulletin", "autoHideBulletin", "Run the bulletin close helper once."),
  consoleSuggestion("hotelView", "hotelView", "Leave the current room and show hotel view."),
  consoleSuggestion("lobby", "lobby", "Alias for hotelView."),
  consoleSuggestion("history", "history", "Show recent command history."),
  consoleSuggestion("history", "history <count>", "Show a limited number of history rows."),
  consoleSuggestion("hand", "hand", "Open/request the hand inventory."),
  consoleSuggestion("input", "input <message>", "Send raw input/chat to the target client."),
  consoleSuggestion("inject", "inject server <packet>", "Send a raw outgoing Shockwave packet."),
  consoleSuggestion("inject", "inject client <packet>", "Deliver a raw synthetic incoming Shockwave packet."),
  consoleSuggestion("inventory", "inventory", "Open/request the hand inventory."),
  consoleSuggestion("requestInventory", "requestInventory", "Alias for inventory."),
  consoleSuggestion("rawpacket", "rawpacket server <packet>", "Alias for inject."),
  consoleSuggestion("launch", "launch", "Start the selected client."),
  consoleSuggestion("list", "list", "List active client sessions."),
  consoleSuggestion("load", "load <file> <count> --headless --concurrency <n>", "Load multiple sessions from an account file."),
  consoleSuggestion("load", "load <file> <count> --visible", "Load visible sessions from an account file."),
  consoleSuggestion("load-store", "load-store <count> --key-env <ENV_NAME> --headless", "Short form for accounts load."),
  consoleSuggestion("login", "login <email:password> --headless --label <name>", "Start one in-memory login session."),
  consoleSuggestion("lookup", "lookup <user>", "Look up in-game, social, packet, and Origins public user info."),
  consoleSuggestion("main", "main <id|label>", "Set the main/summoner client."),
  consoleSuggestion("message", "message <user|account-id> <message>", "Send a private message."),
  consoleSuggestion("mimic", "mimic status", "Show mimic forwarding state."),
  consoleSuggestion("mimic", "mimic on --source <id>", "Enable mimic from a source client."),
  consoleSuggestion("mimic", "mimic off", "Disable mimic forwarding."),
  consoleSuggestion("mimic", "mimic source <id>", "Change mimic source client."),
  consoleSuggestion("mimic", "mimic set movement on", "Enable mimic movement forwarding."),
  consoleSuggestion("mimic", "mimic set movement off", "Disable mimic movement forwarding."),
  consoleSuggestion("mimic", "mimic set speech on", "Enable mimic speech forwarding."),
  consoleSuggestion("mimic", "mimic set speech off", "Disable mimic speech forwarding."),
  consoleSuggestion("mimic", "mimic set actions on", "Enable mimic action forwarding."),
  consoleSuggestion("mimic", "mimic set actions off", "Disable mimic action forwarding."),
  consoleSuggestion("mimic", "mimic set rooms on", "Enable mimic room join forwarding."),
  consoleSuggestion("mimic", "mimic set rooms off", "Disable mimic room join forwarding."),
  consoleSuggestion("msg", "msg <user|account-id> <message>", "Alias for private message."),
  consoleSuggestion("names", "names true|false", "Toggle engine-rendered username labels."),
  consoleSuggestion("nav", "nav", "Open Navigator."),
  consoleSuggestion("nav", "nav <view>", "Open a specific Navigator view, for example nav_pr."),
  consoleSuggestion("navigator", "navigator", "Open Navigator."),
  consoleSuggestion("navigator", "navigator <view>", "Open a specific Navigator view, for example nav_pr."),
  consoleSuggestion("newclient", "newclient --label <name>", "Create a new visible client slot."),
  consoleSuggestion("openNavigator", "openNavigator <view>", "Alias for navigator <view>."),
  consoleSuggestion("packets", "packets", "Show packet filter status."),
  consoleSuggestion("packets", "packets all", "Show packet rows from all clients."),
  consoleSuggestion("packets", "packets selected", "Show packet rows from the selected client."),
  consoleSuggestion("packets", "packets client <id>", "Show packet rows from one client."),
  consoleSuggestion("packets", "packets c <id>", "Short form for packet client filtering."),
  consoleSuggestion("packets", "packets <text>", "Text-search packet rows without truncating output."),
  consoleSuggestion("perf", "perf", "Show performance timing."),
  consoleSuggestion("pm", "pm <user|account-id> <message>", "Alias for private message."),
  consoleSuggestion("public", "public <name|node|unit>", "Enter a public room by loaded Navigator name, id, unit, or port."),
  consoleSuggestion("publicRoom", "publicRoom <name|node|unit>", "Alias for public <name|node|unit>."),
  consoleSuggestion("private", "private <flat-id>", "Alias for entering a private room by id."),
  consoleSuggestion("refreshrequests", "refreshrequests", "Refresh friend requests."),
  consoleSuggestion("removefriend", "removefriend <friend-name-or-account-id>", "Remove a friend."),
  consoleSuggestion("rename", "rename <id> <label>", "Rename a client session label."),
  consoleSuggestion("requests", "requests", "Refresh friend requests."),
  consoleSuggestion("room", "room", "Print current room details."),
  consoleSuggestion("rooms", "rooms <query>", "Search loaded public room nodes."),
  consoleSuggestion("say", "say <message>", "Send room chat from the target client."),
  consoleSuggestion("sendpacket", "sendpacket server <packet>", "Alias for inject."),
  consoleSuggestion("select", "select <id|label>", "Select a client session."),
  consoleSuggestion("sessions", "sessions", "List active client sessions."),
  consoleSuggestion("showNames", "showNames true|false", "Toggle engine-rendered username labels."),
  consoleSuggestion("showFurni", "showFurni", "Alias for hideFurni false."),
  consoleSuggestion("showFurniture", "showFurniture", "Alias for hideFurni false."),
  consoleSuggestion("showUsers", "showUsers", "Alias for hideUsers false."),
  consoleSuggestion("showUi", "showUi", "Alias for hideUi false."),
  consoleSuggestion("showInterface", "showInterface", "Alias for hideUi false."),
  consoleSuggestion("showHotelView", "showHotelView", "Alias for hotelView."),
  consoleSuggestion("sleep", "sleep <ms>", "Pause a command script."),
  consoleSuggestion("stageclick", "stageclick <x> <y>", "Click the stage at screen coordinates."),
  consoleSuggestion("stageZoom", "stageZoom 1", "Set room-stage zoom to 100%."),
  consoleSuggestion("stageZoom", "stageZoom 2", "Set room-stage zoom to 200%."),
  consoleSuggestion("roomZoom", "roomZoom 1", "Set room-stage zoom to 100%."),
  consoleSuggestion("roomZoom", "roomZoom 2", "Set room-stage zoom to 200%."),
  consoleSuggestion("start", "start", "Start the selected client."),
  consoleSuggestion("stop", "stop <id|label>", "Close one client session."),
  consoleSuggestion("stop", "stop all --keep-main", "Close all extra sessions and keep the main client."),
  consoleSuggestion("stopdance", "stopdance", "Stop dancing."),
  consoleSuggestion("stopdancing", "stopdancing", "Stop dancing."),
  consoleSuggestion("summon", "summon all", "Summon all matching clients to the main room."),
  consoleSuggestion("summon", "summon headless", "Summon hidden/headless clients to the main room."),
  consoleSuggestion("summon", "summon visible", "Summon visible clients to the main room."),
  consoleSuggestion("summon", "summon <id|label> --room", "Summon one client through direct room entry."),
  consoleSuggestion("summoner", "summoner <id|label>", "Set the main/summoner client."),
  consoleSuggestion("summoner", "summoner set <id|label>", "Set the main/summoner client."),
  consoleSuggestion("unbind", "unbind <key>", "Remove a keyboard command binding."),
  consoleSuggestion("unalias", "unalias <name>", "Remove a command alias."),
  consoleSuggestion("unfriend", "unfriend <friend-name-or-account-id>", "Alias for removefriend."),
  consoleSuggestion("user", "user", "Print current user/session details."),
  consoleSuggestion("wait", "wait <ms>", "Pause a command script."),
  consoleSuggestion("walk", "walk <x> <y>", "Walk/click to a room tile or stage position."),
  consoleSuggestion("wave", "wave", "Send a wave action."),
  consoleSuggestion("windowClick", "windowClick <window-id> <element-id>", "Click a known source window element."),
  consoleSuggestion("clickWindow", "clickWindow <window-id> <element-id>", "Alias for windowClick."),
  consoleSuggestion("clickWindowElement", "clickWindowElement <window-id> <element-id>", "Alias for windowClick."),
  consoleSuggestion("zoom", "zoom 1", "Set room-stage zoom to 100%."),
  consoleSuggestion("zoom", "zoom 2", "Set room-stage zoom to 200%."),
];

function pluginCommandAliasUsage(commandUsage: string, commandName: string, aliasName: string): string {
  const normalizedUsage = commandUsage.trim();
  if (normalizedUsage.toLowerCase() === commandName.toLowerCase()) return aliasName;
  if (normalizedUsage.toLowerCase().startsWith(`${commandName.toLowerCase()} `)) {
    return `${aliasName}${normalizedUsage.slice(commandName.length)}`;
  }
  return aliasName;
}

function packetConsolePluginSuggestions(registry: PluginRegistryState | null): readonly PacketConsoleSuggestion[] {
  if (!registry) return [];
  const suggestions: PacketConsoleSuggestion[] = [];
  for (const plugin of registry.plugins) {
    if (registry.enabledById[plugin.id] === false) continue;
    for (const command of plugin.commands ?? []) {
      const usage = command.usage?.trim() || command.name;
      const detail = `Plugin ${plugin.name}: ${command.description}`;
      suggestions.push({
        command: command.name,
        usage,
        detail,
        source: "plugin",
      });
      for (const alias of command.aliases ?? []) {
        suggestions.push({
          command: alias,
          usage: pluginCommandAliasUsage(usage, command.name, alias),
          detail: `Plugin ${plugin.name}: alias for ${command.name}. ${command.description}`,
          source: "plugin",
        });
      }
    }
  }
  return suggestions;
}

function consoleSuggestionParts(input: string): { readonly query: string; readonly targetPrefix: string } {
  const normalized = input.trimStart().replace(/^\//, "");
  if (!normalized) return { query: "", targetPrefix: "" };
  const pieces = normalized.split(/\s+/).filter(Boolean);
  const first = pieces[0] ?? "";
  if (first.startsWith("@")) {
    if (pieces.length >= 2) return { query: pieces[1] ?? "", targetPrefix: first };
    if (/\s$/.test(normalized)) return { query: "", targetPrefix: first };
  }
  return { query: first, targetPrefix: "" };
}

function consoleSuggestionInsertText(suggestion: PacketConsoleSuggestion, targetPrefix: string): string {
  if (suggestion.command.startsWith("@")) return suggestion.usage;
  return targetPrefix ? `${targetPrefix} ${suggestion.usage}` : suggestion.usage;
}

function packetConsoleSuggestionsForInput(
  input: string,
  state: ConsoleCommandStateSnapshot | null,
  registry: PluginRegistryState | null,
): readonly PacketConsoleSuggestion[] {
  const { query, targetPrefix } = consoleSuggestionParts(input);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery && !targetPrefix) return [];

  const dynamicSuggestions: PacketConsoleSuggestion[] = [
    ...(state?.aliases ?? []).map((alias) => ({
      command: alias.name,
      usage: alias.name,
      detail: `Alias: ${alias.expansion}`,
      source: "alias" as const,
    })),
    ...(state?.bindings ?? []).map((binding) => ({
      command: binding.key,
      usage: binding.command,
      detail: `Binding ${binding.key}`,
      source: "binding" as const,
    })),
    ...(state?.history ?? []).slice(-20).reverse().map((entry) => ({
      command: entry.split(/\s+/)[0] ?? entry,
      usage: entry,
      detail: "History",
      source: "history" as const,
    })),
  ];

  const seen = new Set<string>();
  return [...packetConsoleBuiltInSuggestions, ...packetConsolePluginSuggestions(registry), ...dynamicSuggestions]
    .map((suggestion) => {
      if (targetPrefix && suggestion.command.startsWith("@")) return null;
      const haystack = `${suggestion.command} ${suggestion.usage} ${suggestion.detail}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return null;
      const command = suggestion.command.toLowerCase();
      const usage = suggestion.usage.toLowerCase();
      const score =
        command === normalizedQuery ? 0 :
        command.startsWith(normalizedQuery) ? 1 :
        usage.startsWith(normalizedQuery) ? 2 :
        haystack.includes(` ${normalizedQuery}`) ? 3 :
        4;
      return { suggestion, score };
    })
    .filter((entry): entry is { readonly suggestion: PacketConsoleSuggestion; readonly score: number } => Boolean(entry))
    .sort((left, right) => left.score - right.score || left.suggestion.usage.localeCompare(right.suggestion.usage))
    .map((entry) => entry.suggestion)
    .filter((suggestion) => {
      const key = `${suggestion.usage}\n${suggestion.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export { sceneFxPresetNames, sceneFxPresetList, packetConsolePluginSuggestions, consoleSuggestionParts, consoleSuggestionInsertText, packetConsoleSuggestionsForInput };
export type { PacketConsoleSuggestion };
