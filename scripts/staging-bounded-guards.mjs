// Only generated, top-level conjunctive predicates are accepted. This is not a
// general SQL parser or a browser-input escape mechanism. Splitting permits
// workerd's expression limit while retaining every CHECK in the same batch.
export function splitGuardConjunction(expression) {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("invalid guard conjunction");
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < expression.length; i++) {
    const character = expression[i];
    if (quote) {
      if (character === quote) {
        if (expression[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === "[" || character === "]" || character === ";"
      || expression.slice(i, i + 2) === "--" || expression.slice(i, i + 2) === "/*")
      throw new Error("unsupported guard conjunction syntax");
    if (character === "(") { depth++; continue; }
    if (character === ")") { if (--depth < 0) throw new Error("unbalanced guard conjunction"); continue; }
    if (/[A-Za-z_]/.test(character)) {
      let end = i + 1;
      while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) end++;
      const token = expression.slice(i, end).toUpperCase();
      if (depth === 0) {
        // BETWEEN's AND and CASE's predicates are not top-level conjunctions.
        // OR would change precedence when split: reject, never reinterpret it.
        if (["OR", "BETWEEN", "CASE"].includes(token)) throw new Error("non-conjunctive guard expression");
        if (token === "AND") {
          const part = expression.slice(start, i).trim();
          if (!part) throw new Error("empty guard conjunct");
          parts.push(part); start = end;
        }
      }
      i = end - 1;
    }
  }
  if (quote || depth !== 0) throw new Error("unbalanced guard conjunction");
  const last = expression.slice(start).trim();
  if (!last) throw new Error("empty guard conjunct");
  parts.push(last);
  return parts;
}

export function boundedGuardInsert(table, expression) {
  if (!/^staging_native_authority_guard_[a-f0-9]{20}$/.test(table)) throw new Error("invalid guard table");
  return splitGuardConjunction(expression).map(predicate =>
    `INSERT INTO ${table}(ok) SELECT CASE WHEN (${predicate}) THEN 1 ELSE 0 END;`).join("\n");
}
