/**
 * Reading the square code on the computer's screen with the phone's camera. The page is served
 * from the app itself (a secure address), so the ordinary web camera works on both phones, and one
 * small decoder (jsQR, Apache-2.0) reads the frames. Nothing leaves the phone while scanning.
 */

/** Reads one frame of pixels ({ data, width, height }, RGBA). Answers the text, or null. */
export function readFrame(decode, frame) {
  if (!frame?.data || !frame.width || !frame.height) return null;
  const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" });
  return found?.data ? String(found.data) : null;
}

/**
 * Opens the back camera into `video`, looks at a frame every quarter second, and resolves with the
 * first code read. `stop()` closes the camera whether or not anything was read.
 */
export function startScan(video, decode) {
  let stream = null, timer = 0, stopped = false;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    video.srcObject = null;
  };
  const found = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (stopped) { stop(); return null; }
    video.srcObject = stream;
    await video.play();
    return new Promise((resolve) => {
      timer = setInterval(() => {
        if (stopped) { resolve(null); return; }
        if (!video.videoWidth) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0);
        const text = readFrame(decode, context.getImageData(0, 0, canvas.width, canvas.height));
        if (text) { stop(); resolve(text); }
      }, 250);
    });
  })();
  return { found, stop };
}
