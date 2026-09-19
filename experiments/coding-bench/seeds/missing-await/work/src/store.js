const data = { a: 1, b: 2, c: 3 };
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

export async function load(key) {
  await wait();
  return data[key];
}

/** Loads every key and returns their sum. */
export async function total(keys) {
  let sum = 0;
  for (const key of keys) {
    const value = load(key);
    sum += value;
  }
  return sum;
}
