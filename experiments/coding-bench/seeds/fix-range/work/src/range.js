/** Numbers from `start` to `end`, both included, stepping by `step`. */
export function range(start, end, step = 1) {
  const out = [];
  for (let n = start; n < end; n += step) out.push(n);
  return out;
}
