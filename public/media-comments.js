/**
 * FQ-collaboration: comments pinned to a moment in a media file.
 *
 * There is no video player screen in the app yet (no page renders a `<video>` element), so this
 * file is the minimal hook a future one would call: it fetches the comments for a file, draws them
 * as a list with the timestamp shown, and wires each one to seek the given `<video>` to that
 * position when clicked. Whoever builds the player wires this in; nothing calls it today.
 */

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** The comments on one file, earliest moment first. */
export async function listMediaComments(fileId) {
  const { comments } = await api(`/api/media-comments?fileId=${encodeURIComponent(fileId)}`);
  return comments;
}

/** Adds a comment at a moment in a file. `atSeconds` must be a real, non-negative number. */
export function addMediaComment(fileId, atSeconds, text) {
  return api("/api/media-comments", { fileId, atSeconds, text });
}

/** `M:SS` (or `H:MM:SS` past an hour) for a comment's timestamp. */
export function formatTimestamp(atSeconds) {
  const whole = Math.max(0, Math.round(atSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Moves `video` to a comment's position. Ignores anything that is not a finite, non-negative time. */
export function seekToComment(video, atSeconds) {
  if (!video || !Number.isFinite(atSeconds) || atSeconds < 0) return;
  video.currentTime = atSeconds;
}

/**
 * Draws one file's comments into `container` as a list; clicking a comment seeks `video` (when one
 * is given) to that comment's moment. Returns the list element so a caller can update it later.
 */
export function renderMediaComments(container, comments, video) {
  container.replaceChildren();
  const list = document.createElement("ul");
  list.className = "media-comments-list";
  for (const comment of comments) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-comments-time";
    button.textContent = formatTimestamp(comment.atSeconds);
    button.dataset.atSeconds = String(comment.atSeconds);
    button.addEventListener("click", () => seekToComment(video, comment.atSeconds));
    item.append(button, document.createTextNode(" " + comment.text));
    list.append(item);
  }
  container.append(list);
  return list;
}
