// Branch starter add-on: a small example that comes with Branch. It runs walled, like any add-on.
const glossary = [
  ["add-on", "Something other people wrote that adds skills, tools or filters. Every add-on arrives switched off."],
  ["walled", "Run as its own program behind the wall: no internet unless allowed, and no writing outside its scratch folder."],
  ["skill", "Written instructions the assistant reads when a task calls for them."],
  ["filter", "A rule that takes words out of, stops, or adds a note to what goes to the model and what comes back."],
  ["fingerprint", "A short code worked out from a file; if the file changes, so does the code."],
];

export default {
  id: "branch-starter",
  name: "Branch starter",
  description: "Counts words and looks up Branch's own words. An example of an add-on.",
  apiVersion: 1,
  permissions: ["text.read"],
  tools: [
    {
      name: "plugin.branch-starter.count",
      description: "Count the words, lines and characters in a piece of text.",
      permission: "text.read",
      input: { text: { type: "string", required: true, description: "The text to count" } },
      async run({ text }) {
        const value = String(text ?? "");
        return { words: value.split(/\s+/).filter(Boolean).length, lines: value ? value.split(/\r?\n/).length : 0, characters: value.length };
      },
    },
    {
      name: "plugin.branch-starter.glossary",
      description: "Look up a word Branch uses, such as add-on, walled or fingerprint.",
      permission: "text.read",
      search: { label: "Branch words" },
      input: { query: { type: "string", required: true, description: "The word to look up" } },
      async run({ query }) {
        const wanted = String(query ?? "").toLowerCase();
        return glossary.filter(([word, meaning]) => word.includes(wanted) || meaning.toLowerCase().includes(wanted))
          .map(([word, meaning]) => ({ word, meaning }));
      },
    },
  ],
};
