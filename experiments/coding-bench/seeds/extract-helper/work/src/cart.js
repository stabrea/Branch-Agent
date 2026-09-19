function formatPrice(cents) {
  return "$" + (cents / 100).toFixed(2);
}

export function cartLine(item) {
  return `${item.name}: ${formatPrice(item.cents)}`;
}
