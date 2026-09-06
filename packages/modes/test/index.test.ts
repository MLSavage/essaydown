import { describe, expect, it } from "vitest";
import { placeholder } from "../src/index.js";

describe("@essaydown/modes placeholder", () => {
  it("returns the package name", () => {
    expect(placeholder()).toBe("modes");
  });
});
