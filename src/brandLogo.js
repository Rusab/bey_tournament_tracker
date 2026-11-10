/*
 * The app's wordmark as a picture, for podium posters: the home screen's
 * own header, drawn large - the slanted magenta bar and "Beyblade X" in
 * cyan, over "Tournaments" in the magenta-white-cyan gradient.
 *
 * Drawn on a canvas once the app's fonts are loaded (an SVG drawn into a
 * canvas cannot use web fonts), and kept for the page's life.
 */

const MAGENTA = "#FF2D8A", CYAN = "#29D3FF";
const DISPLAY = '"Saira Condensed", "Barlow", sans-serif';

let made = null;

/** A PNG data address of the wordmark, about 3.6 times as wide as it is tall. */
export function brandLogoUrl() {
  if (!made) {
    made = (async () => {
      try {
        await Promise.all([document.fonts.load(`700 58px ${DISPLAY}`), document.fonts.load(`800 168px ${DISPLAY}`)]);
      } catch (e) { /* drawn in a fallback font */ }

      const small = `700 58px ${DISPLAY}`, big = `800 168px ${DISPLAY}`;
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = big;
      const bigW = probe.measureText("Tournaments").width;
      probe.font = small;
      const smallW = probe.measureText("Beyblade X").width;

      const pad = 12, barW = 104, gap = 26;
      const w = Math.ceil(Math.max(bigW, barW + gap + smallW) + pad * 2);
      const h = 240;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");

      // The slanted bar, then "Beyblade X" beside it.
      g.save();
      g.translate(pad + 20, 46);
      g.transform(1, 0, -0.58, 1, 0, 0);   // skewX(-30deg)
      g.fillStyle = MAGENTA;
      g.fillRect(0, -7, barW, 14);
      g.restore();
      g.font = small;
      g.fillStyle = CYAN;
      g.textBaseline = "alphabetic";
      g.fillText("Beyblade X", pad + barW + gap, 66);

      // "Tournaments", in the header's gradient.
      g.font = big;
      const grad = g.createLinearGradient(pad, 80, pad + bigW, 230);
      grad.addColorStop(0, MAGENTA);
      grad.addColorStop(0.55, "#FFFFFF");
      grad.addColorStop(1, CYAN);
      g.fillStyle = grad;
      g.fillText("Tournaments", pad, 222);

      return c.toDataURL("image/png");
    })();
  }
  return made;
}
