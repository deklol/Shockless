import { describe, expect, it } from "vitest";
import { ScriptInstance, type GeneratedScriptModule } from "../../src/director/Runtime";
import { LingoPropList, LingoSymbol } from "../../src/director/values";
import {
  debugValue,
  isSensitiveDiagnosticInvocation,
  summarizeObject,
  summarizePropListSample,
  summarizeValue,
} from "../../src/habbo/room/RoomRuntimeDiagnostics";

const sessionModule: GeneratedScriptModule = {
  scriptName: "Session Handler Class",
  scriptType: "parent",
  scriptProperties: ["pItemList"],
  scriptGlobals: [],
  handlers: {},
};

describe("runtime diagnostic credential redaction", () => {
  it("redacts Steam identity and ticket values nested in source session state", () => {
    const session = new ScriptInstance(sessionModule);
    const values = new LingoPropList();
    values.addProp(LingoSymbol.for("steamID"), "76561198000000000");
    values.addProp(LingoSymbol.for("steamAuthTicket"), "fake-ticket-must-not-escape");
    values.addProp(LingoSymbol.for("user_name"), "dek");
    session.props.set("pitemlist", values);

    const output = JSON.stringify(summarizeObject(session, 3));
    expect(output).not.toContain("76561198000000000");
    expect(output).not.toContain("fake-ticket-must-not-escape");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("dek");
  });

  it("redacts keyed samples and prevents shallow collection stringification", () => {
    const values = new LingoPropList();
    values.addProp("steamAuthTicket", "fake-ticket-must-not-escape");

    expect(JSON.stringify(summarizePropListSample(values))).not.toContain("fake-ticket-must-not-escape");
    expect(JSON.stringify(summarizeValue(values, 0))).not.toContain("fake-ticket-must-not-escape");
    expect(JSON.stringify(debugValue(values))).not.toContain("fake-ticket-must-not-escape");
  });

  it("blocks diagnostic accessor calls that directly request Steam credentials", () => {
    expect(isSensitiveDiagnosticInvocation("get", [LingoSymbol.for("steamAuthTicket")])).toBe(true);
    expect(isSensitiveDiagnosticInvocation("set", ["steamID", "76561198000000000"])).toBe(true);
    expect(isSensitiveDiagnosticInvocation("get", ["user_name"])).toBe(false);
  });
});
