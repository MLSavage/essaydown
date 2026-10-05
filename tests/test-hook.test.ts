import { describe, expect, it } from "vitest";
import { emptySidecar } from "../packages/core/src/sidecar.js";
import { format } from "../packages/core/src/format.js";
import { parse } from "../packages/core/src/parse.js";
import { createDocumentStore } from "../packages/editor/src/store.js";
import { createTestHook, installTestHook, type TestHookHost } from "../apps/desktop/src/workspace/test-hook.js";

/**
 * `window.__essaydown` (task 3.1; apps/desktop/src/workspace/test-hook.ts), the shell e2e's handle
 * on the open document's store. The e2e drives it in the real app; this file pins what each member
 * reads and that the uninstall never removes a newer pane's hook.
 */

const SOURCE = "One.\n\nTwo.\n\nThree.\n";

describe("createTestHook", () => {
  it("dispatches moveBlock as one snapshot, read back through markdown and snapshots", () => {
    const store = createDocumentStore(parse(SOURCE), emptySidecar());
    const hook = createTestHook(store);
    expect(hook.markdown()).toBe(SOURCE);
    expect(hook.snapshots()).toBe(1);
    hook.dispatch(hook.moveBlock(2, 0));
    expect(hook.markdown()).toBe("Three.\n\nOne.\n\nTwo.\n");
    expect(hook.snapshots()).toBe(2);
    store.getState().undo();
    expect(hook.markdown()).toBe(SOURCE);
  });

  it("reads the current sidecar as JSON and the cursor as the store holds it", () => {
    const store = createDocumentStore(parse(SOURCE), emptySidecar());
    const hook = createTestHook(store);
    expect(JSON.parse(hook.sidecar())).toEqual(emptySidecar());
    expect(hook.cursor()).toBeNull();
    store.getState().setCursor(3);
    expect(hook.cursor()).toBe(3);
  });

  it("serialises with format, the same bytes a save writes", () => {
    const store = createDocumentStore(parse("*a*\n"), emptySidecar());
    expect(createTestHook(store).markdown()).toBe(format(store.getState().document.root));
  });
});

describe("installTestHook", () => {
  it("installs the hook on the host and removes it on uninstall", () => {
    const host: TestHookHost = {};
    const uninstall = installTestHook(host, createDocumentStore(parse(SOURCE), emptySidecar()));
    expect(host.__essaydown?.markdown()).toBe(SOURCE);
    uninstall();
    expect(host.__essaydown).toBeUndefined();
  });

  it("leaves a newer install in place when an older one is uninstalled", () => {
    const host: TestHookHost = {};
    const uninstallOld = installTestHook(host, createDocumentStore(parse("old\n"), emptySidecar()));
    installTestHook(host, createDocumentStore(parse("new\n"), emptySidecar()));
    uninstallOld();
    expect(host.__essaydown?.markdown()).toBe("new\n");
  });
});
