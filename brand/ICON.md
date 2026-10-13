# Split Bill icon

The app icon is a receipt split in two down the middle: two cream halves on a
black tile, the right half sitting a little lower, each with two rounded
"line item" bars and a torn zigzag bottom edge. It follows the Homeroom brand
framework's black + cream pairing (one bold flat mark, no text, readable at
32 pt).

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | Hand-written source for the app icon, 1024 × 1024 viewBox. |
| `icon.png` | 1024 × 1024 render of `icon.svg`; this is what `dapp.json`'s `icon.image` points at. |
| `icon-featured-light.svg` / `icon-featured-light.png` | Featured artwork for the Homeroom directory, 1600 × 900: black receipt on cream `#FFFEEA`. |
| `icon-featured-dark.svg` / `icon-featured-dark.png` | Same art on black `#000000`, receipt in cream: the dark directory version. |

## Colours

Only two, from the brand palette:

- Black `#000000` — the tile, and the line-item bars.
- Cream `#FFFEEA` — the receipt halves, and (in the light featured art) the
  background with the colours swapped.

The featured art is the same paths as `icon.svg`, scaled so the receipt is
640 px tall and centred on 1600 × 900.

## Geometry (1024 grid)

- Full-bleed black square; the receipt is 480 × 640 centred, leaving ~25%
  margin so the platform's rounded tile crop never touches it.
- Two cream halves, each 212 wide, 56 px gap between them; the right half is
  40 px lower. Flat tops, zigzag torn bottoms (4 teeth, 36 deep).
- Two rounded black bars per half, 44 px thick: one long (124), one short (84).

## Re-rendering the PNGs

The PNGs are rendered from the SVG sources with a small throwaway rasterizer
(not committed; any SVG rasterizer works, e.g. `rsvg-convert -w 1024 -h 1024
brand/icon.svg -o brand/icon.png` and `-w 1600 -h 900` for the featured art).

Constraints the app icon must keep: real PNG, opaque (no alpha), 1024 × 1024,
≤ 256 KB, square corners — the platform rounds the tile itself.
