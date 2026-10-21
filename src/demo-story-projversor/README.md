# projversor story

A shareable motion-graphics story on one projversor sphere: each scene morphs
the projection, camera and data of the previous one. A pager
(`‹ 1 2 … n › ⏯`) jumps to any step; play/pause drives both the scene timer
and the data playback, and the story loops.

```bash
npm run dev:story-projversor     # vite dev server: index.html and sheet.html
npm run build:story-projversor   # dist-story-projversor/, served under /zartigl/projversor/story/
```

The projversor Docker image serves it at `/story/`.

The app uses zartigl only through its package entries: `@fxi/zartigl/projversor`
(here `../projversor`) for the renderer, `@fxi/zartigl/story` (`../story`) for the
story runtime, the `<story-pager>` element and the scene timer.

## Layout system

A scene's `layout` is an intent, resolved per viewport by `layout.ts`:

| Layout | Text | Map |
|---|---|---|
| `n-s`, `s-n` | top, bottom | below, above |
| `w-e`, `e-w` | left, right column | beside |
| `nw-se`, `ne-sw`, `sw-ne`, `se-nw` | a corner | the larger free side |
| `title`, `end` | centered top, bottom | below, above |
| `minimal` | small, top left | the larger free side |
| `none` | none | the whole screen |

- **Veil, not panels.** One full-screen gradient runs from the solid text
  side to the clear map side. Its angle and stops are css custom properties
  registered with `@property`, so layouts crossfade.
- **The map moves out of the way.** The renderer centers and fits the sphere
  in a free zone (`Projversor.setInset`), computed from the measured text box
  (`mapInset`) and eased with the scene morph. Map `zoom` is relative to that
  zone, so values above 1 bleed under the veil.
- **Per aspect ratio.** In portrait, side and corner layouts fold to top or
  bottom; on short landscape screens, top and bottom layouts go beside the map.
- **Fit.** If the text overflows its zone (or a word its width), the headline
  shrinks step by step to 60%, then the text compacts.
- **Rail.** The free edge carries, top to bottom, a north badge, the view
  center and projection, and the color scale (min, palette, max, unit). North
  is the true screen direction at the map center (`Projversor.northAngle`),
  so it holds on tilted projections; near a pole it fades out. The scale
  shows what the colors mean: a raster or tint over its domain, else the
  particle speed (`monthLegend`). A thin shade keeps the rail readable.
- **Wrap.** With `wrap: true` on a view, side layouts shape the paragraph to
  the globe limb (`shape-outside` from `Projversor.outline()`).

`layout.test.ts` checks every layout on phone, tablet, desktop and landscape
phone: the text zone stays on screen, never overlaps the map's free zone, and
leaves the map at least 40% of the screen.

## Documents

- `story.json`: scenes, themes and localized copy (English and French), in the
  story runtime schema (`../story/schemas/story.schema.json`). Keep the hook
  (`heading`) to 5 words and the `text` to 35 (`story.test.ts`). `durationMs`
  sets how long a scene plays before the next one.
- `views.json`: one `projversor` view per scene: a projversor layer (catalog
  alias or tinted pairing), a projection `preset` with optional `rotate` and
  `zoom`, and optionally `tint` (scalar entry id, `""` for speed colors),
  `style` (`palette`; `particles` density, speed, fade, grade: `"vibrant"`
  or a tuned grade; `raster`
  opacity, vibrance; see "Layer style" in the root README), `playback`
  (`speed`, one of `SPEEDS`; `time`, ISO date, else the latest month),
  `transitionMs` and `wrap`. Each view starts from the layer's own style.
  The flat `palette`, `vibrant`, `speed` and `time` of the first format still
  load, with a deprecation warning. `parseProjversorView`
  (`@fxi/zartigl/projversor`) validates it.

## Tools

- `?debug` draws the text zone (dashed blue), the measured text (yellow, red
  and a console warning when it overflows), the map's free zone (green) and
  the sphere outline (magenta).
- `sheet.html` is a contact sheet: every scene at one viewport (phone, tablet,
  desktop, landscape phone), with debug and French toggles. One viewport at a
  time keeps WebGL contexts under the browser limit; frames load lazily, and
  heavy decoding can make some frames slow to fill.
- `?still` disables motion and the scene timer; `?lang=fr` forces a locale.

## Behavior

- One `Projversor` lives for the whole story; a scene reopens the layer only
  when its layer or tint changes, and the next scene's index and manifest are
  warmed in the background.
- A scene's timer starts once its data is on screen.
- The timeline shows the archive months; dragging scrubs within the displayed
  month and opens another month on release.
- The url hash keeps the scene and the play state (`#s=arctic-ice&paused=1`).
- Keys: arrows and Page Up/Down step, Home/End jump, Space plays or pauses.
  Dragging and zooming the sphere stay available.
- Reduced motion starts the story paused and skips the reveals.
