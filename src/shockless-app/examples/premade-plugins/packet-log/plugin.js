// @name Packet Log Premade Module
// @group developer
// @desc Readable user-plugin source reference for the built-in Packet Log module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, packets, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Packet log helper ready: collecting packet summaries without mutating traffic.");

  const recent = [];
  let capturePackets = true;
  cleanup.add(ui.onAction(async (event) => {
    if (event?.action !== 'packetLog.setCapture') return;
    capturePackets = event.value !== false;
    await storage.remember('capturePackets', { enabled: capturePackets });
  }));
  cleanup.add(packets.on('all', {}, async (packet) => {
    if (!capturePackets) return packet.allow();
    recent.push(packets.summary(packet));
    await storage.remember('recentPackets', recent.slice(-200));
    return packet.allow();
  }));

  return cleanup.dispose;
}
