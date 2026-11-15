import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { wikilinkCompletionSource } from "../ui/src/wikilink-completion";

const context = (doc: string) => new CompletionContext(EditorState.create({doc}), doc.length, false);
const suggestion = {path:"companies/Acme.md",target:"Acme",name:"Acme",folder:"companies",drawing:false};

test("completion queries the index again as text changes and discards cancelled replies", async () => {
  const queries: string[] = [];
  const complete = wikilinkCompletionSource(async(query)=>{queries.push(query);return [suggestion];});
  await complete(context("[["));
  const result = await complete(context("[[Ac"));
  assert.deepEqual(queries,["","Ac"]);
  assert.equal(result!.filter,false);
  assert.equal(result!.validFor,undefined);
  assert.equal(await complete(context("ordinary letters")),null);
  assert.equal(await complete(context("[[Acme#heading")),null);
  const cancelled = context("[[Ac");
  Object.defineProperty(cancelled,"aborted",{value:true});
  assert.equal(await complete(cancelled),null);
});

test("accepting completion retains the existing closing brackets and surrounding text", async () => {
  const result = (await wikilinkCompletionSource(async()=>[suggestion])(context("Company: [[Ac")))!;
  const completion = result.options[0];
  let state = EditorState.create({doc:"Company: [[Ac]] suffix"});
  const view = {get state(){return state;},dispatch(spec:any){state=state.update(spec).state;}};
  assert.equal(typeof completion.apply,"function");
  (completion.apply as Function)(view,completion,result.from,13);
  assert.equal(state.doc.toString(),"Company: [[Acme]] suffix");
  assert.equal(state.selection.main.head,17);
});
