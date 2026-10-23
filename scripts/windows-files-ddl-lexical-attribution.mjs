import {createHash} from "node:crypto";
import {selectDiagnosticDefinitions} from "./windows-files-schema-definition-diagnostic.mjs";

const hash=value=>value===null?null:createHash("sha256").update(value).digest("hex");
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const space=c=>c!==undefined&&/[\t\n\f\r ]/.test(c);
const letter=c=>c!==undefined&&(/[A-Za-z_]/.test(c)||c.charCodeAt(0)>127);
const word=c=>letter(c)||c!==undefined&&/[0-9$]/.test(c);
const digit=c=>c!==undefined&&/[0-9]/.test(c);
const MAX_TOKENS=32768;

// A conservative attribution lexer, NOT a SQL parser or SQLite equivalence
// oracle. Tokens never leave this module. Comments/literals retain exact bytes.
function tokens(sql){
  if(sql.includes("\0"))return null;
  const output=[];let i=0;
  const add=(kind,start,end,value)=>{output.push({kind,raw:sql.slice(start,end),value});return output.length<=MAX_TOKENS;};
  while(i<sql.length){
    const start=i,c=sql[i];
    if(space(c)){i++;continue;}
    if(c==="-"&&sql[i+1]==="-"){
      i+=2;while(i<sql.length&&sql[i]!=="\n")i++;if(i<sql.length)i++;
      if(!add("comment",start,i))return null;continue;
    }
    if(c==="/"&&sql[i+1]==="*"){
      const end=sql.indexOf("*/",i+2);i=end<0?sql.length:end+2;
      if(!add("comment",start,i))return null;continue;
    }
    if((c==="x"||c==="X")&&sql[i+1]==="'"){
      const end=sql.indexOf("'",i+2);if(end<0)return null;
      const hex=sql.slice(i+2,end);if(hex.length%2||!/^[0-9a-fA-F]*$/.test(hex))return null;
      i=end+1;if(!add("blob",start,i))return null;continue;
    }
    if(c==="'"||c==='"'||c==='`'||c==="["){
      const closing=c==="["?"]":c;let value="",closed=false;i++;
      while(i<sql.length){
        if(sql[i]===closing){
          if(c!=="["&&sql[i+1]===closing){value+=closing;i+=2;continue;}
          i++;closed=true;break;
        }
        value+=sql[i++];
      }
      if(!closed||!add(c==="'"?"literal":"quoted_identifier",start,i,value))return null;
      continue;
    }
    if(letter(c)){
      i++;while(word(sql[i]))i++;
      if(!add("word",start,i,sql.slice(start,i)))return null;continue;
    }
    if(digit(c)||c==="."&&digit(sql[i+1])){
      const number=sql.slice(i).match(/^(?:0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|(?:[0-9](?:_?[0-9])*(?:\.[0-9]*(?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/)?.[0];
      if(!number)return null;i+=number.length;
      if(word(sql[i]))return null;
      if(!add("number",start,i))return null;continue;
    }
    const operator=["->>","||","<<",">>","<=",">=","==","!=","<>","->"].find(op=>sql.startsWith(op,i));
    if(operator){i+=operator.length;if(!add("operator",start,i))return null;continue;}
    if("(),;.~+-*/%&|<=>".includes(c)){i++;if(!add("punctuation",start,i))return null;continue;}
    return null; // Parameters/unsupported forms remain unresolved, never guessed.
  }
  return output;
}
function classify(expected,observed){
  if(expected===observed)return "exact_sql_bytes";
  if(expected===null||observed===null)return "unresolved_token_or_structure_difference";
  const left=tokens(expected),right=tokens(observed);
  if(!left||!right)return "unresolved_token_or_structure_difference";
  if(same(left.map(t=>[t.kind,t.raw]),right.map(t=>[t.kind,t.raw])))return "whitespace_outside_quoted_tokens_only";
  const spelling=list=>list.map(t=>[t.kind==="word"||t.kind==="quoted_identifier"?"identifier_spelling":t.kind,
    t.kind==="word"||t.kind==="quoted_identifier"?t.value:t.raw]);
  if(same(spelling(left),spelling(right)))return "identifier_quoting_only_candidate";
  return "unresolved_token_or_structure_difference";
}
function residualAttribution(expected,observed){
  if(!expected||!observed)return {reasonCategory:"definition_presence_difference"};
  if(expected.sql===null||observed.sql===null)return {reasonCategory:"null_sql_shape_difference"};
  const left=tokens(expected.sql),right=tokens(observed.sql);
  if(!left||!right)return {reasonCategory:"unsupported_or_malformed_lexical_form"};
  const sequence=list=>list.map(t=>[t.kind,t.raw]);
  // Remove complete comment tokens AFTER lexing. Never concatenate source
  // fragments: a/**/b cannot become ab, nor can -/**/- become a line comment.
  const active=list=>list.filter(t=>t.kind!=="comment");
  const fold=list=>list.map(t=>[t.kind,t.kind==="word"?t.raw.replace(/[A-Z]/g,c=>c.toLowerCase()):t.raw]);
  const a=active(left),b=active(right);
  let reasonCategory="non_comment_token_difference";
  if(same(sequence(a),sequence(b)))reasonCategory="comment_tokens_only";
  else if(same(fold(left),fold(right)))reasonCategory="word_case_only_candidate";
  else if(same(fold(a),fold(b)))reasonCategory="comment_tokens_and_word_case_only_candidate";
  const kinds=["word","quoted_identifier","literal","blob","number","comment","operator","punctuation"];
  const tokenKindCounts=Object.fromEntries(kinds.map(kind=>[kind,{expected:left.filter(t=>t.kind===kind).length,observed:right.filter(t=>t.kind===kind).length}]));
  const literalSequence=list=>sequence(list.filter(t=>t.kind==="literal"||t.kind==="blob"));
  return {reasonCategory,tokenKindCounts,
    changedTokenKinds:kinds.filter(kind=>!same(sequence(left.filter(t=>t.kind===kind)),sequence(right.filter(t=>t.kind===kind)))),
    literalTokenSequenceChanged:!same(literalSequence(a),literalSequence(b)),
    nonCommentTokenCounts:{expected:a.length,observed:b.length},
    commentTokenSequenceChanged:!same(sequence(left.filter(t=>t.kind==="comment")),sequence(right.filter(t=>t.kind==="comment")))};
}
const RAISE_RELATION_IDENTITIES=new Set([
  JSON.stringify(["operations","trigger","native_staff_onboarding_approve_finish","native_staff_management_commands"]),
  JSON.stringify(["operations","trigger","operations_directory_audit_original_subject_required","operations_directory_audit"]),
  JSON.stringify(["delivery","trigger","client_folder_notification_batch_control_result","client_folder_notification_batch_controls"]),
]);
function raiseWhereRelation(app,before,after){
  if(!before||!after||before.sql===null||after.sql===null
    ||!RAISE_RELATION_IDENTITIES.has(JSON.stringify([app,before.type,before.name,before.tbl_name])))return undefined;
  const rawLeft=tokens(before.sql),rawRight=tokens(after.sql);if(!rawLeft||!rawRight)return undefined;
  const left=rawLeft.filter(t=>t.kind!=="comment"),right=rawRight.filter(t=>t.kind!=="comment");
  const is=(token,kind,text)=>token?.kind===kind&&token.raw===text;
  const wordToken=text=>({kind:"word",raw:text,value:text});
  const matches=[];
  for(let i=0;i<left.length;i++){
    if(!is(left[i],"word","SELECT")||!is(left[i+1],"word","RAISE")||!is(left[i+2],"punctuation","("))continue;
    // This reviewed relation supports only ABORT and one literal second arg.
    // Expressions, additional args and other RAISE modes are not generalized.
    if(!is(left[i+3],"word","ABORT")||!is(left[i+4],"punctuation",",")||left[i+5]?.kind!=="literal"
      ||!is(left[i+6],"punctuation",")")||!is(left[i+7],"word","WHERE"))return undefined;
    let end=i+8,depth=0,cases=0;
    for(;end<left.length;end++){
      const token=left[end];
      if(is(token,"punctuation",";")){if(depth||cases)return undefined;break;}
      if(is(token,"punctuation","("))depth++;
      else if(is(token,"punctuation",")")){if(--depth<0)return undefined;}
      else if(is(token,"word","CASE"))cases++;
      else if(is(token,"word","END")){if(--cases<0)return undefined;}
      else if(!depth&&!cases&&token.kind==="word"&&["SELECT","BEGIN","THEN","ELSE","WHEN"].includes(token.raw))return undefined;
    }
    if(end===left.length||end===i+8||depth||cases)return undefined;
    matches.push({start:i,end,message:left[i+5],predicate:left.slice(i+8,end),raise:left.slice(i+1,i+7)});
    i=end;
  }
  if(matches.length!==1)return undefined;
  const m=matches[0];
  const transformed=[...left.slice(0,m.start),left[m.start],wordToken("CASE"),wordToken("WHEN"),...m.predicate,
    wordToken("THEN"),...m.raise,wordToken("END"),left[m.end],...left.slice(m.end+1)];
  const messageIndex=transformed.indexOf(m.message);
  if(right.length!==transformed.length||right[messageIndex]?.kind!=="literal")return undefined;
  // Mask exactly one known ABORT-message position, never arbitrary literals.
  if(!transformed.every((token,index)=>index===messageIndex||token.kind===right[index]?.kind&&token.raw===right[index]?.raw))return undefined;
  return {category:"syntax_relation_candidate",pattern:"select_raise_where_to_select_case_when_v1",
    predicateAndOtherActiveTokensMatch:true,
    raiseAbortMessage:{changed:m.message.raw!==right[messageIndex].raw,expectedLiteralSha256:hash(m.message.raw),observedLiteralSha256:hash(right[messageIndex].raw)},
    semanticEquivalenceEstablished:false,canonicalBaselineVerified:false};
}

/** Local reviewed selected captures only. No paths, remote IO, SQL execution,
 * normalization approval, literal excerpts, or raw tokens in the safe result. */
export function attributeSelectedDdl(app,expectedRows,observedRows){
  const expected=selectDiagnosticDefinitions(app,expectedRows,{selectedOnly:true});
  const observed=selectDiagnosticDefinitions(app,observedRows,{selectedOnly:true});
  const key=r=>JSON.stringify([r.type,r.name,r.tbl_name]);
  const left=new Map(expected.map(r=>[key(r),r])),right=new Map(observed.map(r=>[key(r),r]));
  const objects=[...new Set([...left.keys(),...right.keys()])].sort().map(id=>{
    const before=left.get(id),after=right.get(id),identity=before??after;
    const category=before&&after?classify(before.sql,after.sql):"unresolved_token_or_structure_difference";
    const syntaxRelation=category==="unresolved_token_or_structure_difference"?raiseWhereRelation(app,before,after):undefined;
    return {type:identity.type,name:identity.name,tbl_name:identity.tbl_name,
      expectedPresent:!!before,observedPresent:!!after,
      expectedSqlSha256:before?hash(before.sql):null,observedSqlSha256:after?hash(after.sql):null,
      category,...(category==="unresolved_token_or_structure_difference"?{residualAttribution:residualAttribution(before,after)}:{}),
      ...(syntaxRelation?{syntaxRelation}: {})};
  });
  const categories=Object.fromEntries(["exact_sql_bytes","whitespace_outside_quoted_tokens_only","identifier_quoting_only_candidate","unresolved_token_or_structure_difference"]
    .map(category=>[category,objects.filter(r=>r.category===category).length]));
  return {schemaVersion:1,app,scope:"Lexical attribution of selected local DDL only; no semantic equivalence or readiness proof",objects,categories,
    canonicalBaselineVerified:false,semanticEquivalenceEstablished:false,
    caveat:"Identifier quoting and word case are lexical candidates only: SQLite may interpret double-quoted tokens as literals in legacy contexts. Comment attribution never joins surrounding tokens. No SQL is executed or normalized into approval."};
}
