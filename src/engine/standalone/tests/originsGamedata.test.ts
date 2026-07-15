import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientVersionIdFromExternalVariables, normalizeOriginsExternalVariables } from "../src/main/originsGamedata.js";

describe("Origins gamedata variable normalization", () => {
  it("adds source-required persistent data URLs when a compiled profile omits them", () => {
    const normalized = normalizeOriginsExternalVariables(
      [
        "client.version.id=401",
        "flash.dynamic.download.url=//images.habbo.com//dcr/hof_furni/",
        "cast.entry.1=hh_interface",
      ].join("\r"),
    );

    assert.match(normalized, /(?:^|\r)dynamic\.download\.url=\/\/images\.habbo\.com\/\/dcr\/hof_furni\//);
    assert.match(normalized, /(?:^|\r)furnidata\.load\.url=furnidata\.txt/);
    assert.match(normalized, /(?:^|\r)productdata\.load\.url=productdata\.txt/);
  });

  it("preserves profile-provided persistent data URLs", () => {
    const normalized = normalizeOriginsExternalVariables(
      [
        "dynamic.download.url=custom/",
        "furnidata.load.url=local-furni.txt",
        "productdata.load.url=local-product.txt",
      ].join("\n"),
    );

    assert.equal(countKey(normalized, "dynamic.download.url"), 1);
    assert.equal(countKey(normalized, "furnidata.load.url"), 1);
    assert.equal(countKey(normalized, "productdata.load.url"), 1);
    assert.match(normalized, /(?:^|\r)furnidata\.load\.url=local-furni\.txt/);
    assert.match(normalized, /(?:^|\r)productdata\.load\.url=local-product\.txt/);
  });

  it("can read the source-authored client.version.id for diagnostics", () => {
    assert.equal(clientVersionIdFromExternalVariables("foo=bar\rclient.version.id=401\r"), 401);
    assert.equal(clientVersionIdFromExternalVariables("client.version.id=not-a-number\r"), null);
  });
});

function countKey(text: string, key: string): number {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.slice(0, line.indexOf("=")).trim().toLowerCase() === key.toLowerCase()).length;
}
