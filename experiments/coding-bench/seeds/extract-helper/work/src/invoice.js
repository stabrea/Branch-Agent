function formatPrice(cents) {
  return "$" + (cents / 100).toFixed(2);
}

export function invoiceTotal(items) {
  const cents = items.reduce((sum, item) => sum + item.cents, 0);
  return `Total ${formatPrice(cents)}`;
}
