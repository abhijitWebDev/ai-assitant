/** Small, dependency-free text utilities: chunking, BM25 ranking and near-duplicate detection. */

const STOPWORDS = new Set(
  "a an and are as at be by for from has have how in is it its of on or that the this to was were what when where which who why will with does do did can could should would about into than then them they their there these those not no yes you your we our i".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split text into overlapping chunks, preferring paragraph and sentence boundaries. */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      if (para > size * 0.5) end = start + para;
      else if (sentence > size * 0.5) end = start + sentence + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Okapi BM25 over an in-memory corpus. Returns indices sorted by score (desc), zero scores dropped. */
export function bm25Rank(query: string, docs: string[], k1 = 1.5, b = 0.75): { index: number; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map(tokenize);
  const avgLen = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);

  const N = docs.length;
  const scored = toks.map((t, index) => {
    const tf = new Map<string, number>();
    for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avgLen)));
    }
    return { index, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

function shingles(text: string, n = 3): Set<string> {
  const t = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  if (!out.size && t.length) out.add(t.join(" "));
  return out;
}

/** Jaccard similarity on word 3-grams; >0.6 means "same passage, different source". */
export function similarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
