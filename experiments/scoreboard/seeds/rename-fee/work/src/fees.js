export function calcFee(amount) {
  return Math.round(amount * 0.025 * 100) / 100;
}
