import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {validateShortcut,shortcutEvent,matchesShortcut,shortcutLabel,transitionDecision} from '../public/interaction.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Transport extends EventEmitter {
  constructor(){super();this.turns=0;this.interrupts=[];this.replies=[];this.next=0;}
  async start(){}stop(){}send(value){this.replies.push(value);}reply(id,result){this.replies.push({id,result});}
  async call(method,p){
    if(method==='account/read')return{account:{type:'chatgpt'}};
    if(method==='thread/start'){if(this.openGate)await this.openGate;return{thread:{id:'thread-'+(++this.next),status:{type:'idle'}}};}
    if(method==='thread/resume')return{thread:{id:p.threadId,status:{type:'idle'}}};
    if(method==='turn/start'){this.turns++;if(this.turnGate)await this.turnGate;return{turn:{id:'turn-'+this.turns}};}
    if(method==='turn/interrupt'){this.interrupts.push(p);this.emit('notification',{method:'turn/completed',params:{threadId:p.threadId,turn:{status:'interrupted'}}});return{};}
    return{};
  }
}
function fixture(){const store=new Store(':memory:'),transport=new Transport(),engine=new Engine(store,transport,process.cwd());return{store,transport,engine};}
test('dictation shortcuts recognize the first Fn press and preserve normal typing',()=>{
  const fn=validateShortcut({code:'Fn',modifiers:[]});assert.equal(shortcutLabel(fn),'Fn / Globe');assert.equal(matchesShortcut(fn,shortcutEvent({code:'Fn',pressed:true})),true);assert.equal(matchesShortcut(fn,shortcutEvent({code:'Fn',pressed:false})),false);
  assert.equal(shortcutEvent({code:'KeyA',repeat:true}),null);assert.throws(()=>validateShortcut({code:'KeyA',modifiers:[]}),/ordinary typing/);
  const chord=validateShortcut({code:'Space',modifiers:['shift','meta']});assert.ok(matchesShortcut(chord,shortcutEvent({code:'Space',metaKey:true,shiftKey:true,type:'keydown'})));assert.ok(!matchesShortcut(chord,shortcutEvent({code:'Space',metaKey:true,type:'keydown'})));
  assert.deepEqual(validateShortcut({code:'MetaRight',modifiers:['meta']}),{code:'MetaRight',modifiers:[]});assert.equal(validateShortcut(null),null);
});
test('new work stays in focus, explicit next moves, and an ambiguous response asks',()=>{
  const capture={actions:[{tool:'lounge_capture',taskId:'new'}],instruction:'Start a new task.',activeTaskIds:['new']};
  assert.equal(transitionDecision({transition:'next',advance:true},capture),'stay');
  assert.equal(transitionDecision({transition:'next'},{...capture,instruction:'Send this and move on.'}),'next');
  assert.equal(transitionDecision({transition:'next'},{...capture,instruction:'Do not move on.'}),'stay');
  assert.equal(transitionDecision({transition:'next',advance:true},{instruction:'Here is my thought.'}),'ask');
  assert.equal(transitionDecision({transition:'next'},{actions:[{tool:'lounge_send',taskId:'worker'}],activeTaskIds:['worker']}),'next');
  assert.equal(transitionDecision({transition:'next',needsReply:true},{actions:[{tool:'lounge_send',taskId:'worker'}],activeTaskIds:['worker']}),'stay');
  assert.equal(transitionDecision({transition:'next'},{actions:[{tool:'lounge_confirm_plan'}]}),'stay');
});
test('a stop received before submission prevents any provider work',async()=>{
  const {store,transport,engine}=fixture();await engine.cancelConductor('submission-before');await assert.rejects(engine.conductor('Accidental transcript',{submissionId:'submission-before'}),/stopped before/);assert.equal(transport.turns,0);assert.equal(store.all().length,0);engine.close();store.close();
});
test('stop during provider startup prevents starting a turn',async()=>{
  const {store,transport,engine}=fixture();let open;transport.openGate=new Promise(resolve=>open=resolve);
  const submitting=engine.conductor('Accidental transcript',{submissionId:'submission-opening'});await tick();const stopping=engine.cancelConductor('submission-opening');open();await submitting;const result=await stopping;
  assert.equal(result.status,'paused');assert.equal(transport.turns,0);assert.equal(engine.live.size,0);assert.equal(store.all()[0].status,'paused');engine.close();store.close();
});
test('stopping the coordinator leaves separately dispatched workers running',async()=>{
  const {store,transport,engine}=fixture(),worker=store.create({title:'Independent worker'});store.update(worker.id,{status:'running',threadId:'worker-thread',turnId:'worker-turn',runtimeProvider:'codex'});engine.live.set('codex:worker-thread',worker.id);
  await engine.conductor('Route this thought',{submissionId:'submission-only-coordinator'});await engine.cancelConductor('submission-only-coordinator');assert.equal(store.get(worker.id).status,'running');assert.equal(engine.live.get('codex:worker-thread'),worker.id);assert.ok(transport.interrupts.every(p=>p.threadId!=='worker-thread'));engine.close();store.close();
});
test('stop during turn admission waits for its identity, blocks tools and interrupts that turn',async()=>{
  const {store,transport,engine}=fixture();let admit;transport.turnGate=new Promise(resolve=>admit=resolve);
  const submitting=engine.conductor('Accidental transcript',{submissionId:'submission-admitting'});await tick();const stopping=engine.cancelConductor('submission-admitting');
  await engine.request({providerId:'codex',sessionId:'thread-1',kind:'tool',id:1,tool:'lounge_capture',args:{title:'Must not exist',brief:'No',projectId:'inbox',priority:'normal'}});
  assert.equal(store.all().filter(t=>!t.isConductor).length,0);assert.match(JSON.stringify(transport.replies.at(-1)),/stopped/);
  admit();await submitting;const result=await stopping;assert.equal(result.status,'paused');assert.equal(transport.interrupts.length,1);assert.equal(transport.interrupts[0].turnId,'turn-1');
  transport.turnGate=null;await engine.conductor('A deliberate new thought',{submissionId:'submission-new-turn'});await engine.cancelConductor('submission-admitting');assert.equal(transport.interrupts.length,1);assert.equal(store.all()[0].status,'running');engine.close();store.close();
});
function plannedFixture(){const f=fixture();f.store.setMeta('projects',[...f.store.getMeta('projects'),{id:'a',name:'Atlas',path:process.cwd()},{id:'b',name:'Fieldnotes',path:process.cwd()}]);const owner=f.store.create({title:'Coordinator'});f.store.update(owner.id,{isConductor:true,status:'review'});return{...f,owner};}
const proposal=(overrides={})=>({summary:'Split the work into two projects.',items:[{title:'Review launch',brief:'Decide the launch scope.',projectId:'a',projectName:'Atlas',priority:'high',projectPosition:1,position:1},{title:'Compare interviews',brief:'Compare the themes.',projectId:'b',projectName:'Fieldnotes',priority:'normal',projectPosition:2,position:1}],...overrides});
test('task plans create nothing before approval and add the displayed order atomically once',()=>{
  const {store,engine,owner}=plannedFixture();const old=engine.capture({title:'Existing task',projectId:'a'}),plan=engine.taskPlans.preview(proposal(),'first-run');store.update(owner.id,{taskPlan:plan});
  assert.equal(store.all().filter(t=>!t.isConductor).length,1);assert.throws(()=>engine.taskPlans.confirm(plan.id,{runId:'first-run'}),/later user confirmation/);
  const added=engine.taskPlans.confirm(plan.id,{runId:'later-run'});assert.equal(added.createdIds.length,2);assert.deepEqual(engine.state().tasks.filter(t=>!t.isConductor).map(t=>t.title),['Review launch','Existing task','Compare interviews']);
  assert.equal(store.get(added.createdIds[0]).priority,'high');assert.equal(store.get(added.createdIds[0]).status,'queued');assert.equal(store.get(old.id).status,'queued');assert.equal(engine.live.size,0);
  assert.deepEqual(engine.taskPlans.confirm(plan.id,{direct:true}).createdIds,added.createdIds);assert.equal(store.all().filter(t=>!t.isConductor).length,3);engine.close();store.close();
});
test('unassigned logical projects stay grouped and cannot start until a workspace is chosen',async()=>{
  const {store,engine,owner}=plannedFixture();const input=proposal({items:[{title:'First',brief:'First action',projectId:'',projectName:'New personal idea',personal:true,priority:'normal',projectPosition:1,position:1},{title:'Second',brief:'Second action',projectId:'',projectName:'New personal idea',personal:true,priority:'low',projectPosition:1,position:2}]});
  const plan=engine.taskPlans.preview(input,'first');store.update(owner.id,{taskPlan:plan});const added=engine.taskPlans.confirm(plan.id,{direct:true}),tasks=engine.state().tasks.filter(t=>!t.isConductor);
  assert.equal(tasks[0].projectKey,tasks[1].projectKey);assert.equal(tasks[0].projectName,'New personal idea');assert.ok(tasks.every(t=>t.isPersonal));await assert.rejects(engine.dispatch(added.createdIds[0]),/workspace/);engine.close();store.close();
});
test('a changed queue requires a fresh plan instead of overwriting newer choices',()=>{
  const {store,engine,owner}=plannedFixture(),plan=engine.taskPlans.preview(proposal(),'first');store.update(owner.id,{taskPlan:plan});engine.capture({title:'Added meanwhile'});assert.throws(()=>engine.taskPlans.confirm(plan.id,{direct:true}),{status:409});assert.equal(store.all().filter(t=>!t.isConductor).length,1);engine.close();store.close();
});
test('a partial task-plan failure rolls back tasks, order and approval state',()=>{
  const {store,engine,owner}=plannedFixture(),plan=engine.taskPlans.preview(proposal(),'first');store.update(owner.id,{taskPlan:plan});const create=store.create.bind(store);let count=0;store.create=input=>{if(++count===2)throw new Error('Synthetic write failure');return create(input);};
  assert.throws(()=>engine.taskPlans.confirm(plan.id,{direct:true}),/Synthetic write failure/);assert.equal(store.all().filter(t=>!t.isConductor).length,0);assert.equal(store.get(owner.id).taskPlan.status,'proposed');assert.deepEqual(store.getMeta('queueOrder',[]),[]);engine.close();store.close();
});
test('voice plan confirmation uses the displayed plan and requires a later exchange',async()=>{
  const {store,transport,engine,owner}=plannedFixture();store.update(owner.id,{threadId:'control',status:'running',routingContext:{runId:'preview-run',actions:[]}});engine.live.set('codex:control',owner.id);
  const call=async(tool,args)=>{await engine.request({providerId:'codex',sessionId:'control',kind:'tool',wireId:1,id:'1',tool,args});return transport.replies.at(-1).result;};
  const preview=await call('lounge_plan_tasks',proposal());assert.equal(preview.success,true);const plan=JSON.parse(preview.contentItems[0].text);
  assert.equal((await call('lounge_confirm_plan',{planId:plan.id})).success,false);assert.equal(store.all().filter(t=>!t.isConductor).length,0);
  store.update(owner.id,{routingContext:{runId:'approval-run',userInstruction:'Yes, add those tasks.',actions:[]}});assert.equal((await call('lounge_confirm_plan',{planId:plan.id})).success,true);assert.equal(store.all().filter(t=>!t.isConductor).length,2);engine.close();store.close();
});
test('repeating a queued task in a proposed plan creates no duplicates',()=>{
  const {store,engine}=plannedFixture();engine.capture({title:'Review launch',projectId:'a'});assert.throws(()=>engine.taskPlans.preview(proposal(),'first'),/already queued/);assert.equal(store.all().filter(t=>!t.isConductor).length,1);engine.close();store.close();
});
test('plan placement preserves existing hidden project and chat slots',()=>{
  const {store,engine}=plannedFixture(),a=engine.capture({title:'A first',projectId:'a'}),hidden=engine.capture({title:'A hidden',projectId:'a',personal:true}),a2=engine.capture({title:'A next',projectId:'a'}),snoozed=engine.capture({title:'Snoozed standalone'}),b=engine.capture({title:'B',projectId:'b'});
  engine.defer(snoozed.id,168);store.reorder([a.id,hidden.id,a2.id,snoozed.id,b.id],0);store.setMeta('projectOrder',['project:a',`task:${snoozed.id}`,'project:b']);engine.setRotation('work');
  const input=proposal({items:[{title:'A proposed first',brief:'New action',projectId:'a',projectName:'Atlas',priority:'high',projectPosition:1,position:1}]});const plan=engine.taskPlans.preview(input,'first');
  assert.deepEqual(plan.projectOrder,['project:a',`task:${snoozed.id}`,'project:b']);assert.deepEqual(plan.chatOrders['project:a'],['proposal-1',a.id,hidden.id,a2.id]);engine.close();store.close();
});
