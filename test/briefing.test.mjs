import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {savedBrief} from '../lib/briefing.mjs';
const fixture=()=>{const store=new Store(':memory:'),transport=new EventEmitter();transport.stop=()=>{};const engine=new Engine(store,transport,process.cwd());const task=store.create({title:'Review complaint',brief:'Recover the disputed domain.'});return{engine,store,task};};
test('briefing immediately serves saved context while one durable, single-flight synthesis warms',async()=>{
  const {engine,store,task}=fixture();let finish,calls=0;engine.readOnlyJson=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const first=await engine.brief(task.id);assert.equal(first.saved,true);assert.match(first.body,/Recover the disputed domain/);await engine.brief(task.id);assert.equal(calls,1);const job=engine.briefJobs.get(task.id);finish({title:'A decision',context:'Recover the disputed domain.',update:'Evidence is ready.',decision:'What should happen next?',choices:[],missingDetails:false});await job;
  assert.equal((await engine.brief(task.id)).cached,true);assert.equal(store.get(task.id).cachedBrief.scene.title,'A decision');engine.close();
  const next=new Engine(store,new EventEmitter(),process.cwd());next.readOnlyJson=()=>{throw new Error('Must not synthesize again');};assert.equal((await next.brief(task.id)).title,'A decision');next.closing=true;store.close();
});
test('a newer question invalidates generated context and cannot be paraphrased by a stale briefing',async()=>{
  const {engine,store,task}=fixture();let finish;engine.readOnlyJson=()=>new Promise(resolve=>{finish=resolve;});await engine.brief(task.id);const job=engine.briefJobs.get(task.id);store.update(task.id,{status:'waiting',pending:[{id:'request-new',kind:'approval',question:'May I submit?',sourceOnly:true}]});finish({title:'Old result',body:'Stale',spoken:'Stale'});await job;
  const brief=await engine.brief(task.id);assert.match(brief.spoken,/May I submit/);assert.match(brief.spoken,/source app/);assert.equal(brief.needsReply,true);assert.equal(store.get(task.id).cachedBrief,undefined);engine.close();store.close();
});
test('fallback purpose never implies completion of the whole task',()=>{const scene=savedBrief({id:'a',title:'Task',status:'review',brief:'Original goal',pending:[],summary:'Raw tool dump'});assert.match(scene.body,/ready for your review/);assert.doesNotMatch(scene.body,/Raw tool dump/);});

test('a choice briefing carries every quoted alternative into visual and spoken output',async()=>{
 const {completeBrief,briefingSources}=await import('../lib/briefing.mjs');const task={id:'choice',title:'Choose a reply',brief:'Draft a reply.',pending:[],sourceHistory:[{role:'agent',text:'Short:\n“Keep it simple.”\nWarm:\n“Thanks, I would like that.”\nPlayful:\n“Make it a surprise.”'}]};const source=briefingSources(task).find(s=>s.role==='agent');
 const scene=completeBrief({title:'Choose a reply',context:'Draft a reply.',update:'Three drafts are ready.',decision:'Which one sounds like you?',missingDetails:false,choices:[{label:'Short',quote:'Keep it simple.',sourceId:source.id},{label:'Warm',quote:'Thanks, I would like that.',sourceId:source.id},{label:'Playful',quote:'Make it a surprise.',sourceId:source.id}]},task);
 for(const text of ['Keep it simple.','Thanks, I would like that.','Make it a surprise.']){assert.ok(scene.choices.some(c=>c.quote===text));assert.ok(scene.spoken.includes(text));assert.ok(scene.resumeSpoken.includes(text));}assert.doesNotMatch(scene.resumeBody,/Draft a reply/);
 assert.throws(()=>completeBrief({title:'Wrong',context:'',update:'',decision:'Choose',choices:[{label:'Invented',quote:'Not in the source.',sourceId:source.id}]},task),/ungrounded/);
});
test('saved and incomplete model briefings show source alternatives instead of a blind choice',async()=>{
 const {completeBrief}=await import('../lib/briefing.mjs');const task={id:'a',title:'Pick a tone',brief:'Draft a reply',pending:[],sourceHistory:[{role:'agent',text:'Short:\n“Keep it simple.”\nWarm:\n“Thanks, I would like that.”'}]};
 const fallback=savedBrief(task);assert.match(fallback.choiceExcerpt,/Keep it simple/);assert.match(fallback.spoken,/Thanks, I would like that/);
 const incomplete=completeBrief({title:'Pick',context:'Draft',update:'Drafts ready',decision:'Choose one.',choices:[],missingDetails:false},task);assert.match(incomplete.choiceExcerpt,/Keep it simple/);
});
test('prefetch does not mark a briefing heard and visible exposure persists across restart',async()=>{
 const {engine,store,task}=fixture();engine.readOnlyJson=async()=>({title:'Task',context:'Goal',update:'No new result.',decision:'What next?',choices:[],missingDetails:false});await engine.brief(task.id);await engine.briefJobs.get(task.id);assert.equal(store.get(task.id).briefedAt,undefined);engine.presented(task.id);assert.ok(store.get(task.id).briefedAt);assert.equal(store.get(task.id).status,'queued');engine.close();store.close();
});
test('a changed displayed briefing cannot reinterpret an answer against new choices',async()=>{
 const {engine,store,task}=fixture();store.update(task.id,{cachedBrief:{key:'new',scene:{choices:[]}}});await assert.rejects(engine.conductor('The second one.',{taskId:task.id,requestId:null,briefKey:'old'}),/briefing changed/);engine.close();store.close();
});

test('missing choice details never produce a blind choose-one request',async()=>{
 const {completeBrief}=await import('../lib/briefing.mjs');const task={id:'a',title:'Decide',brief:'Review drafts.',statusText:'Choose a version.',pending:[],sourceHistory:[]};const fallback=savedBrief(task);assert.equal(fallback.needsSource,true);assert.match(fallback.body,/options are not captured/);const generated=completeBrief({title:'Decide',context:'Review drafts.',update:'A decision remains.',decision:'Choose one.',choices:[],missingDetails:false},task);assert.equal(generated.needsSource,true);assert.doesNotMatch(generated.body,/Choose one/);
});

test('a requested briefing waits for a synthesis slot and warms automatically instead of being dropped',async()=>{
 const {engine,store,task}=fixture();const b=store.create({title:'Second'}),c=store.create({title:'Focused third'}),finish=new Map();engine.readOnlyJson=(_instructions,data)=>new Promise(resolve=>finish.set(data.task.title,()=>resolve({title:data.task.title,context:'Goal',update:'Update',decision:'What next?',choices:[],missingDetails:false})));
 await engine.brief(task.id);await engine.brief(b.id);await engine.brief(c.id);assert.equal(engine.briefJobs.size,2);assert.ok(engine.briefQueue.has(c.id));const first=engine.briefJobs.get(task.id);finish.get(task.title)();await first;await Promise.resolve();assert.ok(engine.briefJobs.has(c.id));const rest=[...engine.briefJobs.values()];finish.get(b.title)();finish.get(c.title)();await Promise.all(rest);assert.ok(store.get(c.id).cachedBrief);engine.close();store.close();
});

test('even an unprepared repeat briefing uses a short status rather than replaying the goal',async()=>{const {taskBrief}=await import('../public/flow.js');const task={id:'a',title:'A task',brief:'The entire original background.',status:'queued',pending:[],briefedAt:'2026-11-02'};const scene=taskBrief(savedBrief(task),task);assert.match(scene.spoken,/ready for your next instruction/);assert.doesNotMatch(scene.spoken,/entire original background/);});
