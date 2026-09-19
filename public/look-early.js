/* phase2/everywhere: names the theme this window was given before anything is drawn.
   public/tokens.css paints Slate, the default, on a page that names no theme. Somebody who chose
   a theme (public/layout.js writes it down as "branch-palette") gets it named here, from the head
   of the page, so a chosen Forest paints in Forest from the first frame as it always did, and never
   blinks through Slate. public/layout.js then wears the chosen theme's full colours as before.
   A classic script, loaded without defer, so it runs before the first paint. */
(function () {
  "use strict";
  var chosen = "";
  try { chosen = localStorage.getItem("branch-palette") || ""; } catch (error) { chosen = ""; }
  if (/^[a-z][a-z0-9-]{0,39}$/.test(chosen)) document.documentElement.setAttribute("data-palette", chosen);
})();
