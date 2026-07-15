// @name Chat Premade Module
// @group social
// @desc Readable user-plugin source reference for the built-in Chat module.
// @runtime Shockless plugin API

export async function activate(api) {
  const { log, storage, subscriptions, chat, ui } = api;
  const cleanup = subscriptions.create();
  log.info("Chat helper ready: listening to room chat and routing say/shout/whisper actions.");

  const controls = { chatMessage: '', whisperTarget: '' };
  const chatLog = [];
  cleanup.add(chat.onMessage(async (event) => {
    chatLog.push({ clientId: event?.clientId ?? null, user: event?.user?.name ?? event?.name ?? null, text: event?.text ?? '', mode: event?.mode ?? null, at: new Date().toISOString() });
    await storage.remember('chat', chatLog.slice(-100));
  }));
  cleanup.add(ui.onAction(async (event) => {
    rememberControlValue(controls, event);
    switch (event?.action) {
      case 'chat.say':
        return rememberResult(storage, log, 'Say', chat.say(textValue(controls.chatMessage)));
      case 'chat.shout':
        return rememberResult(storage, log, 'Shout', chat.shout(textValue(controls.chatMessage)));
      case 'chat.whisper':
        return rememberResult(storage, log, 'Whisper', chat.whisper(textValue(controls.whisperTarget), textValue(controls.chatMessage)));
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

async function rememberResult(storage, log, action, task) {
  const result = await task;
  await storage.remember('lastAction', { action, result });
  log.info(action + ': ' + (result?.message ?? 'done'));
  return result;
}
