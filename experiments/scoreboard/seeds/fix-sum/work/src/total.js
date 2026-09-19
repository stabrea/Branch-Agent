// Adds up the amounts on a list of line items.
export function total(items) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) {
    sum += items[i].amount;
  }
  return sum;
}
