// @name Injection Premade Module
// @group developer
// @desc Readable user-plugin source reference for the built-in Injection module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, packets } = api;
  const cleanup = subscriptions.create();
  log.info("Injection helper ready: demonstrating validated packet send boundaries.");

  cleanup.add(packets.on('client', {}, (packet) => packet.allow()));
  await storage.remember('packetBuilder', {
    examples: [
      { packetName: 'WAVE' },
      { header: 52, bodyEscapedText: 'hello[0]' },
    ],
    note: 'Use packets.send(clientId, packet) only with validated client-to-server packets.',
  });

  return cleanup.dispose;
}
