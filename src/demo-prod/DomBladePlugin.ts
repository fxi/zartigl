import {
  BladeApi,
  BladeController,
  createPlugin,
} from "@tweakpane/core";
import type {
  BaseBladeParams,
  BladePlugin,
  FolderApi,
  Blade,
  PluginPool,
  TpPluginBundle,
  View,
  ViewProps,
} from "@tweakpane/core";

interface DomBladeParams extends BaseBladeParams {
  view: "zartigl-dom";
  content: HTMLElement;
}

class DomBladeView implements View {
  readonly element: HTMLDivElement;

  constructor(document: Document, viewProps: ViewProps, content: HTMLElement) {
    this.element = document.createElement("div");
    this.element.classList.add("tp-zartigl-domv");
    viewProps.bindClassModifiers(this.element);
    this.element.appendChild(content);
  }
}

class DomBladeController extends BladeController<DomBladeView> {
  constructor(
    document: Document,
    config: { blade: Blade; viewProps: ViewProps; content: HTMLElement },
  ) {
    super({
      blade: config.blade,
      view: new DomBladeView(document, config.viewProps, config.content),
      viewProps: config.viewProps,
    });
  }
}

export const DomBladePluginDefinition: BladePlugin<DomBladeParams> = createPlugin({
  id: "zartigl-dom",
  type: "blade",
  accept(params) {
    if (params.view !== "zartigl-dom" || !(params.content instanceof HTMLElement)) return null;
    return {
      params: {
        view: "zartigl-dom",
        content: params.content,
      },
    };
  },
  controller(args) {
    return new DomBladeController(args.document, {
      blade: args.blade,
      viewProps: args.viewProps,
      content: args.params.content,
    });
  },
  api({ controller }: { controller: BladeController; pool: PluginPool }) {
    if (!(controller instanceof DomBladeController)) return null;
    return new BladeApi(controller);
  },
});

export const DomBladePlugin: TpPluginBundle = {
  id: "zartigl-dom",
  plugin: DomBladePluginDefinition,
};

export function addDomBlade(folder: FolderApi, content: HTMLElement): BladeApi {
  return folder.addBlade({
    view: "zartigl-dom",
    content,
  });
}
