const DEFAULT_TEMPLATE = "Welcome {name}!";
const DEFAULT_ENABLED = true;
const COOLDOWN_MS = 30000;

export async function activate(api) {
  const { chat, events, log, storage } = api;
  const state = {
    enabled: await storage.get("enabled", DEFAULT_ENABLED),
    template: await storage.get("template", DEFAULT_TEMPLATE),
    recentByRoomUser: new Map(),
  };

  const disposeRoomChange = events.on("room.changed", () => {
    state.recentByRoomUser.clear();
  });

  const disposeJoin = events.on("room.userJoined", async (event) => {
    if (!state.enabled || event?.initial || event?.user?.isSelf) return;
    const name = cleanName(event?.user?.name);
    if (!name) return;

    const roomId = cleanName(event?.room?.id) || cleanName(event?.room?.name) || "room";
    const userId = cleanName(event?.user?.accountId) || cleanName(event?.user?.id) || name.toLowerCase();
    const key = `${event?.clientId ?? "selected"}:${roomId}:${userId}`;
    const now = Date.now();
    if ((state.recentByRoomUser.get(key) ?? 0) + COOLDOWN_MS > now) return;
    state.recentByRoomUser.set(key, now);

    const message = renderTemplate(state.template, {
      name,
      room: cleanName(event?.room?.name) || "the room",
      client: String(event?.clientId ?? "selected"),
    });
    await chat.send(message, { clientId: event?.clientId });
    log.info(`Welcomed ${name}`);
  });

  log.info("Welcome Message plugin ready.");

  return () => {
    disposeJoin();
    disposeRoomChange();
  };
}

function cleanName(value) {
  return String(value ?? "").trim();
}

function renderTemplate(template, values) {
  return String(template || DEFAULT_TEMPLATE)
    .replaceAll("{name}", values.name)
    .replaceAll("{room}", values.room)
    .replaceAll("{client}", values.client);
}
