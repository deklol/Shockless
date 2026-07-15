// @name Hide List Premade Module
// @group user
// @desc Readable user-plugin source reference for the built-in Hide List module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, filters, room, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Hide list helper ready: storing local hide targets and applying render/chat filters.");

  const controls = { target: '', reason: '' };
  const storedEntries = await storage.get('entries', []);
  let entries = Array.isArray(storedEntries) ? storedEntries : [];
  await applyHiddenUsers();
  cleanup.add(() => filters.clearHiddenUsers());
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    if (event?.action === 'hideList.clear') {
      entries = [];
      await storage.set('entries', entries);
      await applyHiddenUsers();
      return entries;
    }
    if (event?.action !== 'hideList.add') return undefined;
    const target = textValue(controls.target);
    if (!target) throw new Error('Enter a username or account id.');
    const reason = textValue(controls.reason);
    entries = entries.filter((entry) => String(entry?.target ?? entry).toLowerCase() !== target.toLowerCase());
    entries.push({ target, reason, createdAt: new Date().toISOString() });
    await storage.set('entries', entries);
    await applyHiddenUsers();
    await storage.remember('lastAdded', { target, reason });
    return entries;
  }));
  async function applyHiddenUsers() {
    const targets = entries.map((entry) => typeof entry === 'string' ? entry : entry?.target).filter(Boolean);
    await filters.setHiddenUsers(targets);
    await storage.remember('activeHiddenUsers', targets);
  }

  return cleanup.dispose;
}

function rememberControlValue(target, event) {
  if (!event?.elementId || !("value" in event)) return;
  target[event.elementId] = event.value;
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}
