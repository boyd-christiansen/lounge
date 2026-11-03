import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, rank } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';

class FakeCodex extends EventEmitter {
  constructor() { super(); this.ready = true; this.calls = []; this.replies = []; this.count = 0; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++this.count } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + this.count } };
    return {};
  }
  reply(id, result) { this.replies.push({ id, result }); }
  send(message) { this.replies.push(message); }
  stop() {}
}
function fixture() { const store = new Store(':memory:'); const codex = new FakeCodex(); const engine = new Engine(store, codex, process.cwd()); return { store, codex, engine }; }

test('age resurfaces old work without displacing an urgent priority', () => {
  const at = Date.now(), basic = { createdAt: new Date(at).toISOString(), status: 'queued', pin: false };
  const urgent = { ...basic, priority: 'high' };
  const veryOld = { ...basic, priority: 'normal', createdAt: '2020-01-01', dueAt: '2020-02-01', pin: true, status: 'waiting' };
  assert.ok(rank(urgent, at) > rank(veryOld, at));
  assert.ok(rank({ ...basic, priority: 'normal', createdAt: '2020-01-01' }, at) > rank({ ...basic, priority: 'normal' }, at));
});
test('a duplicate capture command produces one task and one receipt', () => {
  const s = new Store(':memory:');
  const first = s.once('capture-1', () => s.create({ title: 'Finish the filing packet' }));
  const second = s.once('capture-1', () => s.create({ title: 'Duplicate' }));
  assert.equal(first.id, second.id); assert.equal(s.all().length, 1); s.close();
});
test('stale edits fail instead of overwriting a newer priority', () => {
  const s = new Store(':memory:'), t = s.create({ title: 'Work' });
  s.update(t.id, { priority: 'high' }, t.revision);
  assert.throws(() => s.update(t.id, { priority: 'low' }, t.revision), { status: 409 });
  assert.equal(s.get(t.id).priority, 'high'); s.close();
});
test('snoozing persists and restores the prior attention state when due', () => {
  const s = new Store(':memory:'), t = s.create({ title: 'Review the result' });
  s.update(t.id, { status: 'snoozed', resumeStatus: 'review', snoozedUntil: '2020-01-01' });
  assert.equal(s.snapshot()[0].status, 'review'); s.close();
});
test('task and event history survive a process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lounge-test-')), path = join(dir, 'queue.sqlite');
  const first = new Store(path), t = first.create({ title: 'Do not lose this obligation' });
  first.update(t.id, { priority: 'critical' }); first.close();
  const next = new Store(path); assert.equal(next.get(t.id).priority, 'critical'); assert.equal(next.history(t.id)[0].kind, 'created'); next.close(); rmSync(dir, { recursive: true });
});
test('dispatch reserves before awaiting Codex, preventing duplicate active turns', async () => {
  const { engine, store, codex } = fixture(), t = engine.capture({ title: 'Work', projectId: 'lounge' });
  const first = engine.dispatch(t.id);
  await assert.rejects(engine.dispatch(t.id), /already has an active/);
  await first; assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 1); store.close();
});
test('parallel dispatch is allowed across separate workspaces and blocked within one', async () => {
  const { engine, store } = fixture();
  store.setMeta('projects', [...store.getMeta('projects'), { id: 'second', name: 'Second', path: tmpdir() }]);
  const a = engine.capture({ title: 'A', projectId: 'lounge' }), b = engine.capture({ title: 'B', projectId: 'second' }), c = engine.capture({ title: 'C', projectId: 'inbox' });
  await Promise.all([engine.dispatch(a.id), engine.dispatch(b.id)]);
  assert.equal(store.get(a.id).status, 'running'); assert.equal(store.get(b.id).status, 'running');
  await assert.rejects(engine.dispatch(c.id), /owns this workspace/); store.close();
});
test('questions hold only their own task and cannot be answered from a different task', async () => {
  const { engine, store, codex } = fixture(), t = engine.capture({ title: 'Choose an option' }), other = engine.capture({ title: 'Other' });
  await engine.dispatch(t.id);
  await engine.request({ id: 42, method: 'item/tool/call', params: { threadId: store.get(t.id).threadId, tool: 'lounge_ask', arguments: { question: 'Which date?', context: 'This is needed to finish.' } } });
  assert.equal(store.get(t.id).status, 'waiting'); assert.equal(store.get(other.id).status, 'queued');
  await assert.rejects(engine.answer(other.id, '42', { text: 'Friday' }), /expired/);
  await engine.answer(t.id, '42', { text: 'Friday, after I finish the review.' });
  assert.equal(store.get(t.id).status, 'running'); assert.equal(codex.replies.at(-1).result.contentItems[0].text, 'Friday, after I finish the review.');
  await assert.rejects(engine.answer(t.id, '42', { text: 'Duplicate' }), /expired/); store.close();
});
test('results enter review and require explicit acknowledgment', async () => {
  const { engine, store } = fixture(), t = engine.capture({ title: 'Make a result' });
  await engine.dispatch(t.id); const threadId = store.get(t.id).threadId;
  engine.notification({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', phase: 'final_answer', text: 'Verified result.' } } });
  engine.notification({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
  assert.equal(store.get(t.id).status, 'review'); assert.equal(store.get(t.id).summary, 'Verified result.'); assert.equal(engine.live.size, 0); store.close();
});
test('imported desktop threads cannot be dispatched by a separate runtime', async () => {
  const { engine, store } = fixture(), t = engine.capture({ title: 'An existing desktop chat' });
  store.update(t.id, { external: true, threadId: 'desktop-owned' });
  await assert.rejects(engine.dispatch(t.id), /owned by Codex desktop/); store.close();
});
test('disconnect preserves the task and removes expired request handles', async () => {
  const { engine, store, codex } = fixture(), t = engine.capture({ title: 'In flight' });
  await engine.dispatch(t.id);
  codex.emit('disconnected', new Error('Transport stopped'));
  assert.equal(store.get(t.id).status, 'paused'); assert.equal(engine.live.size, 0); assert.equal(engine.requests.size, 0); store.close();
});
test('reconnecting an already initialized runtime reports connected', async () => {
  const { engine, store } = fixture();
  await engine.connect(); await engine.connect(); assert.equal(engine.connection.state, 'connected'); store.close();
});
test('an old conductor gets the new tool contract without erasing its task history', async () => {
  const { engine, store, codex } = fixture();
  const t = store.create({ title: 'Your conductor', projectId: 'lounge' });
  store.update(t.id, { isConductor: true, threadId: 'old-runtime', status: 'review', messages: [{ role: 'user', text: 'Earlier context', at: new Date().toISOString() }] });
  await engine.conductor('What needs me next?');
  const request = codex.calls.find(c => c.method === 'thread/start');
  assert.ok(request.params.dynamicTools.some(t => t.name === 'lounge_send'));
  assert.ok(!codex.calls.some(c => c.method === 'thread/resume' && c.params.threadId === 'old-runtime'));
  assert.deepEqual(store.get(t.id).previousThreadIds, ['old-runtime']);
  assert.equal(store.get(t.id).messages[0].text, 'Earlier context'); store.close();
});

test('a new thought during a worker question goes to the conductor without answering the worker', async () => {
  const { engine, store, codex } = fixture(), worker = engine.capture({ title: 'Worker' });
  await engine.dispatch(worker.id);
  await engine.request({ id: 77, method: 'item/tool/call', params: { threadId: store.get(worker.id).threadId, tool: 'lounge_ask', arguments: { question: 'Which format?' } } });
  const result = await engine.conductor('New task: research a different topic.', {taskId:worker.id,requestId:'77'});
  const sent = JSON.parse(codex.calls.filter(c=>c.method==='turn/start').at(-1).params.input[0].text);
  assert.equal(sent.currentTask.pending[0].question,'Which format?');assert.match(sent.userInstruction,/New task/);
  assert.equal(store.get(worker.id).status,'waiting');assert.equal(codex.replies.length,0);
  assert.equal(result.toolVersion,10);store.close();
});
test('conductor answers only the displayed question and preserves the exact complete thought', async () => {
  const { engine, store, codex } = fixture(), worker = engine.capture({ title: 'Worker' });
  await engine.dispatch(worker.id);
  await engine.request({ id: 77, method: 'item/tool/call', params: { threadId: store.get(worker.id).threadId, tool: 'lounge_ask', arguments: { question: 'Which format?' } } });
  await assert.rejects(engine.conductor('PDF',{taskId:worker.id,requestId:'stale'}),/question changed/);
  const c=await engine.conductor('PDF, with every appendix.',{taskId:worker.id,requestId:'77'});
  const call = args => engine.request({id:88,method:'item/tool/call',params:{threadId:c.threadId,tool:'lounge_answer',arguments:args}});
  await call({taskId:worker.id,requestId:'77',text:'PDF'});assert.equal(codex.replies.at(-1).result.success,false);assert.equal(store.get(worker.id).status,'waiting');
  await call({taskId:worker.id,requestId:'77',text:'PDF, with every appendix.'});assert.equal(store.get(worker.id).status,'running');
  assert.equal(codex.replies.find(r=>r.id===77).result.contentItems[0].text,'PDF, with every appendix.');store.close();
});
test('import previews require a later exchange and restrict imports to the shown candidates', async () => {
  const {engine,store}=fixture(), c=store.create({title:'Conductor'});
  store.update(c.id,{isConductor:true,routingContext:{runId:'first'},artifactBatch:{id:'batch',proposedInRun:'first',candidates:[{id:'chat-a'}]}});
  await assert.rejects(engine.confirmImports(c.id,{batchId:'batch',threadIds:['chat-a']}),/later exchange/);
  store.update(c.id,{routingContext:{runId:'second'}});
  await assert.rejects(engine.confirmImports(c.id,{batchId:'batch',threadIds:['unseen']}),/preview/);
  let imported=0;engine.importThread=async id=>{imported++;return {threadId:id};};
  await engine.confirmImports(c.id,{batchId:'batch',threadIds:['chat-a']});assert.equal(imported,1);assert.deepEqual(store.get(c.id).artifactBatch.importedIds,['chat-a']);store.close();
});

test('thread overviews use the original goal and history and discard results after a task changes', async () => {
  const {engine,store}=fixture(),t=engine.capture({title:'Case',brief:'Original goal'});
  store.update(t.id,{sourceHistory:[{role:'user',text:'Earlier context'}],summary:'Latest result'});
  let input,finish;
  engine.readOnlyJson=async(_instructions,data)=>{input=data;return new Promise(resolve=>{finish=resolve;});};
  engine.scheduleOverview(t.id);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(input.originalContext,'Original goal');assert.equal(input.recentHistory[0].text,'Earlier context');
  store.update(t.id,{summary:'A newer result'});finish({overview:'Stale overview',statusText:'Old status'});await engine.overviewChain;
  assert.equal(store.get(t.id).overview,undefined);
  engine.readOnlyJson=async()=>({overview:'The overall purpose.',statusText:'The current state.'});
  engine.scheduleOverview(t.id);await engine.overviewChain;
  assert.equal(store.get(t.id).overview,'The overall purpose.');assert.equal(store.get(t.id).statusText,'The current state.');store.close();
});

test('chat discovery creates bounded preview cards with preserved source titles before confirmation', async () => {
  const {engine,store,codex}=fixture();
  const c=await engine.conductor('Find the sample planning chat.');
  engine.discover=async()=>({threads:[{id:'sample-chat',title:'Original source title',preview:'Unformatted source preview',cwd:'/sample/Planning',updatedAt:'2026-11-01T00:00:00Z'}]});
  engine.readOnlyJson=async()=>({descriptions:[{id:'sample-chat',description:'Plan a small product launch and its next steps.'}]});
  await engine.request({id:123,method:'item/tool/call',params:{threadId:c.threadId,tool:'lounge_find_chats',arguments:{query:'sample'}}});
  const result=codex.replies.at(-1).result;assert.equal(result.success,true);
  const batch=JSON.parse(result.contentItems[0].text);assert.equal(batch.candidates[0].title,'Original source title');assert.equal(batch.candidates[0].preview,'Plan a small product launch and its next steps.');
  assert.equal(store.all().filter(t=>!t.isConductor).length,0);
  await assert.rejects(engine.confirmImports(c.id,{batchId:batch.id,threadIds:['sample-chat']}),/later exchange/);
  await engine.request({id:124,method:'item/tool/call',params:{threadId:c.threadId,tool:'lounge_ask',arguments:{question:'Is this the chat you want to bring in?'}}});
  assert.equal(store.get(c.id).status,'waiting');
  await engine.conductor('No, leave it out.',{taskId:c.id,requestId:store.get(c.id).pending[0].id});assert.equal(store.all().filter(t=>!t.isConductor).length,0);assert.equal(store.get(c.id).status,'running');store.close();
});

test('removing and undoing a task preserve its source and review state',()=>{
 const {store,engine}=fixture();const t=engine.capture({title:'Review this'});store.update(t.id,{external:true,threadId:'original-source',status:'review',summary:'Result ready'});engine.clear(t.id);assert.equal(store.get(t.id).status,'done');assert.equal(store.get(t.id).threadId,'original-source');engine.restore(t.id);assert.equal(store.get(t.id).status,'review');assert.equal(store.get(t.id).summary,'Result ready');engine.close();store.close();
});


test('a new entry thought cannot answer an unseen coordinator question', async () => {
  const {engine,store,codex}=fixture();
  const c=await engine.conductor('Help me choose.');
  await engine.request({id:901,method:'item/tool/call',params:{threadId:store.get(c.id).threadId,tool:'lounge_ask',arguments:{question:'Which workspace?'}}});
  await assert.rejects(engine.conductor('Start a new research task'),{status:409});
  assert.equal(store.get(c.id).status,'waiting');assert.equal(codex.replies.length,0);
  await engine.conductor('The current workspace.',{taskId:c.id,requestId:store.get(c.id).pending[0].id});
  assert.equal(codex.replies.length,1);store.close();
});
