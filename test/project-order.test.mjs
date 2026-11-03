import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {projectGroups,mergeProjectOrder} from '../public/rotation.js';
import {pickNext,fingerprint} from '../public/flow.js';
class FakeCodex extends EventEmitter {async start(){}stop(){}}
function fixture(path=':memory:'){
  const store=new Store(path),codex=new FakeCodex(),engine=new Engine(store,codex,process.cwd());
  store.setMeta('projects',[...store.getMeta('projects').filter(p=>!['a','b'].includes(p.id)),{id:'a',name:'Project A',path:process.cwd()},{id:'b',name:'Project B',path:process.cwd()}]);
  return {store,codex,engine};
}
test('project priority contains the whole project before another project’s chat urgency',()=>{
  const {store,engine}=fixture(),a1=engine.capture({title:'A first',projectId:'a'}),b=engine.capture({title:'B urgent',projectId:'b',priority:'critical'}),a2=engine.capture({title:'A second',projectId:'a'});
  engine.orderProjects(['project:a','project:b'],0);
  assert.deepEqual(engine.state().tasks.map(t=>t.id),[a1.id,a2.id,b.id]);
  const seen={[a1.id]:fingerprint(store.get(a1.id))};assert.equal(pickNext(engine.state().tasks,seen).id,a2.id);
  store.update(a2.id,{status:'running'});assert.equal(pickNext(engine.state().tasks,seen).id,b.id);
  store.update(a1.id,{status:'review',summary:'A new result'});assert.equal(pickNext(engine.state().tasks,seen).id,a1.id);store.close();
});
test('automatic project ranking uses visible urgency while manual chat order stays inside its project',()=>{
  const {store,engine}=fixture(),a=engine.capture({title:'A low',projectId:'a',priority:'low'}),hidden=engine.capture({title:'A personal',projectId:'a',priority:'critical'}),b=engine.capture({title:'B high',projectId:'b',priority:'high'});
  engine.classify(hidden.id,true,'task');engine.setRotation('work');
  assert.deepEqual(projectGroups(engine.state().tasks,{mode:'work'}).map(g=>g.key),['project:b','project:a']);
  store.reorder([a.id,b.id,hidden.id],0);assert.equal(pickNext(engine.state().tasks,{},'work').id,b.id);
  engine.setRotation('all');assert.equal(pickNext(engine.state().tasks).projectKey,'project:a');store.close();
});
test('project reorder preserves filtered and snoozed project positions and rejects stale lists',()=>{
  const tasks=[{id:'a',projectKey:'a',status:'review'},{id:'p',projectKey:'p',status:'review',isPersonal:true},{id:'s',projectKey:'s',status:'snoozed'},{id:'b',projectKey:'b',status:'review'}];
  assert.deepEqual(mergeProjectOrder(tasks,['b','a'],{mode:'work',projectOrder:['a','p','s','b']}),['b','p','s','a']);
  assert.throws(()=>mergeProjectOrder(tasks,['b'],{mode:'work'}),{status:409});
  const {store,engine}=fixture();engine.capture({title:'A',projectId:'a'});engine.capture({title:'B',projectId:'b'});
  engine.orderProjects(['project:b','project:a'],0);assert.throws(()=>engine.orderProjects(['project:a','project:b'],0),{status:409});
  assert.throws(()=>engine.orderProjects(['project:a','project:a'],1),{status:409});store.close();
});
test('chat reordering preserves hidden chat slots and cannot move a chat between projects',()=>{
  const {store,engine}=fixture(),a1=engine.capture({title:'A first',projectId:'a'}),p=engine.capture({title:'A hidden',projectId:'a'}),a2=engine.capture({title:'A second',projectId:'a'}),b=engine.capture({title:'B',projectId:'b'});
  engine.classify(p.id,true,'task');store.reorder([a1.id,p.id,a2.id,b.id],0);engine.setRotation('work');
  engine.orderChats('project:a',[a2.id,a1.id],1);assert.deepEqual(store.getMeta('queueOrder'),[a2.id,p.id,a1.id,b.id]);
  assert.throws(()=>engine.orderChats('project:a',[b.id,a1.id],2),{status:409});
  assert.equal(store.get(b.id).projectId,'b');assert.throws(()=>engine.orderChats('project:a',[a1.id,a2.id],1),{status:409});store.close();
});
test('project priorities and child order survive a restart; old flat order migrates once',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lounge-project-order-')),path=join(dir,'queue.sqlite');let f=fixture(path);
  const a=f.engine.capture({title:'A',projectId:'a'}),b1=f.engine.capture({title:'B one',projectId:'b'}),b2=f.engine.capture({title:'B two',projectId:'b'});
  f.store.reorder([b2.id,a.id,b1.id],0);f.store.setMeta('projectOrder',null);f.store.close();
  f=fixture(path);assert.deepEqual(f.engine.state().projectOrder,['project:b','project:a']);assert.deepEqual(f.engine.state().tasks.map(t=>t.id),[b2.id,b1.id,a.id]);
  f.engine.orderProjects(['project:a','project:b'],0);f.store.close();f=fixture(path);assert.deepEqual(f.engine.state().tasks.map(t=>t.id),[a.id,b2.id,b1.id]);f.store.close();rmSync(dir,{recursive:true});
});
test('explicit automatic ordering resets project and child overrides independently',()=>{
  const {store,engine}=fixture(),a1=engine.capture({title:'A normal',projectId:'a'}),a2=engine.capture({title:'A urgent',projectId:'a',priority:'high'}),b=engine.capture({title:'B',projectId:'b',priority:'critical'});
  engine.orderProjects(['project:a','project:b'],0);engine.orderChats('project:a',[a1.id,a2.id],0);
  assert.deepEqual(engine.state().tasks.map(t=>t.id),[a1.id,a2.id,b.id]);engine.orderChats('project:a',[],1);assert.equal(engine.state().tasks[0].id,a2.id);
  engine.orderProjects([],1);assert.equal(engine.state().tasks[0].id,b.id);store.close();
});
test('project and chat ordering tools expose the same queue hierarchy and optimistic revisions',async()=>{
  const {store,engine,codex}=fixture(),a1=engine.capture({title:'A first',projectId:'a'}),a2=engine.capture({title:'A second',projectId:'a'}),b=engine.capture({title:'B',projectId:'b'}),c=store.create({title:'Conductor'});
  store.update(c.id,{isConductor:true,threadId:'conductor-thread'});engine.live.set('codex:conductor-thread',c.id);const replies=[];codex.reply=(id,result)=>replies.push(result);
  const call=async(tool,args)=>{await engine.request({id:1,method:'item/tool/call',params:{threadId:'conductor-thread',tool,arguments:args}});assert.equal(replies.at(-1).success,true);return JSON.parse(replies.at(-1).contentItems[0].text);};
  const q=await call('lounge_queue',{});assert.equal(q.queueProjects.length,2);
  await call('lounge_order_projects',{keys:['project:b','project:a'],revision:q.projectOrderRevision});await call('lounge_order_chats',{projectKey:'project:a',ids:[a2.id,a1.id],revision:q.orderRevision});
  assert.deepEqual((await call('lounge_queue',{})).tasks.map(t=>t.id),[b.id,a2.id,a1.id]);store.close();
});
