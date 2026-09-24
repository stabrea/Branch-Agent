/**
 * packages.leads (docs/features.json): "Enrich and score a fixture prospect set and exclude duplicates
 * in the exported results." (src/asks/leads.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { domainOf, enrich, seniorityOf, leadsCsv } from "../dist/asks/leads.js";

const fixtureProspects = [
  { name: "Ada Obi", email: "ada@acme-logistics.com", company: "Acme Logistics, Inc.", title: "VP of Operations", location: "Atlanta, GA" },
  { name: "Ben Ray", email: "ben@gmail.com", company: "Solo Designs LLC", title: "Designer", website: "https://www.solodesigns.io/about", location: "Denver" },
  { name: "Cara Lee", email: "cara@freight.co", company: "Freight Co", title: "Operations Manager", location: "Atlanta" },
  // The same person as Ada, written differently: a duplicate by email.
  { name: "Ada Obi", email: "ADA@acme-logistics.com", company: "Acme Logistics", title: "VP Ops" },
  // The same person as Cara at the same domain, no email: a duplicate by name and domain.
  { name: "Cara  Lee", website: "freight.co", company: "Freight Co" },
  { name: "=HYPERLINK(\"x\")", email: "eve@evil.test", company: "Evil", title: "Intern" },
];
const criteria = { company: ["logistics", "freight"], titles: ["operations"], locations: ["Atlanta"] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-leads-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = () => { const run = app.store.createRun(app.runtime.owner, "leads"); return app.runtime.context({ runId: run.id }); };
  return { app, run: (name, args) => app.registry.execute(name, args, context()) };
}

test("each prospect is filled out from its own fields, and every point names its word", () => {
  assert.equal(domainOf("ada@acme-logistics.com", ""), "acme-logistics.com");
  assert.equal(domainOf("ben@gmail.com", "https://www.solodesigns.io/about"), "solodesigns.io", "a free mail service is not a company");
  assert.equal(domainOf("", ""), "", "what cannot be worked out stays empty");
  assert.equal(seniorityOf("VP of Operations"), "leader");
  assert.equal(seniorityOf("Operations Manager"), "manager");
  assert.equal(seniorityOf("Designer"), "individual");
  const ada = enrich(fixtureProspects[0], criteria);
  assert.equal(ada.company, "Acme Logistics", "the company's legal ending is tidied away");
  assert.equal(ada.score, 2 + 3 + 2 + 2 + 1);
  assert.deepEqual(ada.matched, ["company: logistics", "title: operations", "location: Atlanta", "seniority: leader", "has an email address"]);
});

test("off by default; switched on, the list is scored, deduplicated and exported", async (t) => {
  const { app, run } = await fixture(t);
  assert.equal(app.asks.modes().leads, "off");
  assert.ok(!app.registry.names().includes("leads.add"));
  app.asks.setMode("leads", { mode: "when-needed" });
  const first = await run("leads.add", { prospects: fixtureProspects, criteria });
  assert.equal(first.added.length, 4, "six in, two duplicates out");
  assert.deepEqual(first.dropped.map((pair) => pair.dropped).sort(), ["ADA@acme-logistics.com", "Cara  Lee (freight.co)"]);
  // A fuller copy of someone already on the list does not add a second row.
  const again = await run("leads.add", { prospects: [{ name: "Ada Obi", email: "ada@acme-logistics.com", company: "Acme Logistics", title: "VP", location: "Atlanta", notes: "met at the expo" }], criteria });
  assert.deepEqual(again.added, []);
  assert.equal(again.dropped.length, 1);
  const { csv, count } = await run("leads.export", {});
  assert.equal(count, 4);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "name,email,company,title,domain,seniority,location,score,matched");
  assert.match(lines[1], /^Ada Obi,ada@acme-logistics\.com,Acme Logistics,/, "best score first");
  assert.equal(lines.filter((line) => line.includes("acme-logistics.com")).length, 1, "no duplicate in the export");
  assert.ok(lines.some((line) => line.startsWith(`"'=HYPERLINK(""x"")"`)), "a formula-looking name is written as text");
  assert.equal((await run("leads.clear", {})).removed, 4);
  assert.equal(app.asks.leads.list().length, 0);
});

test("the CSV writer quotes what needs quoting and disarms formulas", () => {
  const csv = leadsCsv([{ id: "1", name: "Lee, Cara", email: "", company: "@Risky", title: "", website: "", location: "", notes: "",
    domain: "", seniority: "", score: 0, matched: [] }]);
  assert.equal(csv.split("\n")[1], `"Lee, Cara",,'@Risky,,,,,0,`);
});

test("the card's words are in English and real French", async () => {
  const en = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "fr.json"), "utf8"));
  for (const key of ["asks.part.leads", "asks.leads.purpose", "asks.leads.count"]) {
    assert.ok(en[key], `${key} has no English`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} needs real French`);
  }
});
