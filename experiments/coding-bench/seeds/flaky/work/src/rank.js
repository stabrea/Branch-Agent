/** Orders players by score, highest first. Players with equal scores keep their original order. */
export function rank(players) {
  return [...players].sort((a, b) => (b.score - a.score) || (Math.random() - 0.5));
}
