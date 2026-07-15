import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClassName, parseFurnidataText } from "../src/main/furnidata";

test("furnidata parser reads current Origins JSON rows", () => {
  const entries = parseFurnidataText(
    JSON.stringify([
      ["s", "9826664", "farm_orange", "1", "0", "1", "1", "0,0,0", "Orange Tree", "A small citrus tree", "", "garden", "true", "-1", "false", "", "1", "true", "0", "0", "0", "false"],
      ["i", "123", "poster_skull", "1", "0", "0", "0", "", "Skull Poster", "Wall art", "", "wall", "true", "-1", "false", "", "1", "true", "0", "0", "0", "true"],
    ]),
  );

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    id: "9826664",
    className: "farm_orange",
    kind: "floor",
    name: "Orange Tree",
    description: "A small citrus tree",
    category: "garden",
    width: 1,
    height: 1,
    rare: false,
  });
  assert.equal(entries[1]?.kind, "wall");
  assert.equal(entries[1]?.name, "Skull Poster");
  assert.equal(entries[1]?.rare, true);
});

test("furnidata parser reads concatenated cached JSON arrays", () => {
  const entries = parseFurnidataText(
    `${JSON.stringify([["s", "118", "table_plasto_square*9", "1", "0", "1", "1", "#ffffff,#533e10", "Square Dining Table", "Hip plastic furniture", "", "103"]])}
${JSON.stringify([["s", "119", "chair_plasto", "1", "0", "1", "1", "#ffffff,#533e10", "Dining Chair", "Hip plastic seating", "", "102"]])}`,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.className, "table_plasto_square*9");
  assert.equal(entries[0]?.name, "Square Dining Table");
  assert.equal(entries[1]?.name, "Dining Chair");
});

test("furnidata parser keeps legacy XML compatibility and normalizes ZaC class prefixes", () => {
  const entries = parseFurnidataText(`
    <furnitype id="77" classname="pumpkin">
      <category>garden</category>
      <name>Pumpkin</name>
      <description>Seasonal vegetable</description>
      <rare>1</rare>
    </furnitype>
  `);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "77");
  assert.equal(entries[0]?.name, "Pumpkin");
  assert.equal(entries[0]?.rare, true);
  assert.equal(normalizeClassName("ZaCpumpkin"), "pumpkin");
});
