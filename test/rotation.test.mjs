import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { rotationTasks, projectIdentity, mergeRotationOrder } from '../public/rotation.js';
import { pickNext, fingerprint } from '../public/flow.js';
class FakeCodex extends EventEmitter { async start(){} stop(){} }
function fixture(path=':memory:') { const store=new Store(path), codex=new FakeCodex(),engine=new Engine(store,codex,process.cwd());return {store,engine,codex}; }

test('project classification groups imported chats without marking unrelated Inbox work personal',()=>{
 const {store,engine}=fixture();
 const a=engine.capture({title:'A'}),b=engine.capture({title:'B'}),c=engine.capture({title:'Unrelated'});
 store.update(a.id,{external:true,sourceProjectName:'Hobby'});store.update(b.id,{external:true,sourceProjectName:'Hobby'});
 engine.classify(a.id,true,'project');
 const byId=Object.fromEntries(engine.state().tasks.map(t=>[t.id,t]));
 assert.equal(byId[a.id].isPersonal,true);assert.equal(byId[b.id].isPersonal,true);assert.equal(byId[c.id].isPersonal,false);
 assert.equal(store.get(a.id).status,'queued');assert.equal(store.get(b.id).external,true);
 engine.classify(b.id,false,'task');assert.equal(engine.state().tasks.find(t=>t.id===b.id).isPersonal,false);
 assert.notEqual(projectIdentity(c).key,projectIdentity(a).key);store.close();
});
test('rotation filters are consistent for the drawer and next-task selection, including waiting/running work',()=>{
 const tasks=[{id:'p',isPersonal:true,status:'waiting',pending:[{id:'q'}]},{id:'w',isPersonal:false,status:'review',pending:[]},{id:'s',status:'snoozed'},{id:'r',status:'running'},{id:'d',status:'done'}];
 assert.deepEqual(rotationTasks(tasks,'work').map(t=>t.id),['w','r']);assert.equal(pickNext(tasks,{},'work').id,'w');
 assert.deepEqual(rotationTasks(tasks,'personal').map(t=>t.id),['p']);assert.equal(pickNext(tasks,{},'personal').id,'p');
 assert.equal(pickNext(tasks).id,'p');
});
test('personal categories and the chosen rotation survive restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lounge-rotation-')),path=join(dir,'queue.sqlite');
 const first=fixture(path),task=first.engine.capture({title:'Personal task'});first.engine.classify(task.id,true,'project');first.engine.setRotation('work');first.store.close();
 const next=fixture(path);assert.equal(next.engine.state().rotationMode,'work');assert.equal(next.engine.state().tasks[0].isPersonal,true);assert.equal(next.store.get(task.id).status,'queued');next.store.close();rmSync(dir,{recursive:true});
});
test('snoozing for a week hides a task, preserves review state on re-snooze, and resurfaces an already-seen result',()=>{
 const {store,engine}=fixture(),task=engine.capture({title:'Review again'});store.update(task.id,{status:'review',summary:'Saved result'});
 const seen={[task.id]:fingerprint(store.get(task.id))},before=Date.now();
 engine.defer(task.id,168);const snoozed=store.get(task.id);
 assert.ok(Date.parse(snoozed.snoozedUntil)>=before+168*3600000);assert.equal(rotationTasks(engine.state().tasks).length,0);
 engine.defer(task.id,168);assert.equal(store.get(task.id).resumeStatus,'review');
 store.update(task.id,{snoozedUntil:'2020-01-01'});const returned=engine.state().tasks;
 assert.equal(returned[0].status,'review');assert.equal(returned[0].summary,'Saved result');assert.equal(pickNext(returned,seen).id,task.id);assert.equal(returned[0].resumeStatus,null);
 store.close();
});
test('snoozes persist, wake early without dispatching, and cannot discard active questions',()=>{
 const {store,engine}=fixture(),task=engine.capture({title:'Later'});engine.defer(task.id,168);engine.wake(task.id);
 assert.equal(store.get(task.id).status,'queued');assert.equal(store.get(task.id).snoozedUntil,null);
 store.update(task.id,{status:'waiting',pending:[{id:'question',kind:'question'}]});assert.throws(()=>engine.defer(task.id,168),/Active work/);
 assert.equal(store.get(task.id).pending.length,1);store.close();
});
test('reordering a filtered rotation preserves hidden tasks and their slots',()=>{
 const tasks=[{id:'a',status:'review'},{id:'hidden',status:'review',isPersonal:true},{id:'b',status:'review'},{id:'snoozed',status:'snoozed'}];
 assert.deepEqual(mergeRotationOrder(tasks,['b','a'],'work'),['b','hidden','a','snoozed']);
 assert.throws(()=>mergeRotationOrder(tasks,['a','hidden','b'],'work'),{status:409});
});
test('conductor queue tools can classify, filter, snooze, and wake the referenced task',async()=>{
 const {store,engine,codex}=fixture(),task=engine.capture({title:'Project task'}),conductor=store.create({title:'Conductor'});
 store.update(conductor.id,{isConductor:true,threadId:'conductor-thread'});engine.live.set('codex:conductor-thread',conductor.id);
 const replies=[];codex.reply=(id,result)=>replies.push(result);
 const call=async(tool,args)=>{await engine.request({id:1,method:'item/tool/call',params:{threadId:'conductor-thread',tool,arguments:args}});const result=replies.at(-1);assert.equal(result.success,true);return JSON.parse(result.contentItems[0].text);};
 await call('lounge_classify',{taskId:task.id,personal:true,scope:'project'});await call('lounge_rotation',{mode:'work'});
 assert.equal((await call('lounge_queue',{})).tasks.length,0);assert.equal((await call('lounge_queue',{includeHidden:true})).tasks.length,1);
 await call('lounge_defer',{taskId:task.id,hours:168});assert.equal(store.get(task.id).status,'snoozed');
 await call('lounge_wake',{taskId:task.id});assert.equal(store.get(task.id).status,'queued');assert.equal(engine.state().tasks.find(t=>t.id===task.id).isPersonal,true);
 assert.throws(()=>engine.setRotation('invalid'),/Choose all/);assert.throws(()=>engine.classify(task.id,'yes','project'),/classification/);store.close();
});

test('a week-long snooze survives process restart without entering the queue early',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lounge-snooze-')),path=join(dir,'queue.sqlite');
 const first=fixture(path),task=first.engine.capture({title:'Return next week'});first.store.update(task.id,{status:'review',summary:'Keep the review result'});
 first.engine.defer(task.id,168);const until=first.store.get(task.id).snoozedUntil;first.store.close();
 const next=fixture(path);assert.equal(next.store.get(task.id).snoozedUntil,until);assert.equal(next.store.get(task.id).status,'snoozed');assert.equal(pickNext(next.engine.state().tasks),null);
 next.engine.wake(task.id);assert.equal(next.store.get(task.id).status,'review');assert.equal(next.store.get(task.id).summary,'Keep the review result');next.store.close();rmSync(dir,{recursive:true});
});
