// @name Room Premade Module
// @group room
// @desc Readable user-plugin source reference for the built-in Room module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, room } = api;
  const cleanup = subscriptions.create();
  log.info("Room helper ready: tracking room lifecycle and parsed item summaries.");

  cleanup.add(room.onChanged((event) => storage.remember('room', { eventName: 'room.changed', clientId: event?.clientId ?? null, room: event?.room ?? null })));
  cleanup.add(room.onReady((event) => storage.remember('room', { eventName: 'room.ready', clientId: event?.clientId ?? null, room: event?.room ?? null })));
  cleanup.add(room.onItems((event) => storage.remember('roomObjects', {
    room: event?.room ?? null,
    counts: room.countItems(event),
    floorItems: (event?.floorItems ?? []).map(room.summarizeItem).slice(0, 30),
    wallItems: (event?.wallItems ?? []).map(room.summarizeItem).slice(0, 30),
  })));

  return cleanup.dispose;
}
