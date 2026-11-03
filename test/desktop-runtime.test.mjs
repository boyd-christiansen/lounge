import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../lib/adapters/desktop.mjs';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {Providers} from '../lib/providers.mjs';
import {acquireInstance} from '../lib/instance.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const url='https://claude.ai/chat/existing-source';
function fixture({question=false,approval=false,sourceOnly=false}={}){
  const native=new EventEmitter();native.host={enabled:true};native.status=async()=>({available:true,accessibility:true});native.call=async(method,args)=>({enabled:args?.enabled});native.close=()=>{};
  const calls=[];let view={url,messages:[{role:'agent',text:'Earlier result',signature:'earlier'}],latest:{role:'agent',text:'Earlier result',signature:'earlier'},running:false,controls:[],snapshot:{windowTitle:'Exact source title'},artifacts:[]};
  const driver={status:async()=>({accessibility:true,ready:true}),inspect:async()=>view,open:async source=>{assert.equal(source.url,url);return view;},
    async send(text,options){calls.push({text,options});
      view={...view,latest:{role:'agent',text:question&&calls.length===1?'Which format?':'Verified source result.',signature:question&&calls.length===1?'question':'final'},approval:approval&&calls.length===1?{signature:'approval',text:'Allow this one action?',sourceOnly}:null};
      return{view,conversation:url,delivery:'observed'};
    },async approve(source,fingerprint,decision){assert.equal(fingerprint,view.approval.signature);calls.push({decision});view={...view,approval:null};},
    async interrupt(){calls.push({interrupted:true});view={...view,running:false};},
    create:async()=>{throw new Error('Desktop creation is forbidden');}
  };
  const adapter=new DesktopAdapter(native,driver,{configured:true,pollInterval:5});
  const store=new Store(':memory:'),providers=new Providers([adapter]),engine=new Engine(store,null,process.cwd(),{providers});
  const task=engine.capture({title:'Exact source title',application:'claude-cowork',sourceUrl:url});store.update(task.id,{external:true,threadId:'existing-source',sourceTitle:'Exact source title'});
  return{native,driver,adapter,store,providers,engine,task,calls,setView:patch=>{view={...view,...patch};}};
}
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Expected desktop state did not arrive');}
test('new conversations cannot select the desktop adapter as their worker provider',async()=>{
  const f=fixture();await f.adapter.connect();
  await assert.rejects(f.engine.setInference({scope:'workers',model:'desktop/default',effort:null}),/agent-server or SDK/);
  await assert.rejects(f.adapter.openSession({}),/New conversations/);
  assert.equal(f.engine.capture({title:'New obligation'}).application,'codex');assert.equal(f.calls.length,0);f.engine.close();f.store.close();
});
test('an existing source runs in its original app and retains source identity through completion',async()=>{
  const f=fixture();await f.adapter.connect();await f.engine.dispatch(f.task.id,'Continue the existing work.');
  await until(()=>f.store.get(f.task.id).status==='review');const task=f.store.get(f.task.id);
  assert.equal(task.threadId,'existing-source');assert.equal(task.sourceUrl,url);assert.equal(task.title,'Exact source title');assert.equal(task.external,true);assert.equal(task.runtimeProvider,'desktop');assert.ok(task.runtimeSessionId);
  assert.equal(task.summary,'Verified source result.');assert.equal(f.engine.state().tasks.find(t=>t.id===task.id).capabilities.bridged,true);assert.equal(f.calls[0].text,'Continue the existing work.');f.engine.close();f.store.close();
});
test('an existing app question receives the exact full reply without changing its source',async()=>{
  const f=fixture({question:true});await f.adapter.connect();await f.engine.dispatch(f.task.id,'Begin');
  await until(()=>f.store.get(f.task.id).status==='waiting');const request=f.store.get(f.task.id).pending[0];
  const answer='My complete answer, including the caveat.\nKeep the full appendix.';
  await f.engine.answer(f.task.id,request.id,{text:answer,answers:{reply:answer}});
  await until(()=>f.store.get(f.task.id).status==='review');assert.equal(f.calls[1].text,answer);assert.equal(f.calls[1].options.questionSignature,'question');assert.equal(f.store.get(f.task.id).threadId,'existing-source');f.engine.close();f.store.close();
});
test('source approvals require an explicit decision and disconnect pauses monitoring without clearing the task',async()=>{
  const f=fixture({approval:true});await f.adapter.connect();await f.engine.dispatch(f.task.id,'Continue');await until(()=>f.store.get(f.task.id).status==='waiting');
  const request=f.store.get(f.task.id).pending[0];assert.equal(request.kind,'approval');await assert.rejects(f.engine.answer(f.task.id,request.id,{text:'yes'}),/approval decision/);
  await f.engine.answer(f.task.id,request.id,{decision:'accept'});await until(()=>f.store.get(f.task.id).status==='review');assert.equal(f.calls[1].decision,'accept');
  f.setView({running:true,latest:{role:'agent',text:'Working',signature:'work'}});await f.engine.dispatch(f.task.id,'Continue again');await f.adapter.disconnect();assert.equal(f.store.get(f.task.id).status,'paused');assert.equal(f.store.get(f.task.id).pending.length,0);assert.equal(f.store.get(f.task.id).external,true);f.engine.close();f.store.close();
});
test('a second process cannot own the same durable queue lock',()=>{
  const root=mkdtempSync(join(tmpdir(),'lounge-lock-')),path=join(root,'queue.lock');
  const release=acquireInstance(path);assert.throws(()=>acquireInstance(path),/already owns/);release();const again=acquireInstance(path);again();rmSync(root,{recursive:true});
});
test('an answer made directly in Claude expires the old Lounge question',async()=>{
  const f=fixture({question:true});await f.adapter.connect();await f.engine.dispatch(f.task.id,'Continue');
  await until(()=>f.store.get(f.task.id).status==='waiting');const old=f.store.get(f.task.id).pending[0];
  f.setView({latest:{role:'agent',text:'Answered in the source app.',signature:'source-answer'}});
  await until(()=>f.store.get(f.task.id).status==='review');
  await assert.rejects(f.engine.answer(f.task.id,old.id,{answers:{reply:'A stale answer'}}),/expired/);
  assert.equal(f.calls.length,1);assert.equal(f.store.get(f.task.id).pending.length,0);f.engine.close();f.store.close();
});
test('observing an existing source surfaces its question without submitting a prompt',async()=>{
  const f=fixture();await f.adapter.connect();f.setView({latest:{role:'agent',text:'Which format?',signature:'existing-question'}});
  await f.engine.observeDesktopSource(f.task.id);await until(()=>f.store.get(f.task.id).status==='waiting');
  assert.equal(f.calls.length,0);assert.equal(f.store.get(f.task.id).pending[0].question,'Which format?');
  await f.engine.interrupt(f.task.id);await f.engine.refreshSource(f.task.id);
  assert.equal(f.store.get(f.task.id).pending.length,0);assert.equal(f.store.get(f.task.id).desktopMonitoringPaused,true);f.engine.close();f.store.close();
});
test('restart releases an incomplete observation reservation and waits for explicit resume',async()=>{
  const f=fixture();f.store.update(f.task.id,{runtimeProvider:'desktop',observationReserved:true,status:'review'});
  const recovered=new Engine(f.store,null,process.cwd(),{providers:new Providers([f.adapter])});
  assert.equal(f.store.get(f.task.id).observationReserved,false);assert.equal(f.store.get(f.task.id).status,'paused');assert.equal(f.store.get(f.task.id).desktopMonitoringPaused,true);
  recovered.close();f.engine.close();f.store.close();
});
test('Chat and Cowork imports of the same consumer source remain one queue task',async()=>{
  const f=fixture();await f.adapter.connect();const imported=await f.engine.importThread('existing-source','claude-chat');
  assert.equal(imported.id,f.task.id);assert.equal(f.store.all().length,1);assert.equal(imported.application,'claude-cowork');f.engine.close();f.store.close();
});
test('source model controls are unavailable while the bridge is disconnected',async()=>{
  const f=fixture();await assert.rejects(f.adapter.sourceModels(f.task),/Connect the desktop bridge/);await assert.rejects(f.adapter.setSourceModel(f.task,{model:'x'}),/Connect the desktop bridge/);f.engine.close();f.store.close();
});
test('unrelated app-owned conversations can run in parallel without treating Inbox as their workspace',async()=>{
  const f=fixture();await f.adapter.connect();f.engine.reserve(f.task.id,'First authorized source');
  const other=f.engine.capture({title:'Other existing source',application:'claude-chat',sourceUrl:'https://claude.ai/chat/another-source'});
  f.store.update(other.id,{external:true,threadId:'another-source'});f.engine.reserve(other.id,'Second authorized source');
  const duplicate=f.engine.capture({title:'Duplicate source',application:'claude-chat',sourceUrl:url});f.store.update(duplicate.id,{external:true,threadId:'existing-source'});
  assert.throws(()=>f.engine.reserve(duplicate.id,'Duplicate turn'),/source already has an active/);f.engine.close();f.store.close();
});
test('a persistent or ambiguous native grant requires source handling and resolves when handled there',async()=>{
  const f=fixture({approval:true,sourceOnly:true});await f.adapter.connect();await f.engine.dispatch(f.task.id,'Continue');await until(()=>f.store.get(f.task.id).status==='waiting');
  const request=f.store.get(f.task.id).pending[0];assert.equal(request.sourceOnly,true);assert.equal(f.engine.state().tasks.find(t=>t.id===f.task.id).capabilities.answer,false);
  await assert.rejects(f.engine.answer(f.task.id,request.id,{decision:'accept'}),/source app/);assert.equal(f.calls.length,1);
  f.setView({approval:null,latest:{role:'agent',text:'Handled in Claude.',signature:'handled'}});await until(()=>f.store.get(f.task.id).status==='review');assert.equal(f.calls.length,1);assert.equal(f.store.get(f.task.id).pending.length,0);f.engine.close();f.store.close();
});
test('source model reads reserve control before awaiting the app and block duplicate-source dispatch',async()=>{
  const f=fixture();await f.adapter.connect();let finish;f.driver.modelOptions=()=>new Promise(resolve=>{finish=resolve;});
  const reading=f.engine.sourceModels(f.task.id);assert.equal(f.store.get(f.task.id).sourceControlReserved,true);assert.throws(()=>f.engine.reserve(f.task.id,'A concurrent prompt'),/model controls are busy/);
  const other=f.engine.capture({title:'Duplicate',application:'claude-chat',sourceUrl:url});f.store.update(other.id,{external:true,threadId:'existing-source'});assert.throws(()=>f.engine.reserve(other.id,'Another concurrent prompt'),/model controls are busy/);
  finish({models:[],efforts:[]});await reading;assert.equal(f.store.get(f.task.id).sourceControlReserved,false);assert.equal(f.calls.length,0);f.engine.close();f.store.close();
});
test('recovery observes a paused source without resending its old brief',async()=>{
  const f=fixture();await f.adapter.connect();f.store.update(f.task.id,{status:'paused',desktopMonitoringPaused:true,brief:'Never resend this old goal.'});
  await assert.rejects(f.engine.dispatch(f.task.id),/old brief is never resent/);await f.engine.resumeSource(f.task.id);await until(()=>f.store.get(f.task.id).status==='review');
  assert.equal(f.calls.length,0);assert.equal(f.store.get(f.task.id).threadId,'existing-source');f.engine.close();f.store.close();
});
test('an unseen source question blocks a new message until monitoring presents it',async()=>{
  const f=fixture();await f.adapter.connect();f.setView({latest:{role:'agent',text:'A new unseen question?',signature:'unseen'}});await f.engine.dispatch(f.task.id,'An unrelated old reply');await until(()=>f.store.get(f.task.id).status==='error');
  assert.equal(f.calls.length,0);assert.match(f.store.get(f.task.id).lastError,/new question/);await f.engine.resumeSource(f.task.id);await until(()=>f.store.get(f.task.id).status==='waiting');assert.equal(f.store.get(f.task.id).pending[0].question,'A new unseen question?');f.engine.close();f.store.close();
});
