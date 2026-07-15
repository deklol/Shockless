// @name Floor Item Anywhere Premade Module
// @group automation
// @desc Readable user-plugin source reference for the built-in Floor Item Anywhere module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, furni } = api;
  const cleanup = subscriptions.create();
  log.info("Floor item anywhere helper ready: native floor item drag/drop can place outside visible room tiles.");

  await furni.setAnywherePlacementEnabled(true);
  await storage.remember('floorItemAnywhere', { enabled: true });
  cleanup.add(async () => {
    await furni.setAnywherePlacementEnabled(false);
    await storage.remember('floorItemAnywhere', { enabled: false });
  });

  return cleanup.dispose;
}
