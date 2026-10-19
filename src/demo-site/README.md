# home page prototype

A scroll story as a site home page: header, the featured slot, footer and
fixed top/bottom buttons, all described by `public/content/home.json`. It
proves the architecture before moving to its own repository.

```bash
npm run dev:site     # http://localhost:5173/
npm run build:site   # dist-site/: index.html, assets/, content/
```

Like the other projversor apps, it reaches zartigl only through the package
entries (`../projversor`, `../story`); in its own repository these become
`@fxi/zartigl/projversor` and `@fxi/zartigl/story`.

## Content

Content is fetched at runtime, not bundled: the story of the month changes
without a rebuild.

```
content/
  home.json                  # header, featured, fallback, footer, labels (top, bottom, loading, scroll)
  stories/<id>/story.json    # scenes and copy (story runtime schema)
  stories/<id>/views.json    # one projversor view per scene
```

- `featured` is a slot: `{ "type": "story", "id": "2026-11-planet" }`, a
  `video` (`src`, `poster`, `title`) or an `article` (`title`, `paragraphs`).
- `fallback` (video or article) replaces a story when WebGL2 is missing.
- Links may contain `{locale}`; links to another origin than the brand link
  open in a new tab.
- Scene `layout` is `intro`, `left` or `right`: where the text sits beside the
  sphere on wide screens. On narrow screens, text runs under the sphere.
- The first scene is a prelude: no kicker and no number; numbering starts
  at the second scene.

`home.test.ts` validates `home.json`, every locale, and the story of the
month against the projversor layers.

## Embedding

`mountSite(root, { contentUrl })` renders everything inside `root`, with
styles scoped to `.zs-site` and no global. A CMS page needs one element and
the built script and stylesheet:

```html
<div id="site" data-content="/themes/grid/content/"></div>
```

## Behavior

- One sticky projversor sphere sits behind the text. The step crossing 60%
  of the viewport height drives the view (`StoryScroller`); the next scene's
  data is warmed in the background.
- The sphere pauses when the story is off screen or the tab hidden. Reduced
  motion shows each view at once, paused.
- `?lang=fr` forces a locale, `?fallback` shows the fallback slot.
