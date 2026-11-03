import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { DEFAULT_PROFILE, validateProfile } from '../lib/prompting.mjs';
import { fingerprint, pickNext, sourceUrl, isDictationCommit, assertDraftTarget, parseScene, queuePreview, renderMarkdown } from '../public/flow.js';

test('manual queue order is explicit, durable, and resettable', () => {
  const s = new Store(':memory:'), a = s.create({ title: 'Urgent', priority: 'high' }), b = s.create({ title: 'User moved this first', priority: 'low' });
  s.setMeta('settings',{sortMode:'priority'});
  s.reorder([b.id,a.id],0); assert.equal(s.snapshot()[0].id,b.id);
  assert.throws(()=>s.reorder([a.id,b.id],0),{status:409});
  assert.throws(()=>s.reorder([a.id,a.id],1),/Invalid queue order/);
  s.reorder([],1); assert.equal(s.snapshot()[0].id,a.id); s.close();
});
test('only a fresh task or changed result resurfaces within the current session', () => {
  const a={id:'a',status:'review',summary:'First result',pending:[]}, b={id:'b',status:'running',summary:'',pending:[]};
  assert.equal(pickNext([a,b]).id,'a');
  const seen={a:fingerprint(a)};assert.equal(pickNext([a,b],seen),null);
  assert.equal(pickNext([{...a,summary:'New result'},b],seen).id,'a');
  assert.equal(pickNext([{...a,status:'done'},{...b,status:'waiting',pending:[{id:'q'}]}],seen).id,'b');
});
test('completed dictation submits, ordinary typing and composition wait', () => {
  assert.equal(isDictationCommit({inputType:'insertFromPaste',insertedLength:60}),true);
  assert.equal(isDictationCommit({inputType:'insertText',insertedLength:90}),true);
  assert.equal(isDictationCommit({inputType:'insertText',insertedLength:1}),false);
  assert.equal(isDictationCommit({inputType:'insertText',insertedLength:3}),true);
  assert.equal(isDictationCommit({inputType:'insertReplacementText',insertedLength:12,manualKeyRecent:true}),false);
  assert.equal(isDictationCommit({inputType:'insertCompositionText',insertedLength:80,isComposing:true}),false);
  assert.equal(isDictationCommit({inputType:'deleteContentBackward',insertedLength:0}),false);
});
test('drafts cannot silently become an answer to a different question', () => {
  const binding={taskId:'a',requestId:'old'};
  assert.throws(()=>assertDraftTarget(binding,{id:'a',pending:[{id:'new'}]}),/question changed/);
  assert.throws(()=>assertDraftTarget(binding,{id:'b',pending:[{id:'old'}]}),/question changed/);
  assert.doesNotThrow(()=>assertDraftTarget(binding,{id:'a',pending:[{id:'old'}]}));
});
test('source handoff preserves the actual source application', () => {
  assert.equal(sourceUrl({threadId:'abc',provider:'codex'}),'codex://threads/abc');
  assert.equal(sourceUrl({threadId:'abc',sourceApp:'chatgpt'}),'https://chatgpt.com/c/abc');
  assert.equal(sourceUrl({threadId:'abc',provider:'claude',external:true}),'https://claude.ai/chat/abc');
  assert.equal(sourceUrl({}),null);
  assert.equal(sourceUrl({sourceUrl:'javascript:alert(1)'}),null);
});
test('personality and memory settings preserve other preferences and validate inputs', () => {
  const result=validateProfile({name:'Boyd',autoSend:false,memories:[' Keep the full thought. ']},DEFAULT_PROFILE);
  assert.equal(result.autoRead,true);assert.equal(result.autoSend,false);assert.deepEqual(result.memories,['Keep the full thought.']);
  assert.throws(()=>validateProfile({voiceRate:99}),/voice speed/);
  assert.throws(()=>validateProfile({memories:['a'.repeat(1001)]}),/short memories/);
});
test('a short spoken response remains visible when the model leaves its title blank', () => {
  const scene = parseScene(JSON.stringify({ title: '', body: 'Your queue is ready.', spoken: 'Your queue is ready.', needsReply: false, advance: false }));
  assert.equal(scene.title, 'Your queue is ready.'); assert.equal(scene.body, ''); assert.equal(scene.spoken, 'Your queue is ready.');
});
test('queue previews describe the thread and current state instead of echoing a raw last reply', () => {
  const preview = queuePreview({title:'File the complaint',brief:'Prepare the case.',summary:'## Technical output\n- file:///private/path',overview:'Collect **evidence** for the complaint.',statusText:'Evidence is ready for review.'});
  assert.equal(preview.overview,'Collect evidence for the complaint.');assert.equal(preview.status,'Evidence is ready for review.');
  assert.equal(queuePreview({title:'Task',brief:'Original goal',summary:'Raw last reply'}).overview,'');
});
test('source formatting preserves paragraphs and lists while escaping HTML and unsafe links', () => {
  const html = renderMarkdown('## Result\n\n**Ready** for review.\n\n- First\n- Second\n\n1. Review\n2. Continue\n\n```js\n<script>bad()</script>\n```\n\n[Source](https://example.com)\n\n[Unsafe](javascript:alert(1))');
  assert.match(html,/<h3>Result<\/h3>/);assert.match(html,/<ul><li>First<\/li><li>Second<\/li><\/ul>/);assert.match(html,/<ol>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|href="javascript/);assert.match(html,/href="https:\/\/example.com"/);
});

test('reordering respects drafts, structured answers, active recording and in-flight routing',async()=>{
  const {canRefocus,acceptsRoomPaste,briefingNarration}=await import('../public/flow.js');
  assert.equal(canRefocus({}),true);for(const input of [{busy:true},{recording:true},{pendingConductor:'conductor'},{text:'Unfinished thought'},{answers:['Selected option']}])assert.equal(canRefocus(input),false);
  assert.equal(acceptsRoomPaste({}),true);assert.equal(acceptsRoomPaste({editable:true,thought:true}),true);assert.equal(acceptsRoomPaste({inDrawer:true}),false);assert.equal(acceptsRoomPaste({editable:true}),false);
  assert.match(briefingNarration({spoken:'Choose a filing date.'},{title:'Domain complaint'},{first:true,name:'Boyd'}),/Hey Boyd.*first task.*Domain complaint.*Choose a filing date/);
});

test('repeat visits use the concise update and decision but keep all choices',async()=>{
 const {taskBrief,briefingNarration}=await import('../public/flow.js');const scene={body:'Full background.',spoken:'Full background.',resumeBody:'A reply arrived. Choose a date.',resumeSpoken:'A reply arrived. Choose a date. Option one, Monday.',choices:[{quote:'Monday'}]};
 assert.equal(taskBrief(scene,{id:'a'}).body,'Full background.');const resume=taskBrief(scene,{id:'a',briefedAt:'2026-11-02'});assert.equal(resume.body,'A reply arrived. Choose a date.');assert.deepEqual(resume.choices,scene.choices);const spoken=briefingNarration(resume,{title:'Planning'},{returning:true});assert.match(spoken,/Back to Planning/);assert.doesNotMatch(spoken,/Full background/);assert.match(spoken,/Monday/);
});


test('entry greets the saved user without selecting work or starting rotation', async () => {
  const { entryScene, maySurfaceQueue } = await import('../public/flow.js');
  const greeting=entryScene('Boyd');
  assert.equal(greeting.spoken,'Hello Boyd, what’s on your mind?');
  assert.equal(greeting.body,'');assert.equal(greeting.advance,false);assert.equal(greeting.entry,'greeting');
  assert.equal(entryScene('').spoken,'Hello, what’s on your mind?');
  assert.equal(maySurfaceQueue({session:true,queueStarted:false}),false);
  assert.equal(maySurfaceQueue({session:true,queueStarted:true}),true);
  assert.equal(maySurfaceQueue({session:true,queueStarted:true,pendingConductor:'run'}),false);
  assert.equal(maySurfaceQueue({session:true,queueStarted:true,busy:true}),false);
});
test('short entry commands navigate; complete new instructions stay with the conductor', async () => {
  const { entryIntent, entryScene } = await import('../public/flow.js');
  for(const text of ['Start the queue', "Let’s start the queue.", 'Hey, go through my queue please'])assert.equal(entryIntent(text),'queue');
  assert.equal(entryIntent('Add a new task'),'add');
  assert.equal(entryIntent('Find an existing conversation'),'find');
  assert.equal(entryIntent('Add a task to compare database options in my project'),null);
  assert.equal(entryIntent('Do not start the queue'),null);
  assert.equal(entryScene('Boyd','add').entry,'add');
  assert.equal(entryScene('Boyd','find').entry,'find');
});
