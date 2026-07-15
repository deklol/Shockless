// @name Automation Premade Module
// @group automation
// @desc Readable user-plugin source reference for the built-in Automation module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, runtime, avatar, furni, room, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Automation helpers ready: walk, use, and pick up matched room items through typed APIs.");

  const controls = { targetItem: '' };
  cleanup.add(runtime.onSnapshot((event) => storage.remember('automationTargets', {
    room: event?.room ?? null,
    floorItems: room.floorItemsFromSnapshot(event?.snapshot).map(room.summarizeItem).slice(0, 20),
    wallItems: room.wallItemsFromSnapshot(event?.snapshot).map(room.summarizeItem).slice(0, 20),
  })));
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    const selector = textValue(controls.targetItem);
    switch (event?.action) {
      case 'automation.walkToItem':
        return rememberResult(storage, log, 'Walk To Item', avatar.walkToItem(selector));
      case 'automation.useItem':
        return rememberResult(storage, log, 'Use Item', furni.useFloorItem({ text: selector }, '0'));
      case 'automation.pickupItems':
        return rememberResult(storage, log, 'Pick Up Matches', pickupEachMatchedItem(selector));
      default:
        return undefined;
    }
  }));
  async function pickupEachMatchedItem(selector) {
    const matches = await furni.findItems({ text: selector });
    const results = [];
    for (const item of matches) results.push(await furni.pickupItem(item));
    return results;
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

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
