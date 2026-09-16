import test from "node:test";
import assert from "node:assert/strict";
import { allPresets, findPreset } from "../dist/providers/presets.js";
import { GeminiProvider } from "../dist/providers/gemini.js";

test("Provider presets catalog contains expected cloud and local providers", () => {
  const presets = allPresets();
  assert.ok(presets.length > 10, "At least 10 presets");
  
  const ids = presets.map(p => p.id);
  assert.ok(ids.includes("openai"), "OpenAI preset");
  assert.ok(ids.includes("anthropic"), "Anthropic preset");
  assert.ok(ids.includes("groq"), "Groq preset");
  assert.ok(ids.includes("ollama"), "Ollama local preset");
  assert.ok(ids.includes("lm-studio"), "LM Studio local preset");
  
  const openai = findPreset("openai");
  assert.ok(openai);
  assert.equal(openai.displayName, "OpenAI");
  assert.equal(openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(openai.headerStyle, "bearer");
  assert.ok(openai.modelIds.includes("gpt-4o"));
  assert.equal(openai.kind, "cloud");
  
  const ollama = findPreset("ollama");
  assert.ok(ollama);
  assert.equal(ollama.kind, "local");
  assert.equal(ollama.baseUrl, "http://127.0.0.1:11434/v1");
});

test("findPreset returns undefined for unknown preset", () => {
  assert.equal(findPreset("unknown-provider"), undefined);
});

test("Gemini provider validates options", () => {
  assert.throws(
    () => new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "", apiKey: "test" }),
    /model.*required/i
  );
  assert.throws(
    () => new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-pro", apiKey: "" }),
    /key.*required/i
  );
  assert.throws(
    () => new GeminiProvider({ endpoint: "http://insecure.com", model: "gemini-pro", apiKey: "test" }),
    /https/i
  );
});

test("Gemini provider can be instantiated with valid options", () => {
  const provider = new GeminiProvider({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-pro",
    apiKey: "test-key"
  });
  assert.equal(provider.name, "gemini");
});

test("Gemini provider rejects non-HTTPS endpoints except loopback", () => {
  // Loopback HTTP should be allowed
  assert.doesNotThrow(() => new GeminiProvider({
    endpoint: "http://127.0.0.1:8080/v1beta",
    model: "test",
    apiKey: "key"
  }), "Loopback HTTP should be allowed");
  
  // Non-loopback HTTP should be rejected
  assert.throws(() => new GeminiProvider({
    endpoint: "http://example.com/v1beta",
    model: "test",
    apiKey: "key"
  }), /https/i);
});

test("Gemini provider has correct name", () => {
  const provider = new GeminiProvider({
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-pro",
    apiKey: "test-key"
  });
  assert.equal(provider.name, "gemini");
});