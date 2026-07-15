// @name Multi Account Premade Module
// @group session
// @desc Readable user-plugin source reference for the built-in Multi Account module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, session, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Multi-account helper ready: tracking selected, main, visible, and headless clients.");

  await recordClients('activated');
  cleanup.add(session.onSelected(() => recordClients('selected client changed')));
  cleanup.add(ui.onAction(async (event) => {
    if (event?.action === 'multiAccount.refresh') await recordClients('manual refresh');
  }));
  async function recordClients(reason) {
    const clients = await session.getClients();
    await storage.remember('clients', { reason, selectedClientId: clients.selectedClientId, mainClientId: clients.mainClientId, clients: clients.clients });
    log.info('Client list refreshed: ' + clients.clients.length + ' session(s).');
  }

  return cleanup.dispose;
}
