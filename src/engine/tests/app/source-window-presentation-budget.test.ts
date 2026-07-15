import { describe, expect, it } from "vitest";
import { SourceWindowPresentationBudget } from "../../src/render/SourceWindowPresentationBudget";

describe("Source window presentation budget", () => {
  it("spreads text preparation but keeps sprite state synchronous", () => {
    const budget = new SourceWindowPresentationBudget();
    budget.configure({
      enabled: true,
      channels: new Set([10, 11, 12]),
      maxTextPreparationsPerFrame: 1,
      maxSpriteUpdatesPerFrame: 1,
    });

    budget.beginFrame();

    expect(budget.shouldPrepareTextChannel(10, false)).toBe(true);
    expect(budget.shouldPrepareTextChannel(11, false)).toBe(false);
    expect(budget.hasDeferredWork()).toBe(true);

    budget.recordSpriteChannelPresentation(10);
    budget.recordSpriteChannelPresentation(11);
    budget.recordSpriteChannelPresentation(12);

    expect(budget.diagnostics()).toMatchObject({
      preparedText: 1,
      deferredText: 1,
      appliedSprites: 3,
      deferredSprites: 0,
    });
  });

  it("never budgets focused text channels", () => {
    const budget = new SourceWindowPresentationBudget();
    budget.configure({
      enabled: true,
      channels: new Set([1, 2]),
      maxTextPreparationsPerFrame: 1,
    });

    budget.beginFrame();

    expect(budget.shouldPrepareTextChannel(1, true)).toBe(true);
    expect(budget.shouldPrepareTextChannel(2, true)).toBe(true);
    expect(budget.diagnostics()).toMatchObject({
      preparedText: 0,
      deferredText: 0,
    });
  });
});
