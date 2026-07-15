import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientLibraryStore } from "../src/main/clientLibrary";
import { accountStorePath } from "../src/main/encryptedAccountStore";
import { MultiSessionManager } from "../src/main/multiSessionManager";
import { consoleArgsText, parseConsoleCommand, redactConsoleCommandInput } from "../src/shared/consoleCommand";
import { buildMimicRelayPacketFromControl } from "../src/shared/mimicRelayPackets";
import { parseMultiClientAccounts } from "../src/shared/multiClientAccounts";

function emptyLibrary(): ClientLibraryStore {
  return {
    selectedProfile: () => null,
  } as unknown as ClientLibraryStore;
}

test("console parser keeps quoted arguments and selected target by default", () => {
  const parsed = parseConsoleCommand('say "hello from client one" --loud');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.command, "say");
  assert.deepEqual(parsed.command.args, ["hello from client one"]);
  assert.deepEqual(parsed.command.flags, [{ name: "loud", value: true }]);
  assert.deepEqual(parsed.command.target, { kind: "selected", raw: null });
  assert.equal(consoleArgsText(parsed.command), "hello from client one");
});

test("console parser accepts explicit client and all-session target prefixes", () => {
  const client = parseConsoleCommand("@1 message dek hello");
  assert.equal(client.ok, true);
  if (!client.ok) return;
  assert.equal(client.command.target.kind, "clientId");
  assert.equal(client.command.target.clientId, 1);
  assert.equal(client.command.command, "message");
  assert.deepEqual(client.command.args, ["dek", "hello"]);

  const all = parseConsoleCommand("@all say :sit");
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.deepEqual(all.command.target, { kind: "all", raw: "all" });
  assert.equal(all.command.inputWithoutTarget, "say :sit");
});

test("console parser supports known value flags without swallowing normal arguments", () => {
  const parsed = parseConsoleCommand('login fake@example.test:secret --headless --label "Trade Bot"');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.args, ["fake@example.test:secret"]);
  assert.deepEqual(parsed.command.flags, [
    { name: "headless", value: true },
    { name: "label", value: "Trade Bot" },
  ]);

  const load = parseConsoleCommand("load accounts.txt 3 --headless --summon --concurrency 4");
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.deepEqual(load.command.args, ["accounts.txt", "3"]);
  assert.deepEqual(load.command.flags, [
    { name: "headless", value: true },
    { name: "summon", value: true },
    { name: "concurrency", value: "4" },
  ]);

  const summon = parseConsoleCommand('summon 2 --main-name dek --active-name shockless --main-room-id 44390 --main-room-name "Codex Test LAB"');
  assert.equal(summon.ok, true);
  if (!summon.ok) return;
  assert.deepEqual(summon.command.args, ["2"]);
  assert.deepEqual(summon.command.flags, [
    { name: "main-name", value: "dek" },
    { name: "active-name", value: "shockless" },
    { name: "main-room-id", value: "44390" },
    { name: "main-room-name", value: "Codex Test LAB" },
  ]);

  const windowsPath = parseConsoleCommand('load "F:\\alts\\test accounts.txt" 3 --headless');
  assert.equal(windowsPath.ok, true);
  if (!windowsPath.ok) return;
  assert.deepEqual(windowsPath.command.args, ["F:\\alts\\test accounts.txt", "3"]);

  const accountImport = parseConsoleCommand('accounts import "F:\\alts\\test accounts.txt" --key-env HABBPY_V4_TEST_KEY');
  assert.equal(accountImport.ok, true);
  if (!accountImport.ok) return;
  assert.deepEqual(accountImport.command.args, ["import", "F:\\alts\\test accounts.txt"]);
  assert.deepEqual(accountImport.command.flags, [{ name: "key-env", value: "HABBPY_V4_TEST_KEY" }]);
});

test("console redaction hides login credentials from echoed command output", () => {
  assert.equal(redactConsoleCommandInput("login fake@example.test:super-secret --headless"), "login [credentials] --headless");
  assert.equal(redactConsoleCommandInput("@2 login fake@example.test:super-secret --headless"), "@2 login [credentials] --headless");
  assert.equal(redactConsoleCommandInput("load multiclient-accounts.txt 3 --headless"), "load multiclient-accounts.txt 3 --headless");
});

