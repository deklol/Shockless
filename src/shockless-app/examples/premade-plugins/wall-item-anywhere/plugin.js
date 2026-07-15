// @name Wall Item Anywhere Premade Module
// @group automation
// @desc Readable user-plugin source reference for the built-in Wall Item Anywhere module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, wallItems } = api;
  const cleanup = subscriptions.create();
  log.info("Wall item anywhere helper ready: native wall item drag/drop can place outside visible wall bounds.");

  await wallItems.setAnywherePlacementEnabled(true);
  await storage.remember('wallItemAnywhere', { enabled: true });
  cleanup.add(async () => {
    await wallItems.setAnywherePlacementEnabled(false);
    await storage.remember('wallItemAnywhere', { enabled: false });
  });

  return cleanup.dispose;
}
