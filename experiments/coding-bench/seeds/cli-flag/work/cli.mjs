#!/usr/bin/env node
// Prints a greeting. Usage: node cli.mjs [--name NAME]
const args = process.argv.slice(2);
let name = "world";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name") name = args[++i];
}
console.log(`Hello, ${name}!`);
