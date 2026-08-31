import { describe, expect, it, vi } from "vitest";
import { BladeController } from "@tweakpane/core";
import type { BladeApi, FolderApi, PluginPool } from "@tweakpane/core";
import { addDomBlade, DomBladePluginDefinition } from "./DomBladePlugin";

describe("addDomBlade", () => {
  it("creates the plugin blade through the folder", () => {
    const blade = {} as BladeApi;
    const folder = {
      addBlade: vi.fn(() => blade),
    } as unknown as FolderApi;
    const content = {} as HTMLElement;

    expect(addDomBlade(folder, content)).toBe(blade);
    expect(folder.addBlade).toHaveBeenCalledWith({
      view: "zartigl-dom",
      content,
    });
  });

  it("does not claim controllers owned by other Tweakpane plugins", () => {
    const api = DomBladePluginDefinition.api({
      controller: {} as BladeController,
      pool: {} as PluginPool,
    });
    expect(api).toBeNull();
  });
});
