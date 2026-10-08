import test from "node:test";
import assert from "node:assert/strict";
import { isLong, plainPreview, sizeLabel, wordCount } from "../web/requests.mjs";

test("a request answers in its card only when all of it fits there", () => {
  const short = { title: "Ship it?", detail: "The tests pass and the copy is approved.", options: ["Yes", "Not yet"] };
  assert.equal(isLong(short), false);
  assert.equal(isLong({ ...short, detail: "word ".repeat(61) }), true, "more than 60 words of detail");
  assert.equal(isLong({ ...short, options: ["A", "B", "C", "D"] }), true, "more than three options");
  assert.equal(isLong({ ...short, options: ["Yes", "Grandfather annual plans only, until renewal"] }), true, "an option over 32 characters");
  assert.equal(isLong({ title: "What's the staging URL?", options: [] }), false);
  assert.equal(isLong({}), false);
});

test("the card preview is the first prose paragraph as plain text, never a heading, table or code", () => {
  const detail = [
    "## Context",
    "",
    "| Option | Cost |",
    "| --- | --- |",
    "| A | $1 |",
    "",
    "```js",
    "deleteRows();",
    "```",
    "",
    "**What's blocked:** the [backfill](https://example.com) for `billing_rates`,",
    "which *deletes* old rows.",
    "",
    "Second paragraph.",
  ].join("\n");
  assert.equal(plainPreview(detail), "What's blocked: the backfill for billing_rates, which deletes old rows.");
  assert.equal(plainPreview("- first item\n- second item"), "first item second item");
  assert.equal(plainPreview(""), "");
  assert.equal(plainPreview(undefined), "");
  const long = plainPreview("word ".repeat(200), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
  assert.equal(plainPreview("snake_case_name and file_name.md stay intact"), "snake_case_name and file_name.md stay intact");
});

test("the size label counts words and options", () => {
  assert.equal(wordCount("It's $18k/month, not 6k."), 4);
  assert.equal(sizeLabel({ detail: "one two three", options: ["A", "B"] }), "3 words · 2 options");
  assert.equal(sizeLabel({ detail: "one", options: ["A"] }), "1 word · 1 option");
  assert.equal(sizeLabel({ options: [] }), "");
});

test("a title too long to show whole in a card makes the request long", () => {
  assert.equal(isLong({ title: "x".repeat(140), options: [] }), false);
  assert.equal(isLong({ title: "x".repeat(141), options: [] }), true);
});
