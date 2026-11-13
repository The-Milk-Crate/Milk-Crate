/**
 * A small SQL lexer for two jobs on the RDS Data API:
 *  - turning `$1`, `$2` into the Data API's named parameters (`:p1`, `:p2`), and
 *  - splitting a migration file into single statements (the Data API runs one per call).
 *
 * It knows what can hide a `$1` or a `;`: quoted strings ('...', E'...'), quoted names ("..."),
 * dollar-quoted bodies ($$...$$, $tag$...$tag$), line comments (--) and block comments (nested).
 * Everything else is code.
 */

export type Segment = { kind: "code" | "string" | "name" | "dollar" | "comment"; text: string };

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

export function lex(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = "";
  let i = 0;
  const flush = () => {
    if (code) out.push({ kind: "code", text: code });
    code = "";
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      flush();
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }

    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      if (depth > 0) throw new Error("unclosed /* comment");
      flush();
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "'") {
      // E'...' (escape string) when the E stands alone, not the end of a name like `type'`.
      const prev = code[code.length - 1];
      const before = code[code.length - 2];
      const escaped = (prev === "E" || prev === "e") && (before === undefined || !IDENT_PART.test(before));
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("unclosed string");
        if (escaped && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      flush();
      out.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unclosed "name"');
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      flush();
      out.push({ kind: "name", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "$") {
      // A dollar quote starts $$ or $tag$, and not inside a name (names may hold $).
      const prev = code[code.length - 1];
      const inName = prev !== undefined && IDENT_PART.test(prev);
      if (!inName) {
        let j = i + 1;
        if (j < sql.length && IDENT_START.test(sql[j])) {
          j++;
          while (j < sql.length && /[A-Za-z0-9_\u0080-￿]/.test(sql[j])) j++;
        }
        if (sql[j] === "$") {
          const tag = sql.slice(i, j + 1);
          const end = sql.indexOf(tag, j + 1);
          if (end < 0) throw new Error(`unclosed ${tag} body`);
          flush();
          out.push({ kind: "dollar", text: sql.slice(i, end + tag.length) });
          i = end + tag.length;
          continue;
        }
      }
    }

    code += c;
    i++;
  }
  flush();
  return out;
}

/**
 * `$1`, `$2` in code become `:p1`, `:p2`. Text in strings, names, comments and dollar bodies is
 * left alone. Returns the new text and the highest number used.
 */
export function toNamedParameters(sql: string): { sql: string; highest: number } {
  let highest = 0;
  const text = lex(sql)
    .map((s) => {
      if (s.kind !== "code") return s.text;
      if (/:p\d/.test(s.text)) throw new Error("use $1, $2 for parameters, not :p1");
      return s.text.replace(/\$(\d+)(?![0-9A-Za-z_])/g, (_m, n: string) => {
        const k = Number(n);
        if (k < 1) throw new Error("parameters start at $1");
        highest = Math.max(highest, k);
        return `:p${k}`;
      });
    })
    .join("");
  return { sql: text, highest };
}

/**
 * Splits a file of SQL into statements at the `;` that end them. Comments stay with the
 * statement after them; a piece that holds only comments and spaces is dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasCode = false;
  for (const s of lex(sql)) {
    if (s.kind !== "code") {
      current += s.text;
      if (s.kind !== "comment") hasCode = true;
      continue;
    }
    const parts = s.text.split(";");
    for (let k = 0; k < parts.length; k++) {
      current += parts[k];
      if (parts[k].trim()) hasCode = true;
      if (k < parts.length - 1) {
        if (hasCode) statements.push(current.trim());
        current = "";
        hasCode = false;
      }
    }
  }
  if (hasCode) statements.push(current.trim());
  return statements;
}

/** True if the SQL has text the Data API could read as a named parameter (`:name`, not `::`). */
export function hasColonName(sql: string): boolean {
  return lex(sql).some((s) => s.kind === "code" && /(^|[^:]):[A-Za-z_]/.test(s.text));
}
