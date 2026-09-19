/**
 * Redesign phase 2 (accounts, critiques #21, #30, #60): the service marks. Every mark drawn by
 * public/brand-marks.js is the file of the same name in public/assets/brands, every file is listed
 * with its source and licence in THIRD_PARTY_NOTICES.md, and services whose owners ask for permission
 * first get a neutral tile, never a letter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MARKS, markFor, neutralFor } from "../public/brand-marks.js";

const PUBLIC = join(import.meta.dirname, "..", "public");

test("M1 every mark is its file, drawn unchanged, and every file is a mark", async () => {
  const files = (await readdir(join(PUBLIC, "assets", "brands"))).filter((name) => name.endsWith(".svg"));
  assert.deepEqual(files.map((name) => name.slice(0, -4)).sort(), Object.keys(MARKS).sort());
  for (const name of files) {
    const text = await readFile(join(PUBLIC, "assets", "brands", name), "utf8");
    const [title, hex, d] = MARKS[name.slice(0, -4)];
    assert.equal(text.match(/<path d="([^"]+)"/)[1], d, `${name}: the drawing changed on its way into the app`);
    assert.equal(text.match(/<title>([^<]+)<\/title>/)[1].replace("&amp;", "&"), title);
    assert.match(hex, /^[0-9A-F]{6}$/);
    assert.ok(text.length < 8000, `${name} is a small file`);
  }
});

test("M2 every mark's source and licence is written down", async () => {
  const notices = await readFile(join(import.meta.dirname, "..", "THIRD_PARTY_NOTICES.md"), "utf8");
  const section = notices.slice(notices.indexOf("### Service marks"));
  assert.ok(section.length > 100, "the Service marks section is missing");
  for (const slug of Object.keys(MARKS)) assert.ok(section.includes(`\`${slug}.svg\``), `${slug}.svg is not in THIRD_PARTY_NOTICES.md`);
  for (const neutral of ["Google", "Meta", "Slack", "Microsoft", "Apple", "Amazon"]) assert.ok(section.includes(neutral), `${neutral} is not listed as neutral`);
});

test("M3 a row's own words find its mark, and services that ask for permission get a neutral tile", () => {
  const cases = [
    [["openai"], "openai"], [["chatgpt", "ChatGPT"], "openai"], [["OpenAI (work)"], "openai"],
    [["cli-claude-code", "Claude Code"], "claude"], [["Anthropic"], "anthropic"], [["Anthropic · claude-sonnet-4-5"], "anthropic"], [["Claude on Google Vertex AI"], "claude"],
    [["OPENAI_API_KEY"], "openai"], [["TELEGRAM_BOT_TOKEN"], "telegram"], [["DISCORD_BOT_TOKEN"], "discord"],
    [["GH_TOKEN"], "github"], [["cli-copilot", "GitHub Copilot"], "githubcopilot"], [["ollama"], "ollama"],
    [["rocketchat", "Rocket.Chat"], "rocketdotchat"], [["line", "LINE"], "line"], [["Bitwarden"], "bitwarden"],
  ];
  for (const [hints, slug] of cases) assert.equal(markFor(...hints), slug, hints.join(" / "));
  for (const hints of [["Google Gemini"], ["whatsapp"], ["SLACK_BOT_TOKEN"], ["msteams", "Microsoft Teams"], ["pipeline"], ["Apple Keychain"]])
    assert.equal(markFor(...hints), null, `${hints.join(" / ")} has no mark`);
  assert.equal(neutralFor("service", "SLACK_BOT_TOKEN"), "chat");
  assert.equal(neutralFor("service", "Windows Credential Manager"), "password");
  assert.equal(neutralFor("service", "SUPPLIER_API_KEY"), "key");
  assert.equal(neutralFor("service", "Google Gemini"), "service");
  assert.equal(neutralFor("chat", "twilio-sms"), "phone");
});

test("M4 the marks' colours live in the script, never in a stylesheet", async () => {
  const css = await readFile(join(PUBLIC, "brand-marks.css"), "utf8");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  const source = await readFile(join(PUBLIC, "brand-marks.js"), "utf8");
  assert.doesNotMatch(source, /fetch\(|https?:\/\/(?!www\.w3\.org)/, "nothing is fetched from the network");
});
