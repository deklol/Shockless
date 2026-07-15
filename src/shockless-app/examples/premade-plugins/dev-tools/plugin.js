// @name Dev Tools Premade Module
// @group developer
// @desc Readable user-plugin source reference for the built-in Dev Tools module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, runtime } = api;
  const cleanup = subscriptions.create();
  log.info("Dev tools helper ready: recording selected runtime diagnostics.");

  cleanup.add(runtime.onSnapshot((event) => storage.remember('diagnostics', {
    clientId: event?.clientId ?? null,
    fps: event?.snapshot?.performanceStats?.rafPerSecond ?? event?.snapshot?.performanceStats?.rafRate ?? null,
    worstFrameMs: event?.snapshot?.performanceStats?.worstRafDeltaMs ?? null,
    frame: event?.snapshot?.frame ?? null,
    errors: event?.snapshot?.errors ?? null,
    windows: event?.snapshot?.windowIds ?? [],
  })));

  return cleanup.dispose;
}
