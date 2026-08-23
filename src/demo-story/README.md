# Story runtime prototype

The demo is driven by two versioned documents:

- `story.json` owns narrative order, localized copy, themes, layouts, blocks, and playback policy.
- `views.json` owns reusable visual/data states. A view is an `{ id, type, config }` envelope interpreted by a registered adapter.

The runtime in `runtime/` deliberately has no Zartigl dependency. Applications add view types with `StoryRegistry.registerViewType()` and specialized blocks with `registerWidgetType()`. The current demo registers `zartigl-map` plus the Arctic, ENSO, and Mayotte charts.

## Authoring rules

- Use the named responsive layouts and block slots; do not add scene-specific CSS selectors.
- Keep geographic camera state and its transition in a view. `anchor` controls its screen-space placement independently.
- Use localized objects for editorial text and ensure the story's `defaultLocale` is present.
- Copy blocks can opt into `backdrop: "dark-gradient"` when the underlying view does not provide enough text contrast. Omit it (or use `none`) otherwise.
- Choose playback explicitly: `none`, `autoplay`, or a discrete `sequence`.
- Navigation is scene-based: buttons, keyboard, and wheel all activate one exact scene. Continuous scroll is intentionally outside the v1 runtime.
- Validate structural changes against the JSON Schemas in `schemas/`. Adapter-specific configuration is covered by its own schema, such as `zartigl-map.schema.json`.

The MapX export in `story_map_mapx_test.json` remains a design reference; it is not loaded by the runtime.

The Mayotte overlay is generated from `data/chido-track.json`, a small provenance-rich snapshot of the canonical NOAA IBTrACS `LAT`/`LON` positions. Its timestamps intentionally match the scene's forward playback sequence so the active marker, wind frame, and chart cursor stay synchronized.
