import { describe, expect, it } from "vitest";
import { Runtime, UnsupportedFeatureError } from "../../src/director/Runtime";
import { LINGO_VOID, type LingoObjectLike } from "../../src/director/values";
import { directorXtraRegistration, directorXtraRegistrations } from "../../src/director/xtras";
import { XmlParserInstance, XmlParserXtraRef } from "../../src/director/xml";

describe("Director Xtra lookup", () => {
  it("keeps the release331 Xtra inventory explicit and case-insensitive", () => {
    expect(directorXtraRegistrations().map((entry) => entry.name)).toEqual([
      "XMLParser",
      "Multiuser",
      "BobbaXtra",
      "Curl",
      "FileIO",
      "SteamXtra",
    ]);
    expect(directorXtraRegistration("cUrL")?.status).toBe("absent");
    expect(directorXtraRegistration("unknown-xtra")).toBeNull();
  });

  it("returns VOID for absent optional Xtras so source fallback guards can run", () => {
    const runtime = new Runtime();
    for (const name of ["Curl", "FileIO", "UnknownXtra"]) {
      const ref = runtime.call("xtra", [name]);
      expect(ref).toBe(LINGO_VOID);
      expect(runtime.call("voidP", [ref])).toBe(1);
      expect(runtime.call("new", [ref])).toBe(LINGO_VOID);
      expect(runtime.callMethod(ref, "new", [])).toBe(LINGO_VOID);
    }
    expect(runtime.unsupportedDiagnostics().entries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("xtra Curl unavailable"),
        expect.stringContaining("xtra UnknownXtra unavailable"),
      ]),
    );
  });

  it("retains runtime and host implementations", () => {
    const xmlRuntime = new Runtime();
    const xmlRef = xmlRuntime.call("xtra", ["xmlparser"]);
    expect(xmlRef).toBeInstanceOf(XmlParserXtraRef);
    expect(xmlRuntime.call("new", [xmlRef])).toBeInstanceOf(XmlParserInstance);

    const hostRef: LingoObjectLike = { lingoType: "customXtra" };
    const hostRuntime = new Runtime({
      call(name, args) {
        return name === "xtra" && args[0] === "CustomHostXtra" ? hostRef : undefined;
      },
    });
    expect(hostRuntime.call("xtra", ["CustomHostXtra"])).toBe(hostRef);
  });

  it("fails when an implemented Xtra loses its registered provider", () => {
    const runtime = new Runtime();
    expect(() => runtime.call("xtra", ["Multiuser"])).toThrow(UnsupportedFeatureError);
    expect(() => runtime.call("xtra", ["SteamXtra"])).toThrow(UnsupportedFeatureError);
    expect(runtime.unsupportedDiagnostics().entries[0]).toContain("registered as implemented");
  });
});
