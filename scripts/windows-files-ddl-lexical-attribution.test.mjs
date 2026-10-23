import test from "node:test";
import assert from "node:assert/strict";
import {attributeSelectedDdl} from "./windows-files-ddl-lexical-attribution.mjs";
import {DIAGNOSTIC_IDENTITIES} from "./windows-files-schema-diagnostic-allowlist.mjs";
const row=sql=>{const[type,name,tbl_name]=DIAGNOSTIC_IDENTITIES.operations[0];return{type,name,tbl_name,sql};};
const compare=(left,right)=>attributeSelectedDdl("operations",[row(left)],[row(right)]).objects[0].category;
test("reports exact bytes/null without changing canonical or semantic proof",()=>{
  for(const sql of ["CREATE TABLE t(a TEXT DEFAULT 'private literal')",null,"invalid but identical"])
    assert.equal(compare(sql,sql),"exact_sql_bytes");
  const result=attributeSelectedDdl("operations",[row("CREATE TABLE t(a)")],[row("CREATE TABLE t(a)")]);
  assert.equal(result.canonicalBaselineVerified,false);assert.equal(result.semanticEquivalenceEstablished,false);
});
test("ignores only SQLite whitespace separating unchanged complete tokens",()=>{
  for(const [left,right]of [["CREATE TABLE t(a TEXT)"," \tCREATE\r\nTABLE t ( a\fTEXT ) "],
    ["SELECT - -1","SELECT -\t-1"],["SELECT 1e+3,0x10,1_000","SELECT  1e+3 , 0x10 , 1_000"]])
    assert.equal(compare(left,right),"whitespace_outside_quoted_tokens_only");
  for(const [left,right]of [["CREATE TABLE t(a)","CREATETABLE t(a)"],["SELECT 1 2","SELECT 12"],
    ["SELECT - -1","SELECT --1"],["SELECT a > = 1","SELECT a >= 1"],["SELECT a | | b","SELECT a || b"],
    ["SELECT a\u00a0b","SELECT a b"]])assert.equal(compare(left,right),"unresolved_token_or_structure_difference");
  assert.equal(compare("SELECT X'ABCD'","SELECT X 'ABCD'"),"unresolved_token_or_structure_difference");
  assert.equal(compare("SELECT X'ABCD'","SELECT  X'ABCD'"),"whitespace_outside_quoted_tokens_only");
});
test("quoted contents and escaped quote boundaries remain exact",()=>{
  for(const [left,right]of [["SELECT 'a b'","SELECT 'ab'"],["SELECT 'a''b'","SELECT 'a b'"],
    ['SELECT "a b"','SELECT "ab"'],["SELECT '/*literal*/'","SELECT ''"],
    ["SELECT 'a--b'","SELECT 'a-b'"],["SELECT `a``b`","SELECT `ab`"],
    ["SELECT [a b]","SELECT [ab]"]])assert.equal(compare(left,right),"unresolved_token_or_structure_difference");
  assert.equal(compare("SELECT 'a''b'","SELECT\n'a''b'"),"whitespace_outside_quoted_tokens_only");
});
test("identifier spelling is compared without assuming SQLite parser meaning",()=>{
  for(const [left,right]of [['CREATE TABLE t(a)','CREATE TABLE "t"([a])'],
    ['CREATE TABLE "a""b"(x)','CREATE TABLE `a"b`(x)'],
    ['CREATE TABLE `a``b`(x)','CREATE TABLE "a`b"(x)'],
    ['CREATE TABLE [t](a)','CREATE TABLE `t`("a")']])
    assert.equal(compare(left,right),"identifier_quoting_only_candidate");
  assert.equal(compare("SELECT 't'","SELECT t"),"unresolved_token_or_structure_difference");
  assert.equal(compare("CREATE TABLE T(a)","CREATE TABLE t(a)"),"unresolved_token_or_structure_difference");
});
test("comments are parsed without treating their content as SQL or nesting blocks",()=>{
  assert.equal(compare("SELECT/* same ' quote */1"," SELECT /* same ' quote */ 1 "),"whitespace_outside_quoted_tokens_only");
  assert.equal(compare("SELECT -- same comment\n1","SELECT\t-- same comment\n 1"),"whitespace_outside_quoted_tokens_only");
  for(const [left,right]of [["SELECT /*a b*/ 1","SELECT /*ab*/ 1"],["SELECT 1 --\n+2","SELECT 1 --+2"],
    ["SELECT /*outer /*inner*/ 1","SELECT /*outer inner*/ 1"],["SELECT 1","SELECT 1/* added */"],
    ["SELECT 1/* unclosed","SELECT 1/* unclosed altered"]])
    assert.equal(compare(left,right),"unresolved_token_or_structure_difference");
});
test("unsupported, malformed and structural differences stay unresolved",()=>{
  for(const [left,right]of [["SELECT 'unclosed","SELECT 'unclosed "],["SELECT [unclosed","SELECT [unclosed "],
    ['SELECT "unclosed','SELECT "unclosed '],["SELECT `unclosed","SELECT `unclosed "],
    ["SELECT [a]]b]"," SELECT [a]]b]"],["SELECT @v","SELECT  @v"],["SELECT 1abc","SELECT 1 abc"],
    ["SELECT 1\0","SELECT  1\0"],["CHECK(a>0)","CHECK(a>=0)"],["DEFAULT 1","DEFAULT 2"],
    ["DEFAULT 'SECRET_A'","DEFAULT 'SECRET_B'"],[null,"CREATE TABLE t(a)"]])
    assert.equal(compare(left,right),"unresolved_token_or_structure_difference");
});
test("safe outputs never include SQL, literal excerpts, comments or tokens",()=>{
  const result=attributeSelectedDdl("operations",[row("CREATE TABLE t(a DEFAULT 'DO_NOT_PRINT_LEFT')/*DO_NOT_PRINT_COMMENT*/")],
    [row("CREATE TABLE t(a DEFAULT 'DO_NOT_PRINT_RIGHT')")]);
  const text=JSON.stringify(result);assert.ok(!text.includes("DO_NOT_PRINT"));assert.ok(!text.includes("CREATE TABLE"));
  assert.ok(!text.includes('"tokens"'));assert.match(result.objects[0].expectedSqlSha256,/^[a-f0-9]{64}$/);
  const missing=attributeSelectedDdl("operations",[],[row("CREATE TABLE t(a)")]);
  assert.equal(missing.objects[0].expectedPresent,false);assert.equal(missing.objects[0].category,"unresolved_token_or_structure_difference");
});
test("rejects unselected objects and bounded source overflow without echoing content",()=>{
  assert.throws(()=>attributeSelectedDdl("operations",[{...row("DO_NOT_PRINT"),name:"unreviewed"}],[]),/definition_response_invalid/);
  assert.throws(()=>attributeSelectedDdl("operations",[row("DO_NOT_PRINT".repeat(20000))],[]),/definition_response_limit/);
  assert.throws(()=>attributeSelectedDdl("production",[],[]),/definition_response_invalid/);
  assert.equal(compare("+".repeat(32769),"+".repeat(32769)+" "),"unresolved_token_or_structure_difference");
});

