/**
 * Prospect leads: enrichment, scoring and de-duplication, both as plain functions and as the
 * `leads.export` tool the owner can actually call. Nothing here reaches the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { enrichProspect, scoreProspect, dedupeKeyOf, exportLeads } from "../dist/leads.js";

async function fixture(t, options = {}) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-leads-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

/* ------------------------------------------------------------------ enrichment and scoring */

test("enrichment reads a work email, a personal one, and a title's seniority", () => {
  const exec = enrichProspect({ name: "Amara Diallo", email: "amara@northwind.io", company: "Northwind", title: "Chief Revenue Officer" });
  assert.equal(exec.domain, "northwind.io");
  assert.equal(exec.workEmail, true);
  assert.equal(exec.seniority, "executive");

  const personal = enrichProspect({ name: "Sam Rivera", email: "sam.rivera@gmail.com", title: "Sales Manager" });
  assert.equal(personal.workEmail, false, "a free personal provider is not a work address");
  assert.equal(personal.seniority, "mid");

  const blank = enrichProspect({ name: "No Title" });
  assert.equal(blank.domain, "");
  assert.equal(blank.workEmail, false);
  assert.equal(blank.seniority, "unknown");
});

test("scoring rewards seniority, a work email at the company's own domain, and completeness, and stays within 0-100", () => {
  const executive = enrichProspect({
    name: "Amara Diallo", email: "amara@northwind.io", company: "Northwind", domain: "northwind.io",
    title: "Chief Revenue Officer", phone: "+1 555 0100", linkedin: "linkedin.com/in/amara", source: "conference-2026",
  });
  const executiveScore = scoreProspect(executive);
  assert.ok(executiveScore <= 100, "the score never runs past the ceiling");
  assert.ok(executiveScore >= 90, `a fully filled-in executive row should score near the top, got ${executiveScore}`);

  const bare = enrichProspect({ name: "Unknown Person", email: "unknown@gmail.com" });
  const bareScore = scoreProspect(bare);
  assert.ok(bareScore < executiveScore, "a bare personal-email row scores well below a filled-in executive one");
  assert.equal(bareScore, 0, "no seniority, no work email, nothing else filled in: the floor");
});

/* ------------------------------------------------------------------ de-duplication */

test("two rows for the same email fold into one, the higher-scoring version wins, and both sources survive", () => {
  const prospects = [
    { name: "Amara Diallo", email: "amara@northwind.io", company: "Northwind", title: "Director of Sales", source: "list-a" },
    { name: "Amara Diallo", email: "AMARA@Northwind.io", company: "Northwind", title: "Chief Revenue Officer",
      phone: "+1 555 0100", linkedin: "linkedin.com/in/amara", source: "list-b" },
  ];
  const result = exportLeads(prospects);
  assert.equal(result.totalInput, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.leads.length, 1);
  const [kept] = result.leads;
  assert.equal(kept.title, "Chief Revenue Officer", "the higher-scoring duplicate is the one kept");
  assert.deepEqual(new Set(kept.sources), new Set(["list-a", "list-b"]), "a dropped duplicate's source is not lost");
});

test("a row with an email and a later row for the same person with no email still collapse into one", () => {
  const result = exportLeads([
    { name: "Jun Park", email: "jun@acme.com", company: "Acme", title: "Director", source: "list-a" },
    { name: "Jun Park", company: "Acme", title: "Director of Operations", source: "list-b" },
  ]);
  assert.equal(result.totalInput, 2);
  assert.equal(result.duplicatesRemoved, 1, "the shared name-and-company key must catch this even though only one row has an email");
  assert.equal(result.leads.length, 1);
  assert.deepEqual(new Set(result.leads[0].sources), new Set(["list-a", "list-b"]));
});

test("two rows with no email fall back to name plus company for de-duplication", () => {
  assert.equal(
    dedupeKeyOf({ name: "Jun Park", company: "Acme Corp" }),
    dedupeKeyOf({ name: " jun  park ", company: "ACME CORP" }),
    "the same person spelled differently still lands on the same key",
  );
  const result = exportLeads([
    { name: "Jun Park", company: "Acme Corp", title: "VP Sales" },
    { name: "jun park", company: "Acme Corp" },
    { name: "Jun Park", company: "A Different Company" },
  ]);
  assert.equal(result.duplicatesRemoved, 1, "only the two rows that are really the same person collapse");
  assert.equal(result.leads.length, 2);
});

test("an untitled export sorts the shortlist highest score first", () => {
  const result = exportLeads([
    { name: "Low Signal", email: "low@gmail.com" },
    { name: "High Signal", email: "high@northwind.io", company: "Northwind", title: "Founder", source: "conf" },
    { name: "Mid Signal", email: "mid@northwind.io", company: "Northwind", title: "Manager" },
  ]);
  assert.deepEqual(result.leads.map((lead) => lead.name), ["High Signal", "Mid Signal", "Low Signal"]);
});

/* ------------------------------------------------------------------ wired into the product */

test("leads.export is a tool the owner can call, and it excludes duplicates from what it hands back", async (t) => {
  const { app } = await fixture(t);
  assert.ok(app.registry.names().includes("leads.export"), "the tool is registered, not just a library function");
  assert.equal(app.registry.permissionOf("leads.export"), "leads.read");

  const result = await app.runtime.executeTool("leads.export", {
    prospects: [
      { name: "Amara Diallo", email: "amara@northwind.io", company: "Northwind", title: "CEO", source: "fixture" },
      { name: "Amara Diallo", email: "amara@northwind.io", company: "Northwind", title: "CEO", source: "fixture-duplicate" },
      { name: "Priya Nair", email: "priya@openleaf.dev", company: "Openleaf", title: "Head of Growth", source: "fixture" },
    ],
  });
  assert.equal(result.totalInput, 3);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.leads.length, 2, "the exported results exclude the duplicate row");
  assert.deepEqual(result.leads.map((lead) => lead.name).sort(), ["Amara Diallo", "Priya Nair"]);
});
