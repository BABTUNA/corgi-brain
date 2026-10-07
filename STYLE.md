# Corgi Brain style, for agents

Read this before touching anything a person sees: the web app, the extension popup and Guide me overlay, the README, slides, screenshots. The app's live tokens are in `bridge/public/bb.css`; the brand tokens are in `assets/brand.css`.

## Files to use, never redraw

| Need | Use |
|---|---|
| Logo on white, paper or ink | `assets/logo/corgibrain-mark.svg` (the corgi head) |
| Logo on the fawn field | `assets/logo/corgibrain-mark-on-fawn.svg` |
| Logo in one colour | `assets/logo/corgibrain-mark-mono.svg` (set `color`) |
| Wordmark ("Corgi Brain") | `assets/logo/corgibrain-wordmark.svg` (light), `-dark.svg` (ink), `-on-fawn.svg` |
| App icon, favicon | `assets/logo/corgibrain-icon.svg` (cream tile), `-icon-dark.svg`, `-icon-fawn.svg`; PNGs in `assets/icons/icon-{16..512}.png` |
| README or social banner | `assets/banner/readme-banner.png` (paper) or `readme-banner-dark.png` |
| Slides, forms, anything that can't take SVG | `assets/png/`: transparent logos, 1920×1080 covers (`cover-white`, `-dark`, `-fawn`), 1080×1080 squares |

All SVGs are outlined shapes, no font needed. Don't recreate the corgi, don't retype "Corgi Brain" as a logo, don't recolour the head outside the files above. Copies live in `bridge/assets/` (the web app) and `extension/icons/`; update them when `assets/` changes.

## Colour

```
Fawn        #E8873A   the corgi, "Brain", fills, dots, the Guide me glow
Fawn deep   #CF7128   pressed fills
Fawn ink    #A34F1A   buttons and orange text (white on it is 5.7:1)
Fawn soft   #FCE6D2   tints
Cream       #FFF6EA   the blaze, icon tiles
Blush       #F6C9A0   inner ears
Ink         #1E1B18   text, dark surfaces
Paper       #FAF7F2   page background
White       #FFFFFF   cards
Stone       #6E665E   muted text
Line        #EAE3D9   borders
Red         #D93025   errors only
```

Fawn is a fill colour; it is too light for text on white, so text and white-on-orange buttons use fawn ink. One orange job per screen: an accent, a primary button, or the highlighted element. No greens, no other hues. In code use the variables (`--orange`, `--orange-ink`, … in `bb.css`; the names are historical), not hex values.

## Type

```
Wordmark and headlines   Archivo 800, letter-spacing about -0.03em
Body and UI              Onest 400 / 500 / 700
Kickers, chips, numbers  JetBrains Mono 500 / 600, 11px, uppercase, 2px tracking, fawn ink
```

## Layout and components

- Paper page, white cards with a 1 px line border and 12 px radius. No drop shadows except on floating tooltips.
- Buttons 44 px tall, 10 px radius. Primary is fawn ink with white text; secondary is white with a line border. One primary per view.
- Guide me overlay: blur and dim the page, glow the target with a fawn ring, ink tooltip with a fawn left border. One glowing element at a time.
- The nav shows the corgi mark then "Corgi **Brain**" in Archivo, "Brain" in fawn.

## Voice

Short, plain sentences, second person. Say who taught a workflow. Never claim an agent succeeded when the judge disagreed. The corgi is the logo, not a character: no dog puns in UI copy.

## Regenerating

```bash
cd assets/render
python3 extract.py && node compose.mjs .. && bash render.sh && bash raster.sh
```

`extract.py` outlines the words from Archivo, `compose.mjs` draws the corgi and writes every SVG and render page, `render.sh` makes the icons and banners, `raster.sh` the PNG set.
