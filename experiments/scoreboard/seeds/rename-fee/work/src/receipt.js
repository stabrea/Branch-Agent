import { calcFee } from "./fees.js";

export function receiptLines(amount) {
  return [`amount ${amount}`, `fee ${calcFee(amount)}`];
}
