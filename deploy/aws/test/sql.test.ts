import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasColonName, lex, splitStatements, toNamedParameters } from "../src/sql.ts";
import { migrationFiles } from "../src/migrations.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../db/migrations");

test("$1, $2 become :p1, :p2 in code only", () => {
  const { sql, highest } = toNamedParameters(
    "select api_x($1::uuid, $2::jsonb, $10) -- $3 in a comment\n where a = '$4' and \"$5\" = $$ $6 $$ and b = $tag$ $7; $tag$ /* $8 */",
  );
  assert.equal(
    sql,
    "select api_x(:p1::uuid, :p2::jsonb, :p10) -- $3 in a comment\n where a = '$4' and \"$5\" = $$ $6 $$ and b = $tag$ $7; $tag$ /* $8 */",
  );
  assert.equal(highest, 10);
});

test("a $ inside a name is not a dollar quote, and E'' strings keep their escapes", () => {
  assert.equal(toNamedParameters("select a$b$ from t where x = $1").sql, "select a$b$ from t where x = :p1");
  assert.equal(toNamedParameters("select E'it\\'s $1', $1").sql, "select E'it\\'s $1', :p1");
  assert.equal(toNamedParameters("select 'it''s $1', $2").sql, "select 'it''s $1', :p2");
});

test("refuses :p1 style and $0", () => {
  assert.throws(() => toNamedParameters("select :p1"), /use \$1/);
  assert.throws(() => toNamedParameters("select $0"), /start at \$1/);
});

test("unclosed quotes and bodies are errors, not silent splits", () => {
  for (const bad of ["select 'abc", 'select "abc', "select $$ abc", "select /* abc", "select $x$ abc $y$"]) {
    assert.throws(() => lex(bad), /unclosed/, bad);
  }
});

test("nested block comments", () => {
  assert.deepEqual(splitStatements("/* a /* b; */ c; */ select 1; select 2"), ["/* a /* b; */ c; */ select 1", "select 2"]);
});

test("splits at ; outside strings, names, bodies and comments; drops comment-only pieces", () => {
  const text = `-- header; with a semicolon
create function f() returns int language plpgsql as $$
begin
  perform 1; -- inside
  return 2;
end
$$;

/* between; */
insert into t values ('a;b', "c;d");
-- trailing; comment only
`;
  const parts = splitStatements(text);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^-- header; with a semicolon\ncreate function f\(\)/);
  assert.match(parts[0], /return 2;\nend\n\$\$$/);
  assert.equal(parts[1], `/* between; */\ninsert into t values ('a;b', "c;d")`);
});

test("every current migration file splits into whole statements", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 7, "found B's migration files");
  const parsed = migrationFiles(MIGRATIONS);
  assert.deepEqual(parsed.map((f) => f.name), files);
  for (const file of parsed) {
    const text = readFileSync(join(MIGRATIONS, file.name), "utf8");
    assert.ok(file.statements.length > 0, file.name);
    for (const s of file.statements) {
      // Each piece is one statement: no ; left in its code, and every quote and body closed.
      const code = lex(s).filter((seg) => seg.kind === "code").map((seg) => seg.text).join("");
      assert.ok(!code.includes(";"), `${file.name}: a ; is left in ${s.slice(0, 80)}`);
      assert.ok(!hasColonName(s), `${file.name}: a :name in ${s.slice(0, 80)}`);
    }
    // Nothing but comments and spaces is lost.
    const kept = file.statements.join("\n");
    const strip = (t: string) => lex(t).filter((seg) => seg.kind !== "comment").map((seg) => seg.text).join("").replace(/[\s;]+/g, "");
    assert.equal(strip(kept), strip(text), file.name);
    // Every $$ body arrives whole.
    const bodies = lex(text).filter((seg) => seg.kind === "dollar").length;
    assert.equal(file.statements.reduce((n, s) => n + lex(s).filter((seg) => seg.kind === "dollar").length, 0), bodies, file.name);
  }
});

test("migrationFiles takes only numbered files, in order, and never db/supabase", () => {
  const names = migrationFiles(MIGRATIONS).map((f) => f.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.every((n) => /^\d{4}_/.test(n)));
});
