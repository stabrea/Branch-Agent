import { calcFee } from "./fees.js";

export function invoiceTotal(amount) {
  return amount + calcFee(amount);
}
