import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {Providers} from '../lib/providers.mjs';
import {CodexAdapter} from '../lib/adapters/codex.mjs';

class Runtime extends EventEmitter {
  constructor(){super();this.id='codex';this.ready=true;this.roles=['worker','coordinator'];this.calls=[];this.released=[];this.canObserve=true;}
  async connect(){}
  async readSource(){return{id:'source',title:'Original title',preview:'Original goal'};}
  async sourceHistory(){return{entries:[{role:'user',text:'Original goal'},{role:'agent',text:'A decision remains.'}],latest:{id:'source-turn',status:'completed',summary:'A decision remains.'}};}
  async openSession(o){this.calls.push(o);return{id:o.sessionId || 'fresh-native'};}
  async startTurn(o){this.calls.push(o);return{id:'new-turn'};}
  async handoff(id){this.released.push(id);}
  close(){}
}
function fixture(){const store=new Store(':memory:'),runtime=new Runtime(),engine=new Engine(store,null,process.cwd(),{providers:new Providers([runtime])});const t=store.create({title:'Original title'});store.update(t.id,{external:true,threadId:'source',brief:'Original goal',status:'review'});engine.scheduleOverview=()=>{};return{store,runtime,engine,t};}

test('a single preview imports bounded context without starting work or resuming its source',async()=>{
  const {store,runtime,engine,t}=fixture();const before=store.get(t.id);
  const preview=await engine.migration.preview({taskId:t.id,application:'codex',proposedInRun:'first'});
  assert.equal(store.get(t.id).external,true);assert.equal(runtime.calls.length,0);assert.match(preview.coverage,/not the full original/);assert.equal(preview.context.entries.length,2);
  assert.throws(()=>engine.migration.confirm({taskId:t.id,previewId:preview.id,runId:'first'}),/later exchange/);
  const moved=engine.migration.confirm({taskId:t.id,previewId:preview.id,runId:'second'});
  assert.equal(moved.id,t.id);assert.equal(moved.title,before.title);assert.equal(moved.priority,before.priority);assert.equal(moved.origins[0].threadId,'source');assert.equal(moved.external,false);assert.equal(moved.threadId,null);assert.equal(moved.status,'queued');assert.equal(runtime.calls.length,0);
  assert.equal(engine.migration.confirm({taskId:t.id,previewId:preview.id}).id,t.id);assert.equal(store.get(t.id).origins.length,1);
  await assert.rejects(engine.dispatch(t.id),/next instruction/);
  await engine.dispatch(t.id,'Use the second option.');
  assert.equal(runtime.calls[0].sessionId,null);assert.deepEqual(runtime.calls[0].tools,[]);assert.match(runtime.calls[1].text,/untrusted historical evidence/);assert.match(runtime.calls[1].text,/Use the second option/);assert.equal(store.get(t.id).continuationNeedsPrompt,false);
  engine.close();store.close();
});
test('source changes, expired previews, active work and pending approvals block import',async()=>{
  const {store,engine,t}=fixture();const preview=await engine.migration.preview({taskId:t.id,application:'codex'});
  store.update(t.id,{summary:'A newer result'});assert.throws(()=>engine.migration.confirm({taskId:t.id,previewId:preview.id}),/source changed/);
  const next=await engine.migration.preview({taskId:t.id,application:'codex'});store.setMeta('migration:'+t.id,{...next,at:'2020-01-01'});assert.throws(()=>engine.migration.confirm({taskId:t.id,previewId:next.id}),/expired/);
  store.update(t.id,{pending:[{id:'approval'}]});await assert.rejects(engine.migration.preview({taskId:t.id,application:'codex'}),/outstanding/);engine.close();store.close();
});
test('handoff reserves synchronously, releases the writer, and returns through a new continuation',async()=>{
  const {store,engine,runtime,t}=fixture();const preview=await engine.migration.preview({taskId:t.id,application:'codex'});engine.migration.confirm({taskId:t.id,previewId:preview.id});store.update(t.id,{threadId:'managed-native',runtimeProvider:'codex',status:'review',continuationNeedsPrompt:false});
  let finish;runtime.handoff=id=>{runtime.released.push(id);return new Promise(resolve=>{finish=resolve;});};
  const pending=engine.migration.handoff(t.id);assert.equal(store.get(t.id).migrationReserved,true);await assert.rejects(engine.dispatch(t.id,'Do something'),/handoff/);await assert.rejects(engine.migration.handoff(t.id),/Pause/);finish();const handed=await pending;assert.equal(handed.external,true);assert.equal(handed.threadId,'managed-native');assert.deepEqual(runtime.released,['managed-native']);await assert.rejects(engine.dispatch(t.id,'Another action'),/owned by/);
  const back=await engine.migration.preview({taskId:t.id,application:'codex'});const returned=engine.migration.confirm({taskId:t.id,previewId:back.id});assert.equal(returned.threadId,null);assert.equal(returned.origins.length,2);assert.equal(returned.origins[1].threadId,'managed-native');engine.close();store.close();
});
test('failed release never transfers ownership or opens a competing writer',async()=>{const{store,engine,runtime,t}=fixture();store.update(t.id,{external:false,portableSession:true,threadId:'native',status:'review'});runtime.handoff=async()=>{throw new Error('Release failed');};await assert.rejects(engine.migration.handoff(t.id),/Release failed/);assert.equal(store.get(t.id).external,false);assert.equal(store.get(t.id).migrationReserved,false);engine.close();store.close();});
test('Codex handoff requires an observed unload and refuses active native work',async()=>{
  const wire=new EventEmitter();wire.call=async(method)=>method==='thread/read'?{thread:{status:{type:'notLoaded'}}}:{};const adapter=new CodexAdapter(wire);await adapter.handoff('native');wire.call=async()=>({thread:{status:{type:'active'}}});await assert.rejects(adapter.handoff('native'),/finish/);
});

test('a native handoff retains its workspace lease until its latest context is brought back',async()=>{
  const {store,engine,t}=fixture();store.update(t.id,{external:true,sourceCwd:process.cwd(),handoff:{sessionId:'native'}});const other=engine.capture({title:'Other writer'});await assert.rejects(engine.dispatch(other.id,'Write here'),/native app owns this workspace/);engine.close();store.close();
});
test('a source refresh already in flight cannot overwrite a confirmed continuation',async()=>{
  const {store,engine,runtime,t}=fixture();let finish;runtime.sourceHistory=()=>new Promise(resolve=>{finish=resolve;});const refreshing=engine.refreshSource(t.id);store.update(t.id,{external:false,threadId:null,summary:'Managed continuation'});finish({entries:[],latest:{id:'old-source',status:'completed',summary:'Old source'}});await refreshing;assert.equal(store.get(t.id).summary,'Managed continuation');assert.equal(store.get(t.id).threadId,null);engine.close();store.close();
});

test('Claude native opening happens only after SDK release while the handoff reservation remains held',async()=>{
  const {store,engine,runtime,t}=fixture();store.update(t.id,{external:false,portableSession:true,threadId:'native',status:'review'});let opening=false;
  runtime.openDesktop=async id=>{assert.deepEqual(runtime.released,['native']);assert.equal(id,'native');assert.equal(store.get(t.id).external,true);assert.equal(store.get(t.id).migrationReserved,true);opening=true;return true;};
  const out=await engine.migration.handoff(t.id);assert.equal(opening,true);assert.equal(out.handoff.nativeOpened,true);assert.equal(out.migrationReserved,false);engine.close();store.close();
});
