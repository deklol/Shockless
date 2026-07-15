// @name Connection Premade Module
// @group session
// @desc Readable user-plugin source reference for the built-in Connection module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, session, runtime, packets } = api;
  const cleanup = subscriptions.create();
  log.info("Connection helper ready: tracking selected session, runtime snapshot, and latest traffic.");

  cleanup.add(session.onSelected((event) => storage.remember('selectedClient', { clientId: event?.clientId ?? null })));
  cleanup.add(runtime.onSnapshot(async (event) => {
    const stats = event?.snapshot?.performanceStats ?? {};
    await storage.remember('connection', {
      clientId: event?.clientId ?? null,
      room: event?.room ?? null,
      userName: event?.snapshot?.userState?.sessionUserName ?? null,
      fps: stats.rafPerSecond ?? stats.rafRate ?? null,
      worstFrameMs: stats.worstRafDeltaMs ?? null,
    });
  }));
  cleanup.add(packets.on('all', {}, async (packet) => {
    await storage.remember('latestTraffic', packets.summary(packet));
    return packet.allow();
  }));

  return cleanup.dispose;
}