test("multi-client account parser accepts local test file shape without logging secrets", () => {
  const parsed = parseMultiClientAccounts(
    [
      "TradeBot1",
      "fake1@example.test:first-secret",
      "TradeBot2",
      "fake2@example.test:second-secret",
    ].join("\n"),
  );
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.accounts[0]?.label, "TradeBot1");
  assert.equal(parsed.accounts[0]?.email, "fake1@example.test");
  assert.equal(parsed.accounts[0]?.password, "first-secret");
  assert.deepEqual(parsed.warnings, []);
});

test("console parser rejects unclosed quotes", () => {
  const parsed = parseConsoleCommand('say "unfinished');
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.message, /Unclosed quote/);
});

test("mimic relay packet validation allows v3-style avatar packets and rejects sensitive headers", () => {
  const chat = buildMimicRelayPacketFromControl({ header: 52, bodyHex: "68 69", packetName: "CHAT" });
  assert.equal(chat.ok, true);
  if (chat.ok) {
    assert.equal(chat.packet.header, 52);
    assert.equal(chat.packet.bodyHex, "6869");
    assert.deepEqual([...chat.packet.body], [0x68, 0x69]);
  }

  const legacyWave = buildMimicRelayPacketFromControl({ header: 94, bodyHex: "", packetName: "UNKNOWN_HEADER" });
  assert.equal(legacyWave.ok, true);

  const originsMove = buildMimicRelayPacketFromControl({ header: 1269, bodyHex: "514252417041407c7f5f", packetName: "ORIGINS_MOVE" });
  assert.equal(originsMove.ok, true);

  const sensitive = buildMimicRelayPacketFromControl({ header: 6, bodyHex: "0102", packetName: "UNIQUEID" });
  assert.equal(sensitive.ok, false);
  if (!sensitive.ok) assert.match(sensitive.message, /sensitive/i);

  const rights = buildMimicRelayPacketFromControl({ header: 96, bodyHex: "0102", packetName: "ASSIGNRIGHTS" });
  assert.equal(rights.ok, false);

  const badHex = buildMimicRelayPacketFromControl({ header: 52, bodyHex: "abc", packetName: "CHAT" });
  assert.equal(badHex.ok, false);
});

