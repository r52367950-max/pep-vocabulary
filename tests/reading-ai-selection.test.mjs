import test from "node:test";
import assert from "node:assert/strict";
import { readingQuoteFromPoints, READING_QUOTE_LIMIT } from "../lib/reading-ai-selection.ts";

const article = {
  id: "article-a", title: "A real reading", author: "An author",
  paragraphs: [{ text: "  Small steps help. " }, { text: "Read every day. " }, { text: "Practice 🧭 with care." }],
};

test("reading quote uses exact source offsets across paragraphs and reversed selection", () => {
  const start = { paragraph: 0, offset: 8 }, end = { paragraph: 1, offset: 10 };
  const forward = readingQuoteFromPoints(article, start, end);
  const backward = readingQuoteFromPoints(article, end, start);
  assert.equal(forward.ok, true);
  assert.equal(backward.ok, true);
  assert.equal(forward.quote.text, "steps help. \n\nRead every");
  assert.equal(backward.quote.text, forward.quote.text);
  assert.deepEqual(forward.quote.start, start);
  assert.deepEqual(forward.quote.end, end);
  assert.equal(forward.quote.articleId, article.id);
  assert.equal(forward.quote.title, article.title);
  assert.equal(forward.quote.before, "  Small ");
  assert.equal(forward.quote.after, " day. ");
});

test("selection trims only source-edge whitespace and rejects empty/outside boundaries", () => {
  const result = readingQuoteFromPoints(article, { paragraph: 0, offset: 0 }, { paragraph: 0, offset: article.paragraphs[0].text.length });
  assert.equal(result.ok, true);
  assert.equal(result.quote.text, "Small steps help.");
  assert.deepEqual(result.quote.start, { paragraph: 0, offset: 2 });
  assert.deepEqual(result.quote.end, { paragraph: 0, offset: article.paragraphs[0].text.trimEnd().length });
  for (const point of [{ paragraph: -1, offset: 0 }, { paragraph: 8, offset: 0 }, { paragraph: 0.5, offset: 0 }, { paragraph: 0, offset: 1000 }, { paragraph: 0, offset: NaN }]) {
    assert.equal(readingQuoteFromPoints(article, point, { paragraph: 0, offset: 2 }).reason, "outside");
  }
  assert.equal(readingQuoteFromPoints(article, { paragraph: 0, offset: 0 }, { paragraph: 0, offset: 2 }).reason, "empty");
});

test("Unicode selection counts visible code points and never splits a surrogate pair", () => {
  const emoji = article.paragraphs[2].text.indexOf("🧭");
  assert.equal(readingQuoteFromPoints(article, { paragraph: 2, offset: emoji }, { paragraph: 2, offset: emoji + 1 }).reason, "outside");
  const complete = readingQuoteFromPoints(article, { paragraph: 2, offset: emoji }, { paragraph: 2, offset: emoji + 2 });
  assert.equal(complete.ok, true);
  assert.equal(complete.quote.text, "🧭");
  const full = { ...article, paragraphs: [{ text: "🧭".repeat(READING_QUOTE_LIMIT) }] };
  assert.equal(readingQuoteFromPoints(full, { paragraph: 0, offset: 0 }, { paragraph: 0, offset: full.paragraphs[0].text.length }).ok, true);
  const tooLong = { ...article, paragraphs: [{ text: "读".repeat(READING_QUOTE_LIMIT + 1) }] };
  assert.equal(readingQuoteFromPoints(tooLong, { paragraph: 0, offset: 0 }, { paragraph: 0, offset: tooLong.paragraphs[0].text.length }).reason, "too-long");
});
