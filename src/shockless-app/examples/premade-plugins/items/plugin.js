// @name Items Premade Module
// @group inventory
// @desc Readable user-plugin source reference for the built-in Items module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, furni, room, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Items helper ready: tracking room items and routing typed furniture actions.");

  const controls = { itemQuery: '', itemKind: 'all', moveX: 0, moveY: 0, direction: 0 };
  const itemsByKey = new Map();
  cleanup.add(room.onItems(async (event) => {
    itemsByKey.clear();
    for (const item of event?.items ?? []) itemsByKey.set(room.itemKey(item), item);
    await storage.remember('items', { room: event?.room ?? null, counts: room.countItems(event), items: [...itemsByKey.values()].map(room.summarizeItem).slice(0, 60) });
  }));
  cleanup.add(room.onItemAdded((event) => recordItemEvent('item added', event?.item)));
  cleanup.add(room.onItemUpdated((event) => recordItemEvent('item updated', event?.item, event?.previous)));
  cleanup.add(room.onItemRemoved((event) => recordItemEvent('item removed', event?.item, event?.previous)));
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    const selector = itemSelector(controls);
    const options = { kind: itemKind(controls) };
    switch (event?.action) {
      case 'items.find':
        return rememberResult(storage, log, 'Find Items', furni.findItems(selector, options));
      case 'items.use':
        return rememberResult(storage, log, 'Use Item', furni.useFloorItem(selector, '0', options));
      case 'items.move':
        return rememberResult(storage, log, 'Move Item', furni.moveFloorItem(selector, numberValue(controls.moveX), numberValue(controls.moveY), numberValue(controls.direction), options));
      case 'items.rotate':
        return rememberResult(storage, log, 'Rotate Item', furni.rotateFloorItem(selector, numberValue(controls.direction), options));
      case 'items.pickup':
        return rememberResult(storage, log, 'Pick Up Item', furni.pickupItem({ ...selector, kind: itemKind(controls) }, options));
      default:
        return undefined;
    }
  }));
  async function recordItemEvent(reason, item, previous = null) {
    if (item && reason !== 'item removed') itemsByKey.set(room.itemKey(item), item);
    if (item && reason === 'item removed') itemsByKey.delete(room.itemKey(item));
    await storage.remember('lastItemEvent', { reason, item: room.summarizeItem(item), previous: room.summarizeItem(previous), total: itemsByKey.size });
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

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function itemKind(controls) {
  return controls.itemKind === 'floor' || controls.itemKind === 'wall' ? controls.itemKind : 'all';
}

function itemSelector(controls) {
  const text = textValue(controls.itemQuery);
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? { id, kind: itemKind(controls) } : { text, kind: itemKind(controls) };
}

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
