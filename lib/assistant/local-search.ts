import type { LexiconIndexEntry, Scope } from "@/lib/lexicon";

const QUERY_NOISE = /(?:请|帮我|搜索|查找|找出|有哪些|表示|意思|含义|单词|词语|英语|英文|用于|可以|一个|一下|的|是|和|与|或)/g;

function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function score(entry: LexiconIndexEntry, rawQuery: string) {
  const query = normalized(rawQuery);
  const headword = normalized(entry.headword);
  const lookup = normalized(entry.lookup);
  const meaning = normalized(entry.chineseCore);
  let value = 0;
  if (headword === query || lookup === query) value += 200;
  if (headword.startsWith(query) || lookup.startsWith(query)) value += 110;
  if (headword.includes(query) || lookup.includes(query)) value += 70;
  if (meaning.includes(query)) value += 95;

  const english = query.match(/[a-z]+(?:['-][a-z]+)*/g) || [];
  for (const token of english) {
    if (headword === token || lookup === token) value += 80;
    else if (headword.startsWith(token) || lookup.startsWith(token)) value += 45;
    else if (headword.includes(token) || lookup.includes(token)) value += 22;
    else if (token.length >= 4 && headword.length <= 40) {
      const distance = editDistance(token, headword);
      if (distance <= Math.max(1, Math.floor(token.length / 4))) value += 18 - distance * 4;
    }
  }

  const chinese = query.replace(QUERY_NOISE, " ").match(/[\u3400-\u9fff]{1,8}/g) || [];
  for (const token of chinese) {
    if (meaning.includes(token)) value += 55 + token.length * 4;
    else {
      const shared = [...new Set(token)].filter((character) => meaning.includes(character)).length;
      value += shared * 5;
    }
  }
  if (entry.flags.highValue) value += 3;
  if (entry.flags.properName || entry.flags.formalReleaseEligible !== true) value -= 500;
  return value;
}

export function recallSearchCandidates(
  entries: LexiconIndexEntry[],
  query: string,
  options: { scopes?: Scope[]; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(12, Math.trunc(options.limit ?? 12)));
  const scoped = options.scopes?.length
    ? entries.filter((entry) => options.scopes!.some((scope) => entry.scopes.includes(scope)))
    : entries;
  return scoped
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.headword.localeCompare(right.entry.headword))
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}
