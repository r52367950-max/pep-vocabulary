/** Inflection candidates for matching an English token to a lexicon headword. */
const IRREGULAR: Record<string, string> = {
  found: "find", grew: "grow", grown: "grow", made: "make", seen: "see", saw: "see", took: "take", taken: "take",
  went: "go", gone: "go", came: "come", gave: "give", given: "give", knew: "know", known: "know", began: "begin",
  begun: "begin", built: "build", kept: "keep", left: "leave", stood: "stand", fell: "fall", fallen: "fall",
  felt: "feel", brought: "bring", thought: "think", taught: "teach", caught: "catch", led: "lead", lay: "lie",
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth", mice: "mouse",
};

export function lemmaCandidates(token: string): string[] {
  const word = token.toLowerCase().replace(/[’']s$/, "");
  // An irregular base form is tried first; the surface form stays as a fallback ("found" may be either).
  const out = new Set<string>(IRREGULAR[word] ? [IRREGULAR[word], word] : [word]);
  const add = (value: string) => { if (value.length >= 2) out.add(value); };
  if (word.endsWith("ies")) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) add(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) add(word.slice(0, -1));
  if (word.endsWith("ied")) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed")) { add(word.slice(0, -2)); add(word.slice(0, -1)); }
  if (word.endsWith("ing")) { add(word.slice(0, -3)); add(`${word.slice(0, -3)}e`); }
  for (const value of [...out]) {
    // Doubled final consonant: "planned" → "plan".
    if (/([b-df-hj-np-tv-z])\1$/.test(value)) add(value.slice(0, -1));
  }
  for (const value of [...out]) {
    if (value.includes("iz")) add(value.replace(/iz(e|ed|es|ing|ation)?$/, "is$1"));
    if (value.includes("is")) add(value.replace(/is(e|ed|es|ing|ation)?$/, "iz$1"));
  }
  return [...out];
}

/** English word tokens in reading order, without punctuation. */
export function englishTokens(text: string): string[] {
  return text.normalize("NFKC").match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*/g) ?? [];
}
