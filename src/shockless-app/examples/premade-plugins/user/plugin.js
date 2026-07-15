// @name User Premade Module
// @group user
// @desc Readable user-plugin source reference for the built-in User module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, avatar, room, ui } = api;
  const cleanup = subscriptions.create();
  log.info("User helper ready: tracking room users and routing avatar actions.");

  const controls = { walkX: 0, walkY: 0, itemSelector: '', danceNumber: 1 };
  let selectedUser = null;
  cleanup.add(room.onUsers(async (event) => {
    const users = event?.users ?? [];
    selectedUser = users.find((user) => user?.isSelf) ?? users[0] ?? null;
    await storage.remember('selectedUser', selectedUser);
  }));
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    switch (event?.action) {
      case 'user.walkTile':
        return rememberResult(storage, log, 'Walk To Tile', avatar.walkTo(numberValue(controls.walkX), numberValue(controls.walkY), 0));
      case 'user.walkItem':
        return rememberResult(storage, log, 'Walk To Item', avatar.walkToItem(textValue(controls.itemSelector)));
      case 'user.wave':
        return rememberResult(storage, log, 'Wave', avatar.wave());
      case 'user.dance':
        return rememberResult(storage, log, 'Dance', avatar.dance(numberValue(controls.danceNumber, 1)));
      case 'user.carryDrink':
        return rememberResult(storage, log, 'Carry Drink', avatar.carryDrink());
      default:
        return undefined;
    }
  }));

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

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
