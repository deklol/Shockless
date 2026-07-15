// @name Info Premade Module
// @group social
// @desc Readable user-plugin source reference for the built-in Info module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, runtime, packets } = api;
  const cleanup = subscriptions.create();
  log.info("Info helper ready: tracking account, room, inventory, rights, and profile packets.");

  cleanup.add(runtime.onSnapshot(async (event) => {
    const user = event?.snapshot?.userState ?? {};
    await storage.remember('info', {
      clientId: event?.clientId ?? null,
      room: event?.room ?? null,
      account: { name: user.sessionUserName ?? null, rights: user.rights ?? [] },
      inventory: event?.snapshot?.inventory ?? null,
    });
  }));
  cleanup.add(packets.on('server', {}, async (packet) => {
    if (packets.hasName(packet, 'USERS', 'MessengerInit', 'Badges')) await storage.remember('latestInfoPacket', packets.summary(packet));
    return packet.allow();
  }));

  return cleanup.dispose;
}
