import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutosave} from '../public/autosave.js';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {EventEmitter} from 'node:events';
import {taskState,shortcutMarkup} from '../public/task-status.js';
import {activityTime} from '../public/rotation.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('autosave serializes rapid selections and keeps the latest optimistic edit',async()=>{
  const calls=[],pending=[],saved=[],persisted=[];
  const saver=createAutosave({save:patch=>{calls.push(patch);return new Promise(resolve=>pending.push(resolve));},onSaved:(_result,patch)=>saved.push(patch),persist:patch=>persisted.push(patch)});
  saver.update({naturalVoiceId:'first'});saver.update({naturalVoiceId:'second',voiceRate:1.15});
  assert.equal(calls.length,1);assert.deepEqual(saver.snapshot(),{naturalVoiceId:'second',voiceRate:1.15});
  pending.shift()({});await tick();assert.equal(calls.length,2);assert.deepEqual(calls[1],{naturalVoiceId:'second',voiceRate:1.15});
  pending.shift()({});await saver.flush();assert.equal(saver.dirty,false);assert.deepEqual(persisted.at(-1),{});assert.equal(saved.length,2);
});
test('failed autosave retains edits for retry, including changes made in flight',async()=>{
  let reject,fail=true;const statuses=[];
  const saver=createAutosave({save:()=>fail?new Promise((_resolve,r)=>{reject=r;}):Promise.resolve(),onStatus:s=>statuses.push(s)});
  saver.update({name:'Alex'});saver.update({name:'Casey',voiceTone:'upbeat'});reject(new Error('Offline'));await saver.flush();
  assert.equal(saver.error.message,'Offline');assert.deepEqual(saver.snapshot(),{name:'Casey',voiceTone:'upbeat'});assert.equal(statuses.at(-1),'error');
  fail=false;await saver.retry();assert.equal(saver.error,null);assert.equal(saver.dirty,false);assert.equal(statuses.at(-1),'saved');
});
test('text autosave batches input and restores browser-persisted edits',async()=>{
  const calls=[];const saver=createAutosave({initial:{name:'Alex'},delayMs:5,save:async patch=>calls.push(patch)});
  saver.update({personality:'Warm'},{debounce:true});saver.update({personality:'Warm and concise'},{debounce:true});assert.equal(calls.length,0);
  await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(calls,[{name:'Alex',personality:'Warm and concise'}]);assert.equal(saver.dirty,false);
});
class FakeCodex extends EventEmitter {stop(){}}
function fixture(){const store=new Store(':memory:'),engine=new Engine(store,new FakeCodex(),process.cwd());store.setMeta('projects',[{id:'a',name:'A',path:process.cwd()},{id:'b',name:'B',path:process.cwd()}]);return{store,engine};}
test('named sorting replaces both drag orders atomically and guards stale requests',()=>{
  const {store,engine}=fixture(),a=engine.capture({title:'Old',projectId:'a'}),b=engine.capture({title:'New',projectId:'b'});
  store.update(a.id,{lastActivityAt:'2026-01-01T00:00:00Z'});store.update(b.id,{lastActivityAt:'2026-02-01T00:00:00Z'});
  engine.orderProjects(['project:a','project:b'],0);store.reorder([a.id,b.id],0);
  assert.throws(()=>engine.setSort('recent',0,1),{status:409});assert.equal(store.getMeta('projectOrder').length,2);
  engine.setSort('recent',1,1);assert.deepEqual(store.getMeta('projectOrder'),[]);assert.deepEqual(store.getMeta('queueOrder'),[]);assert.equal(engine.state().tasks[0].id,b.id);
  const s=engine.state();engine.setSort('oldest',s.projectOrderRevision,s.orderRevision);assert.equal(engine.state().tasks[0].id,a.id);
  assert.throws(()=>engine.setSort('unknown',2,2),/Choose/);store.close();
});
test('recency groups projects first and ignores cache, observation and priority bookkeeping',()=>{
  const {store,engine}=fixture();const a1=engine.capture({title:'A old',projectId:'a'}),b=engine.capture({title:'B middle',projectId:'b'}),a2=engine.capture({title:'A new',projectId:'a'});
  for(const [t,date] of [[a1,'2026-01-01'],[b,'2026-02-01'],[a2,'2026-03-01']])store.update(t.id,{lastActivityAt:date});
  assert.deepEqual(engine.state().tasks.map(t=>t.id),[a2.id,a1.id,b.id]);
  store.update(b.id,{priority:'critical',cachedBrief:{key:'cache'},sourceObservedAt:new Date().toISOString()});assert.deepEqual(engine.state().tasks.map(t=>t.id),[a2.id,a1.id,b.id]);
  store.update(b.id,{messages:[{role:'user',text:'Follow up',at:new Date().toISOString()}]});assert.equal(engine.state().tasks[0].id,b.id);store.close();
});
test('import time does not replace known source activity time',()=>{
  assert.equal(activityTime({createdAt:'2026-03-01',sourceUpdatedAt:'2026-01-01'}),Date.parse('2026-01-01'));
  assert.equal(activityTime({lastActivityAt:'2026-01-01',messages:[{at:'2026-02-01'}]}),Date.parse('2026-02-01'));
});
test('presenting a result changes its label without clearing it; later results need review again',()=>{
  const {store,engine}=fixture(),task=engine.capture({title:'Review',projectId:'a'});store.update(task.id,{status:'review',turnId:'one',summary:'First result'});
  let t=engine.state().tasks[0];assert.equal(taskState(t).label,'Ready for review');engine.presented(t.id,t.attentionVersion);
  t=engine.state().tasks[0];assert.equal(taskState(t).label,'Next step');assert.equal(t.status,'review');
  const oldVersion=t.attentionVersion;store.update(t.id,{turnId:'two'});t=engine.state().tasks[0];assert.equal(taskState(t).label,'Ready for review');assert.throws(()=>engine.presented(t.id,oldVersion),{status:409});store.close();
});
test('state descriptions distinguish approvals, questions, runtime progress and unverifiable snapshots',()=>{
  for(const [task,label] of [[{status:'waiting',pending:[{kind:'approval'}]},'Approval needed'],[{status:'waiting'},'Needs your answer'],[{status:'running',external:true},'Working'],[{status:'review',external:true,sourceTurnStatus:'unknown'},'Saved snapshot'],[{status:'paused'},'Paused'],[{status:'error'},'Needs attention']]){assert.equal(taskState(task).label,label);assert.ok(taskState(task).detail.length>40);}
  assert.match(shortcutMarkup('rotation'),/Shift Command P/);assert.match(shortcutMarkup('rotation',false),/Control Shift P/);
});
