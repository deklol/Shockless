export function activate(api) {
  const { log, packets, plugin, storage, subscriptions, ui } = api;
  const cleanup = subscriptions.create();
  const settings = {
    logPackets: true,
    prefix: "sample",
  };

  log.info(`${plugin.name || "Sample plugin"} activated.`);
  ui.setValue("prefix", settings.prefix);
  ui.setValue("logPackets", settings.logPackets);

  cleanup.add(ui.onAction(async (event) => {
    if (event.elementId === "logPackets") {
      settings.logPackets = event.value === true;
      await storage.set("logPackets", settings.logPackets);
      log.info(`packet logging ${settings.logPackets ? "enabled" : "disabled"}`);
      return;
    }

    if (event.elementId === "prefix") {
      settings.prefix = String(event.value || "sample");
      await storage.set("prefix", settings.prefix);
      log.info(`prefix set to ${settings.prefix}`);
      return;
    }

    if (event.action === "panel.ping") {
      await ui.setValue("lastPing", new Date().toLocaleTimeString());
      log.info("panel ping received");
      return;
    }

    if (event.action === "panel.clear") {
      await ui.setValue("lastPing", "-");
      log.info("panel status cleared");
      return;
    }

    if (event.action === "panel.selectRow") {
      log.info(`selected row ${event.value || "-"}`);
    }
  }));

  cleanup.add(packets.on("server", {}, (packet) => {
    if (settings.logPackets) log.info(`${settings.prefix}: ${packet.packetName ?? "UNKNOWN_HEADER"} [${packet.header ?? "-"}]`);
    return packet.allow();
  }));

  return cleanup.dispose;
}