const residual=(left,right)=>attributeSelectedDdl("operations",[row(left)],[row(right)]).objects[0].residualAttribution;
test("attributes comment-only edits without concatenating surrounding active tokens",()=>{
  for(const [left,right]of [["SELECT /* PRIVATE_OLD */ 1","SELECT /* PRIVATE_NEW */ 1"],
    ["SELECT /* removed */ 1","SELECT 1"],["SELECT 1 -- old\n+2","SELECT 1 -- new\n+2"],
    ["SELECT 1/* unclosed comment","SELECT 1"]]){
    const result=residual(left,right);assert.equal(result.reasonCategory,"comment_tokens_only");
    assert.equal(result.literalTokenSequenceChanged,false);assert.equal(result.commentTokenSequenceChanged,true);
  }
  for(const [left,right]of [["SELECT a/**/b","SELECT ab"],["SELECT -/**/-1","SELECT --1"],
    ["SELECT 1 -- disabled +2","SELECT 1 +2"],["SELECT '/* not a comment */'","SELECT ''"]])
    assert.equal(residual(left,right).reasonCategory,"non_comment_token_difference");
});
test("word-case candidates fold only ASCII unquoted words, never quoted content or literals",()=>{
  assert.equal(residual("CREATE TABLE t(a)","create table t(a)").reasonCategory,"word_case_only_candidate");
  assert.equal(residual("SELECT /* private_a */ word","select /* private_b */ WORD").reasonCategory,"comment_tokens_and_word_case_only_candidate");
  for(const [left,right]of [["SELECT 'PRIVATE_A'","SELECT 'private_a'"],['SELECT "PRIVATE_A"','SELECT "private_a"'],
    ["SELECT [PRIVATE_A]","SELECT [private_a]"],["SELECT `PRIVATE_A`","SELECT `private_a`"],
    ["SELECT X'AB'","SELECT X'ab'"]])assert.equal(residual(left,right).reasonCategory,"non_comment_token_difference");
});
test("residual counts and kind flags distinguish changed literal sequences without revealing values",()=>{
  const literal=residual("DEFAULT 'PRIVATE_LEFT'","DEFAULT 'PRIVATE_RIGHT'");
  assert.equal(literal.literalTokenSequenceChanged,true);assert.deepEqual(literal.tokenKindCounts.literal,{expected:1,observed:1});
  assert.deepEqual(literal.changedTokenKinds,["literal"]);
  assert.deepEqual(residual("DEFAULT 1","DEFAULT 2").changedTokenKinds,["number"]);
  const structure=residual("CHECK(a>0)","CHECK(a>=0 AND b>0)");assert.equal(structure.literalTokenSequenceChanged,false);
  assert.ok(structure.nonCommentTokenCounts.expected<structure.nonCommentTokenCounts.observed);
  assert.ok(!JSON.stringify({literal,structure}).includes("PRIVATE"));assert.ok(!JSON.stringify({literal,structure}).includes("CHECK("));
  assert.equal(residual("SELECT 'unclosed","SELECT 'unclosed ").reasonCategory,"unsupported_or_malformed_lexical_form");
  assert.equal(residual(null,"SELECT 1").reasonCategory,"null_sql_shape_difference");
});
