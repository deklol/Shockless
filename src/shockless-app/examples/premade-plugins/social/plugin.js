// @name Social Premade Module
// @group social
// @desc Readable user-plugin source reference for the built-in Social module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, social, packets, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Social helper ready: tracking messenger packets and routing social actions.");

  const controls = { friendName: '', accountId: 0, recipient: '', message: '' };
  const friendsByName = new Map();
  cleanup.add(packets.on('server', {}, rememberMessengerPacket));
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    const accountId = numberValue(controls.accountId);
    switch (event?.action) {
      case 'social.addUser':
        return rememberResult(storage, log, 'Add User', social.addUser(textValue(controls.friendName)));
      case 'social.message':
        return rememberResult(storage, log, 'Send Message', social.message(accountId, textValue(controls.message), { recipient: textValue(controls.recipient) }));
      case 'social.refreshRequests':
        return rememberResult(storage, log, 'Refresh Requests', social.refreshRequests());
      case 'social.acceptRequest':
        return rememberResult(storage, log, 'Accept Request', social.acceptRequest(accountId));
      case 'social.declineRequest':
        return rememberResult(storage, log, 'Decline Request', social.declineRequest(accountId));
      case 'social.followFriend':
        return rememberResult(storage, log, 'Follow Friend', social.followFriend(accountId));
      default:
        return undefined;
    }
  }));
  async function rememberMessengerPacket(packet) {
    if (!packets.hasName(packet, 'messenger', 'friend') && !packets.field(packet, /friend \d+ name/i)) return packet.allow();
    for (const field of packet.decodedFields ?? []) {
      if (/friend \d+ name/i.test(field.label)) friendsByName.set(String(field.value).toLowerCase(), { name: field.value, sourceLine: packet.lineNumber });
    }
    await storage.remember('latestMessengerPacket', packets.summary(packet));
    await storage.remember('friends', [...friendsByName.values()].slice(0, 50));
    return packet.allow();
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

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
