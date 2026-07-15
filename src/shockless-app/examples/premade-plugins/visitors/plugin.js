// @name Visitors Premade Module
// @group social
// @desc Readable user-plugin source reference for the built-in Visitors module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, room } = api;
  const cleanup = subscriptions.create();
  log.info("Visitor helper ready: tracking room joins and leaves.");

  const visitors = new Map();
  cleanup.add(room.onUsers(async (event) => {
    for (const user of event?.users ?? []) visitors.set(room.userKey(user), { ...user, present: true, lastSeenAt: new Date().toISOString() });
    await storage.remember('visitors', [...visitors.values()]);
  }));
  cleanup.add(room.onUserJoined(async (event) => {
    visitors.set(room.userKey(event?.user), { ...event?.user, present: true, joinedAt: new Date().toISOString() });
    await storage.remember('visitors', [...visitors.values()]);
  }));
  cleanup.add(room.onUserLeft(async (event) => {
    const key = room.userKey(event?.user);
    visitors.set(key, { ...(visitors.get(key) ?? event?.user), present: false, leftAt: new Date().toISOString() });
    await storage.remember('visitors', [...visitors.values()]);
  }));

  return cleanup.dispose;
}
