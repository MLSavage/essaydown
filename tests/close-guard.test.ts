import { describe, expect, it } from "vitest";
import { decideClose } from "../apps/desktop/src/workspace/close-guard.js";

// apps/desktop/src/workspace/close-guard.ts (task 2.17): the window's close handler flushes the
// open document and destroys the window only when the disk holds the editor's document.

describe("decideClose", () => {
  it("destroys the window when the flush found nothing to save (clean)", () => {
    expect(decideClose("clean")).toEqual({ action: "destroy" });
  });

  it("destroys the window when the flush saved the pending edit (saved)", () => {
    expect(decideClose("saved")).toEqual({ action: "destroy" });
  });

  it("keeps the window open with the conflict banner's instruction (conflict)", () => {
    const decision = decideClose("conflict");
    expect(decision.action).toBe("stay");
    expect(decision.action === "stay" && decision.waits).toMatch(/Changed on disk/);
  });

  it("keeps the window open with the unsaved line (failed)", () => {
    const decision = decideClose("failed");
    expect(decision.action).toBe("stay");
    expect(decision.action === "stay" && decision.waits).toMatch(/not saved/);
  });
});
