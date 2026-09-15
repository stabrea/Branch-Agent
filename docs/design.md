# Branch Agent interface

The desktop and browser share one interface. The visual system uses forest-green surfaces, copper actions, warm paper accents, condensed display headings, and monospaced navigation labels. KeepOak's public site was inspected as the owner's requested visual reference; its application and settings were not modified.

## Tokens

| Role | Value |
| --- | --- |
| Ground | `#03140B` |
| Text | `#EDF1EA` |
| Copper action | `#E07033` |
| Copper hover | `#F08A4E` |
| Warm paper | `#F4F1E8` |
| Display | Archivo variable, condensed to 62% |
| Body | Geist variable |
| Navigation and labels | Geist Mono variable |

Three rounded panels hold navigation, current work and assistant context. The context panel yields space on smaller windows. On phones the navigation becomes a horizontal strip. Forest and Daylight appearances retain the same copper actions and layout.

Fonts are bundled from pinned Fontsource packages with their OFL notices. No remote font request is required. Typography fallback remains available while local fonts load.

The owner also requested KeepOak's logo and revolving acorn. Logo PNGs are bundled locally from the public site's observed assets. `public/acorn.js` adapts its analytic ellipsoid geometry, ordered dithering, colors and rotation to this interface. It supports dragging, arrow keys, pause/resume and reduced-motion preferences; animation suspends when hidden. No KeepOak scripts, analytics or network calls run inside the application. The native window, tray and Windows executable use the logo.

Electron supplies the native window and tray. The renderer has no Node integration, uses context isolation and sandboxing, and loads only the local application. Credentials are added to authorized local requests in the main process, not embedded in URLs or page source.
