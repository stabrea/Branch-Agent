export function mean(values) {
  if (!values.length) throw new Error("mean of nothing");
  return values.reduce((a, b) => a + b, 0) / values.length;
}
