// @name Wall Mover Premade Module
// @group automation
// @desc Readable user-plugin source reference for the built-in Wall Mover module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, furni, room, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Wall mover helper ready: tracking selected wall items and routing wall moves.");

  let selectedWallItem = null;
  cleanup.add(room.onWallItems(async (event) => {
    const walls = event?.wallItems ?? event?.items ?? [];
    selectedWallItem = room.keepSelectedWallItem(selectedWallItem, walls);
    await storage.remember('wallItems', {
      room: event?.room ?? null,
      count: walls.length,
      selected: (furni.wallMoveLocation(selectedWallItem) ?? room.summarizeItem(selectedWallItem)),
      items: walls.map(room.summarizeItem).slice(0, 25),
    });
  }));
  cleanup.add(room.onWallItemAdded((event) => rememberWallItemChange('room.wallItemAdded', event?.item)));
  cleanup.add(room.onWallItemUpdated((event) => rememberWallItemChange('room.wallItemUpdated', event?.item, event?.previous)));
  cleanup.add(room.onWallItemRemoved(async (event) => {
    if (room.objectId(event?.item) && room.objectId(event.item) === room.objectId(selectedWallItem)) selectedWallItem = null;
    await rememberWallItemChange('room.wallItemRemoved', event?.item, event?.previous);
  }));
  cleanup.add(ui.onAction(async (event) => {
    switch (event?.action) {
      case 'wall.moveLeft':
        return rememberResult(storage, log, 'Move Left', moveSelected(-1, 0));
      case 'wall.moveRight':
        return rememberResult(storage, log, 'Move Right', moveSelected(1, 0));
      case 'wall.moveUp':
        return rememberResult(storage, log, 'Move Up', moveSelected(0, -1));
      case 'wall.moveDown':
        return rememberResult(storage, log, 'Move Down', moveSelected(0, 1));
      case 'wall.flip':
        return rememberResult(storage, log, 'Flip', moveSelected(0, 0, flippedOrientation(selectedWallItem)));
      case 'wall.pickup':
        return rememberResult(storage, log, 'Pick Up Wall Item', pickupSelected());
      default:
        return undefined;
    }
  }));
  async function rememberWallItemChange(eventName, item, previous = null) {
    if (item && eventName !== 'room.wallItemRemoved') selectedWallItem = item;
    await storage.remember('lastWallItemEvent', {
      eventName,
      item: room.summarizeItem(item),
      previous: room.summarizeItem(previous),
      selected: (furni.wallMoveLocation(selectedWallItem) ?? room.summarizeItem(selectedWallItem)),
    });
  }
  async function moveSelected(deltaX = 0, deltaY = 0, orientation) {
    const location = furni.wallMoveLocation(selectedWallItem, { deltaX, deltaY, orientation });
    if (!location) throw new Error('No selected wall item with movable wall/local coordinates.');
    return furni.moveWallItem(selectedWallItem, location);
  }
  async function pickupSelected() {
    const id = room.objectId(selectedWallItem);
    if (!id) throw new Error('No selected wall item object id.');
    return furni.pickupWallItem({ kind: 'wall', itemId: id });
  }

  return cleanup.dispose;
}

function flippedOrientation(item) {
  const current = String(item?.orientation ?? item?.dir ?? 'r').toLowerCase();
  return current === 'l' ? 'r' : 'l';
}

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