test("single-client manager exposes list/select/rename and validates targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-console-"));
  try {
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const list = await manager.runConsoleCommand("list");
    assert.equal(list.handled, true);
    assert.equal(list.ok, true);
    assert.match(list.lines.join("\n"), /1 Main/);

    const start = await manager.runConsoleCommand("start");
    assert.equal(start.handled, true);
    assert.equal(start.ok, false);
    assert.match(start.lines.join("\n"), /client1: not-configured - Register an existing Shockless profile or clients folder before embedding/);

    const launch = await manager.runConsoleCommand("launch");
    assert.equal(launch.handled, true);
    assert.equal(launch.ok, false);
    assert.match(launch.lines.join("\n"), /client1: not-configured - Register an existing Shockless profile or clients folder before embedding/);

    const newClient = await manager.runConsoleCommand("newclient");
    assert.equal(newClient.handled, true);
    assert.equal(newClient.ok, false);
    assert.match(newClient.lines.join("\n"), /No ready profile selected/);
    assert.equal(manager.sessions().sessions.length, 1);

    const snapshot = await manager.clientSnapshot();
    assert.equal(snapshot.client?.id, 1);
    assert.equal(snapshot.runtime?.source, "none");
    assert.equal(snapshot.relay?.clientId, 1);
    const snapshots = await manager.clientSnapshots();
    assert.equal(snapshots.clients.length, 1);

    const renamed = await manager.runConsoleCommand("rename 1 TradeBot");
    assert.equal(renamed.handled, true);
    assert.equal(renamed.ok, true);
    assert.match(renamed.lines[0] ?? "", /TradeBot/);
    assert.equal(manager.sessions().sessions[0]?.label, "TradeBot");

    const selectedByLabel = await manager.runConsoleCommand("select TradeBot");
    assert.equal(selectedByLabel.handled, true);
    assert.equal(selectedByLabel.ok, true);
    assert.equal(manager.sessions().selectedClientId, 1);

    const mainByLabel = await manager.runConsoleCommand("main TradeBot");
    assert.equal(mainByLabel.handled, true);
    assert.equal(mainByLabel.ok, true);
    assert.match(mainByLabel.lines.join("\n"), /main\/summoner/);

    const routed = await manager.runConsoleCommand("@1 say hello");
    assert.equal(routed.handled, false);
    assert.equal(routed.ok, true);
    assert.deepEqual(routed.targetClientIds, [1]);
    assert.equal(routed.passthroughInput, "say hello");

    const input = await manager.runConsoleCommand("input 1 hello");
    assert.equal(input.handled, false);
    assert.equal(input.ok, true);
    assert.deepEqual(input.targetClientIds, [1]);
    assert.equal(input.passthroughInput, "say hello");

    const all = await manager.runConsoleCommand("@all room");
    assert.equal(all.handled, false);
    assert.deepEqual(all.targetClientIds, [1]);

    const missing = await manager.runConsoleCommand("@2 room");
    assert.equal(missing.handled, true);
    assert.equal(missing.ok, false);
    assert.match(missing.lines[0] ?? "", /not running/);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager persists aliases, bindings, scripts, and redacted command history", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-command-state-"));
  try {
    const scriptPath = join(root, "console-script.txt");
    writeFileSync(scriptPath, ["# local smoke script", "alias who list", "who", "bind F1 who", "bindings"].join("\n"), "utf8");
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const alias = await manager.runConsoleCommand("alias who list");
    assert.equal(alias.ok, true);
    assert.match(alias.lines.join("\n"), /alias who = list/);

    const expanded = await manager.runConsoleCommand("who");
    assert.equal(expanded.ok, true);
    assert.match(expanded.lines.join("\n"), /alias who -> list/);
    assert.match(expanded.lines.join("\n"), /1 Main/);

    const bind = await manager.runConsoleCommand("bind F1 who");
    assert.equal(bind.ok, true);
    assert.match(bind.lines.join("\n"), /bound F1 -> who/);

    const bound = await manager.runConsoleBinding("f1");
    assert.equal(bound.ok, true);
    assert.match(bound.lines.join("\n"), /1 Main/);

    const script = await manager.runConsoleCommand(`exec "${scriptPath}"`);
    assert.equal(script.handled, true);
    assert.equal(script.ok, true);
    assert.match(script.lines.join("\n"), /exec .*console-script\.txt: 4 command/);
    assert.match(script.lines.join("\n"), /F1 -> who/);

    const dryRunPath = join(root, "console-dry-run.txt");
    writeFileSync(dryRunPath, ["alias drywho list", "drywho", "bind F3 drywho", "bindings"].join("\n"), "utf8");
    const dryRun = await manager.runConsoleCommand(`exec "${dryRunPath}" --dry-run`);
    assert.equal(dryRun.handled, true);
    assert.equal(dryRun.ok, true);
    assert.match(dryRun.lines.join("\n"), /\[dry-run\]/);
    assert.match(dryRun.lines.join("\n"), /alias drywho -> list/);
    assert.equal(manager.consoleCommandState().aliases.some((entry) => entry.name === "drywho"), false);
    assert.equal(manager.consoleCommandState().bindings.some((entry) => entry.key === "F3"), false);

    await manager.runConsoleCommand("login fake@example.test:super-secret --headless");
    const history = await manager.runConsoleCommand("history 20");
    const historyOutput = history.lines.join("\n");
    assert.match(historyOutput, /login \[credentials\] --headless/);
    assert.doesNotMatch(historyOutput, /fake@example|super-secret/);

    const state = manager.consoleCommandState();
    assert.equal(state.aliases.some((entry) => entry.name === "who" && entry.expansion === "list"), true);
    assert.equal(state.bindings.some((entry) => entry.key === "F1" && entry.command === "who"), true);
    manager.dispose();

    const nextManager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });
    const persisted = nextManager.consoleCommandState();
    assert.equal(persisted.aliases.some((entry) => entry.name === "who" && entry.expansion === "list"), true);
    assert.equal(persisted.bindings.some((entry) => entry.key === "F1" && entry.command === "who"), true);
    assert.equal(persisted.history.join("\n").includes("super-secret"), false);
    nextManager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager load command creates headless client records from a temporary fake account file", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-multiclient-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(
      accountPath,
      [
        "TradeBot1",
        "fake1@example.test:first-secret",
        "TradeBot2",
        "fake2@example.test:second-secret",
      ].join("\n"),
      "utf8",
    );
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const loaded = await manager.runConsoleCommand(`load "${accountPath}" 2 --headless`);
    assert.equal(loaded.handled, true);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.level, "warning");
    assert.match(loaded.lines.join("\n"), /Started 2 client/);
    assert.match(loaded.lines.join("\n"), /Plaintext account file warning/);
    assert.doesNotMatch(loaded.lines.join("\n"), /first-secret|second-secret|fake1@example|fake2@example/);
    const sessions = manager.sessions().sessions;
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((session) => session.headless).length, 2);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager routes gpu diagnostics to hidden clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-headless-gpu-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(accountPath, ["TradeBot1", "fake1@example.test:first-secret"].join("\n"), "utf8");
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    await manager.runConsoleCommand(`load "${accountPath}" 1 --headless`);
    const clients = (manager as unknown as { clients: Map<number, { hiddenWindow: unknown }> }).clients;
    const client2 = clients.get(2);
    assert.ok(client2);
    let executedScript = "";
    client2.hiddenWindow = {
      isDestroyed: () => false,
      destroy: () => undefined,
      close: () => undefined,
      webContents: {
        executeJavaScript: async (script: string) => {
          executedScript = script;
          return { webgl: true, vendor: "Test Vendor", renderer: "Test Renderer" };
        },
      },
    };

    const gpu = await manager.runConsoleCommand("@headless gpu");
    assert.equal(gpu.handled, true);
    assert.equal(gpu.ok, true);
    assert.match(gpu.lines.join("\n"), /Test Renderer/);
    assert.match(executedScript, /WEBGL_debug_renderer_info/);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager skips loading duplicate active account labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-duplicate-account-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(
      accountPath,
      [
        "TradeBot1",
        "fake1@example.test:first-secret",
        "TradeBot2",
        "fake2@example.test:second-secret",
      ].join("\n"),
      "utf8",
    );
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });
    manager.renameClient(1, "TradeBot1");

    const loaded = await manager.runConsoleCommand(`load "${accountPath}" 2 --headless`);
    assert.equal(loaded.handled, true);
    assert.equal(loaded.ok, false);
    assert.match(loaded.lines.join("\n"), /Skipped 1 duplicate active account\(s\): TradeBot1/);
    assert.match(loaded.lines.join("\n"), /client2: TradeBot2/);
    assert.equal(manager.sessions().sessions.length, 2);
    assert.equal(manager.sessions().sessions.some((session) => session.label === "TradeBot1" && session.id !== 1), false);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager skips visible main account by injected main name even when account label has notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-visible-main-duplicate-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(
      accountPath,
      [
        "dek (main test account)",
        "fake-main@example.test:main-secret",
        "TradeBot2",
        "fake2@example.test:second-secret",
      ].join("\n"),
      "utf8",
    );
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const loaded = await manager.runConsoleCommand(`load "${accountPath}" 2 --headless --main-name dek`);
    assert.equal(loaded.handled, true);
    assert.equal(loaded.ok, false);
    assert.match(loaded.lines.join("\n"), /Skipped 1 duplicate active account\(s\): dek \(main test account\)/);
    assert.match(loaded.lines.join("\n"), /client2: TradeBot2/);
    assert.equal(manager.sessions().sessions.length, 2);
    assert.equal(manager.sessions().sessions.some((session) => session.label === "dek (main test account)" && session.id !== 1), false);
    assert.doesNotMatch(loaded.lines.join("\n"), /main-secret|second-secret|fake-main@example|fake2@example/);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager returns renderer room-entry actions when summoning visible clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-visible-summon-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(accountPath, ["TradeBot2", "fake2@example.test:second-secret"].join("\n"), "utf8");
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const loaded = await manager.runConsoleCommand(`load "${accountPath}" 1`);
    assert.equal(loaded.handled, true);
    assert.equal(manager.sessions().sessions.some((session) => session.id === 2 && session.visible), true);

    const clients = (manager as unknown as { clients: Map<number, { embed: { status: () => unknown } }> }).clients;
    const client2 = clients.get(2);
    assert.ok(client2);
    client2.embed.status = () => ({
      status: "running",
      embeddedUrl: "http://127.0.0.1:12345/?profile=test",
      profile: null,
      buildLabel: "Test profile",
      message: "test visible runtime",
      settings: null,
    });
    (manager as unknown as { resolveSocialAccountId: () => number | null }).resolveSocialAccountId = () => 233421;

    const summoned = await manager.runConsoleCommand('summon all --main-room-id 44390 --main-room-name "Codex Test LAB"');
    assert.equal(summoned.handled, true);
    assert.equal(summoned.ok, true);
    assert.doesNotMatch(summoned.lines.join("\n"), /no hidden runtime/i);
    assert.match(summoned.lines.join("\n"), /queued visible runtime room entry/);
    assert.doesNotMatch(summoned.lines.join("\n"), /summon follow/i);
    assert.deepEqual(summoned.rendererActions, [
      {
        kind: "enterPrivateRoom",
        clientId: 2,
        flatId: "44390",
        roomName: "Codex Test LAB",
        reason: "summon",
      },
    ]);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager returns renderer room-entry actions for targeted visible enterroom", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-visible-enterroom-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(accountPath, ["TradeBot2", "fake2@example.test:second-secret"].join("\n"), "utf8");
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const loaded = await manager.runConsoleCommand(`load "${accountPath}" 1`);
    assert.equal(loaded.handled, true);
    assert.equal(manager.sessions().sessions.some((session) => session.id === 2 && session.visible), true);

    const entered = await manager.runConsoleCommand("@2 enterroom 44390");
    assert.equal(entered.handled, true);
    assert.equal(entered.ok, true);
    assert.match(entered.lines.join("\n"), /queued visible runtime room entry/);
    assert.deepEqual(entered.targetClientIds, [2]);
    assert.deepEqual(entered.rendererActions, [
      {
        kind: "enterPrivateRoom",
        clientId: 2,
        flatId: "44390",
        reason: "manual",
      },
    ]);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager encrypted account store imports, lists, and loads without leaking credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-account-store-"));
  const envName = "HABBPY_V4_CONSOLE_TEST_ACCOUNT_KEY";
  const previousKey = process.env[envName];
  process.env[envName] = "console-test-store-key";
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(
      accountPath,
      [
        "TradeBot1",
        "fake1@example.test:first-secret",
        "TradeBot2",
        "fake2@example.test:second-secret",
      ].join("\n"),
      "utf8",
    );
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const imported = await manager.runConsoleCommand(`accounts import "${accountPath}" --key-env ${envName}`);
    assert.equal(imported.handled, true);
    assert.equal(imported.ok, true);
    assert.match(imported.lines.join("\n"), /Imported 2 account/);
    assert.doesNotMatch(imported.lines.join("\n"), /first-secret|second-secret|fake1@example|fake2@example/);

    const storeText = readFileSync(accountStorePath(root), "utf8");
    assert.doesNotMatch(storeText, /first-secret|second-secret|fake1@example|fake2@example/);

    const listed = await manager.runConsoleCommand(`accounts list --key-env ${envName}`);
    assert.equal(listed.ok, true);
    assert.match(listed.lines.join("\n"), /TradeBot1/);
    assert.match(listed.lines.join("\n"), /TradeBot2/);
    assert.doesNotMatch(listed.lines.join("\n"), /first-secret|second-secret|fake1@example|fake2@example/);

    const loaded = await manager.runConsoleCommand(`load-store 1 --headless --key-env ${envName}`);
    assert.equal(loaded.handled, true);
    assert.equal(loaded.ok, false);
    assert.match(loaded.lines.join("\n"), /Encrypted account store load/);
    assert.doesNotMatch(loaded.lines.join("\n"), /first-secret|second-secret|fake1@example|fake2@example/);
    assert.equal(manager.sessions().sessions.length, 2);
    assert.equal(manager.sessions().sessions.filter((session) => session.headless).length, 1);
    manager.dispose();
  } finally {
    if (previousKey === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previousKey;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager handles common console commands in one bulk smoke pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "habbpy-v4-command-bulk-"));
  try {
    const accountPath = join(root, "fake-accounts.txt");
    writeFileSync(
      accountPath,
      [
        "TradeBot1",
        "fake1@example.test:first-secret",
        "TradeBot2",
        "fake2@example.test:second-secret",
      ].join("\n"),
      "utf8",
    );
    const manager = new MultiSessionManager({
      appDataPath: root,
      library: emptyLibrary(),
    });

    const commands = [
      "help",
      `load "${accountPath}" 2 --headless`,
      "list",
      "select 2",
      "main 2",
      "rename 2 AltOne",
      "@all room",
      "@headless fps",
      "input 2 hello from bulk smoke",
      "mimic status",
      "mimic on --source 1",
      "mimic set speech off",
      "mimic source 2",
      "mimic off",
      "close 3",
      "close all --keep-main",
    ];
    const results = [];
    for (const command of commands) {
      results.push([command, await manager.runConsoleCommand(command)] as const);
    }

    assert.equal(results.filter(([command, result]) => command.startsWith("load ") && !result.ok).length, 1);
    assert.equal(results.every(([command, result]) => command.startsWith("load ") || result.ok), true);
    assert.equal(manager.mimicStateSnapshot().categories.speech, false);
    assert.equal(manager.sessions().sessions.some((session) => session.id === 2), true);
    assert.equal(manager.sessions().sessions.some((session) => session.id === 3), false);
    const output = results.flatMap(([, result]) => result.lines).join("\n");
    assert.doesNotMatch(output, /first-secret|second-secret|fake1@example|fake2@example/);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
