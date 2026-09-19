// Turns a title into a url-safe slug.
export function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
