/*
 * The updating screen: a full-window panel with the current step, a progress bar and a small
 * pixel walker who keeps going across a scrolling ground while the new version downloads,
 * is checked, unpacked and applied. Plain language only; the app restarts by itself at the end.
 */
(() => {
  const palette = { skin: "#e8c9a0", hair: "#3a2a1a", shirt: "#b8743a", trousers: "#2f4a3a", boot: "#1d1d1d", ground: "#3b5a44", groundDark: "#2c4433", grass: "#6f9a5a", sky: null };
  // 12x16 walker, four frames; letters map to palette entries, "." is transparent.
  const frames = [
    ["....hhhh....", "...hhhhhh...", "...hsssh....", "...hssss....", "....ssss....", "...tttttt...", "..ttttttt...", "..t.tttt.t..", "....tttt....", "....pppp....", "....pppp....", "....p..p....", "....p..p....", "...bb..bb...", "...bb..bb...", "............"],
    ["....hhhh....", "...hhhhhh...", "...hsssh....", "...hssss....", "....ssss....", "...tttttt...", "..ttttttt...", "..t.tttt.t..", "....tttt....", "....pppp....", "...pp..pp...", "...p....p...", "..pp....pp..", "..bb....bb..", ".bb......bb.", "............"],
    ["....hhhh....", "...hhhhhh...", "...hsssh....", "...hssss....", "....ssss....", "...tttttt...", "..ttttttt...", "..t.tttt.t..", "....tttt....", "....pppp....", "....pppp....", "....p..p....", "....p..p....", "...bb..bb...", "...bb..bb...", "............"],
    ["....hhhh....", "...hhhhhh...", "...hsssh....", "...hssss....", "....ssss....", "...tttttt...", "..ttttttt...", "..t.tttt.t..", "....tttt....", "....pppp....", "...pp..pp...", "..pp....pp..", "..p......p..", ".bb......bb.", "bb........bb", "............"],
  ];
  const colorOf = { h: palette.hair, s: palette.skin, t: palette.shirt, p: palette.trousers, b: palette.boot };
  const scale = 5, width = 420, height = 140, groundY = 110;
  let canvas, context, frame = 0, offset = 0, timer = null, last = 0;

  function drawGround() {
    for (let x = -((offset | 0) % 20); x < width; x += 20) {
      context.fillStyle = (Math.floor((x + offset) / 20) % 2 === 0) ? palette.ground : palette.groundDark;
      context.fillRect(x, groundY, 20, height - groundY);
      if ((Math.floor((x + offset) / 20) % 3) === 0) { context.fillStyle = palette.grass; context.fillRect(x + 6, groundY - 5, 5, 5); context.fillRect(x + 12, groundY - 3, 3, 3); }
    }
  }
  function drawWalker() {
    const rows = frames[frame];
    const left = Math.round(width / 2 - (rows[0].length * scale) / 2), top = groundY - rows.length * scale + scale;
    rows.forEach((row, y) => { [...row].forEach((cell, x) => { if (cell !== ".") { context.fillStyle = colorOf[cell]; context.fillRect(left + x * scale, top + y * scale, scale, scale); } }); });
  }
  function tick(now) {
    if (!canvas) return;
    if (now - last > 120) { frame = (frame + 1) % frames.length; last = now; }
    offset = (offset + 1.6) % 60;
    context.clearRect(0, 0, width, height);
    drawGround(); drawWalker();
    timer = requestAnimationFrame(tick);
  }

  const $ = (id) => document.getElementById(id);
  const words = {
    checking: "Checking for a newer version", downloading: "Downloading the new version", verifying: "Making sure the download is exactly what was published",
    unpacking: "Unpacking", ready: "Restarting to finish", applying: "Restarting to finish", error: "Something went wrong",
  };
  const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

  window.branchUpdateScreen = {
    show(status) {
      const screen = $("update-screen");
      if (!screen) return;
      if (screen.hidden) {
        screen.hidden = false;
        canvas = $("update-walker"); context = canvas.getContext("2d");
        canvas.width = width; canvas.height = height;
        cancelAnimationFrame(timer); timer = requestAnimationFrame(tick);
      }
      this.update(status);
    },
    update(status) {
      if (!status || $("update-screen").hidden) return;
      const version = status.release?.latestVersion;
      $("update-title").textContent = version ? `Updating to ${version}` : "Updating";
      $("update-stage").textContent = words[status.phase] || status.message || "Working";
      const bar = $("update-bar");
      bar.style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
      bar.parentElement.classList.toggle("indeterminate", status.progress === null);
      const detail = status.bytes && status.bytes.total ? `${mb(status.bytes.received)} of ${mb(status.bytes.total)}` : status.phase === "ready" || status.phase === "applying" ? "The app closes for a moment and opens again by itself." : "";
      $("update-detail").textContent = detail;
    },
    hide() {
      const screen = $("update-screen");
      if (!screen || screen.hidden) return;
      screen.hidden = true; cancelAnimationFrame(timer); canvas = null;
    },
  };
})();
