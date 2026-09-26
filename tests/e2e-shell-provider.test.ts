// e2e-shell-provider.test.ts — task 2.1.g1 (repair of 2.1h's GATE-FAILED windows-latest leg,
// actions/runner-images#14738: on that image's WebView2 >= 152 the tauri-driver -> msedgedriver
// route cannot create a session at all, so win32 moves to the embedded provider alongside darwin).
// e2e/shell/wdio.conf.ts takes its provider from `selectDriverProvider` only (no `driverProvider`
// grep on it needed here — this file is 2.1.g1's proof that the function itself is right for
// every platform and both override values).
import { describe, expect, it } from "vitest";
import { selectDriverProvider } from "../e2e/shell/provider.ts";

describe("selectDriverProvider: platform default (no override)", () => {
  it('linux -> "external" (tauri-driver + WebKitWebDriver under xvfb)', () => {
    expect(selectDriverProvider("linux", undefined)).toBe("external");
  });

  it('win32 -> "embedded" (WebView2 >= 152 on windows-latest cannot open a remote-debugging session)', () => {
    expect(selectDriverProvider("win32", undefined)).toBe("embedded");
  });

  it('darwin -> "embedded" (WKWebView has no external WebDriver route)', () => {
    expect(selectDriverProvider("darwin", undefined)).toBe("embedded");
  });
});

describe("selectDriverProvider: ESSAYDOWN_E2E_DRIVER wins on every platform, for both values", () => {
  const platforms = ["linux", "win32", "darwin"];
  const values = ["embedded", "external"] as const;

  for (const platform of platforms) {
    for (const override of values) {
      it(`${platform} + override "${override}" -> "${override}"`, () => {
        expect(selectDriverProvider(platform, override)).toBe(override);
      });
    }
  }
});

describe("selectDriverProvider: an override value outside embedded|external throws", () => {
  it("throws naming the bad value", () => {
    expect(() => selectDriverProvider("linux", "chrome")).toThrow(/chrome/);
  });

  it("throws on the empty string too (a set-but-blank env var is still a bad override, not absence)", () => {
    expect(() => selectDriverProvider("darwin", "")).toThrow();
  });
});
