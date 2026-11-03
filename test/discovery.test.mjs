import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {CodexAdapter} from '../lib/adapters/codex.mjs';
import {chatDescription,importPreviewScene,rankChatMatches} from '../public/discovery.js';
import {pasteDisposition,immediateAcknowledgement} from '../public/flow.js';

test('composer paste remains a draft; the surrounding room submits and settings are untouched',()=>{
  assert.equal(pasteDisposition({editable:true,thought:true}),'draft');
  assert.equal(pasteDisposition({}),'submit');
  assert.equal(pasteDisposition({editable:true}),'ignore');
  assert.equal(pasteDisposition({inDrawer:true}),'ignore');
});
test('quick acknowledgement names the request without claiming success',()=>{
  assert.equal(immediateAcknowledgement('Can you find my old ChatGPT conversation?'),'I’ll look for that conversation.');
  assert.equal(immediateAcknowledgement('Snooze that until Friday'),'Let me check your queue.');
  assert.equal(immediateAcknowledgement('Why did it do that?'),'Let me think about that.');
});
test('spoken import preview includes the purpose and keeps tool metadata offstage',()=>{
  const batch={application:'codex',candidates:[{id:'chat',title:'Planning a launch',cwd:'/sample/Launch',preview:'Plan the product launch and decide the first customer segment.'}]};
  const scene=importPreviewScene(batch,{question:'Bring Planning a launch in?',context:'Search batch 12345678-1234-1234-1234-123456789abc; thread ID chat; workspace /sample/Launch. The preview is restored.'});
  assert.match(scene.spoken,/Plan the product launch/);assert.match(scene.spoken,/Should I add it/);
  assert.doesNotMatch(scene.spoken,/batch|restored|workspace|12345678/);
  assert.equal(chatDescription({preview:'Decide the next launch milestone.\nSearch batch 12345678-1234-1234-1234-123456789abc'}),'Decide the next launch milestone.');
});
test('topic ranking is case insensitive and supports bounded preview matches',()=>{
  const rows=[{id:'a',title:'Fly copulation duration',preview:'Research',updatedAt:'2026-01-01'}, {id:'b',title:'New analysis',preview:'Study fly copulation and fertility',updatedAt:'2026-02-01'},{id:'c',title:'Unrelated',preview:'Other work'}];
  assert.deepEqual(rankChatMatches(rows,'Find my FLY copulation conversation').map(c=>c.id),['a','b']);
});
test('Codex discovery combines indexed title variants with recent previews without resuming sources',async()=>{
  class Transport extends EventEmitter{
    ready=true;calls=[];async start(){}
    async call(method,params){this.calls.push({method,params});return{data:params.searchTerm==='Fly'?[{id:'old',name:'Fly copulation duration',preview:'Earlier research',updatedAt:1}]:!params.searchTerm?[{id:'recent',name:'Experiment',preview:'Fly copulation measurements',updatedAt:2}]:[],nextCursor:null};}
  }
  const transport=new Transport(),adapter=new CodexAdapter(transport);
  const result=await adapter.discover(null,'fly copulation');
  assert.deepEqual(result.data.map(c=>c.id),['old','recent']);assert.match(result.scope,/Consumer ChatGPT web history is not included/);
  assert.ok(transport.calls.every(c=>c.method==='thread/list'));
});


test('consumer ChatGPT history reports its unavailable scope without pretending to search Codex',async()=>{
  const store=new Store(':memory:'),transport=new EventEmitter();transport.ready=true;transport.stop=()=>{};
  transport.call=async()=>{throw new Error('Consumer lookup must not masquerade as a Codex search');};
  const engine=new Engine(store,transport,process.cwd());const result=await engine.discover(null,'old topic','chatgpt');
  assert.deepEqual(result.threads,[]);assert.match(result.searchScope,/No ChatGPT history was searched/);assert.match(result.unavailableReason,/not exposed/);engine.close();store.close();
});
