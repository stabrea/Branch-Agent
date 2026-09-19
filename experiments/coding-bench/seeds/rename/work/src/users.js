const users = new Map([[1, { id: 1, name: "Ada" }]]);

export function getUsr(id) {
  return users.get(id) ?? null;
}
