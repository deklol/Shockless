// @name Inventory Premade Module
// @group inventory
// @desc Readable user-plugin source reference for the built-in Inventory module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, runtime, packets } = api;
  const cleanup = subscriptions.create();
  log.info("Inventory helper ready: tracking runtime inventory and strip packet updates.");

  cleanup.add(runtime.onSnapshot((event) => storage.remember('inventory', {
    clientId: event?.clientId ?? null,
    inventory: event?.snapshot?.inventory ?? null,
  })));
  cleanup.add(packets.on('server', { packetName: 'StripInfo' }, async (packet) => {
    await storage.remember('latestInventoryPacket', packets.summary(packet));
    return packet.allow();
  }));

  return cleanup.dispose;
}
