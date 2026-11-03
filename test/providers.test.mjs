import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { Providers, parseModel } from '../lib/providers.mjs';
import { CodexAdapter } from '../lib/adapters/codex.mjs';
import { LocalAdapter, localEndpoint } from '../lib/adapters/local.mjs';
import { recentConversation, taskFrontier } from '../lib/context.mjs';
import { portableSnapshot } from '../lib/portable.mjs';

class Transport extends EventEmitter {
  constructor() { super(); this.ready = true; this.calls = []; this.replies = []; this.count = 0; }
  async start() {}
  stop() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'fast', model: 'fast', displayName: 'Fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }, { id: 'careful', model: 'careful', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] };
    if (method === 'thread/start') return { thread: { id: `session-${++this.count}` }, model: params.model || 'fast', reasoningEffort: 'low' };
    if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } }, model: params.model || 'fast' };
    if (method === 'turn/start') return { turn: { id: `turn-${this.calls.length}` } };
    return {};
  }
  reply(id, result) { this.replies.push({ id, result }); }
  send(value) { this.replies.push(value); }
}
function fixture(local) {
  const store = new Store(':memory:'), transport = new Transport(), codex = new CodexAdapter(transport);
  const providers = new Providers([codex, ...(local ? [local] : [])]);
  const engine = new Engine(store, transport, process.cwd(), { providers });
  return { store, transport, codex, providers, engine };
}
const scene = { title: 'Ready', body: 'Your next step is ready.', spoken: 'Ready.', needsReply: false, advance: false };
const completion = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200 });
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Expected state did not arrive'); }

test('provider/model selection validates capabilities and never falls back to another adapter', async () => {
  const { engine, providers, store } = fixture();
  assert.deepEqual(parseModel('local/org/model'), { providerId: 'local', model: 'org/model' });
  assert.throws(() => parseModel('missing-provider'), /provider\/model/);
  await assert.rejects(engine.setInference({ scope: 'coordinator', model: 'absent/fast' }), /not connected/);
  await assert.rejects(engine.setInference({ scope: 'coordinator', model: 'codex/unknown' }), /not available/);
  await assert.rejects(engine.setInference({ scope: 'coordinator', model: 'codex/fast', effort: 'ultra' }), /not supported/);
  await assert.rejects(engine.setInference({ scope: 'coordinator', model: 'codex/default', effort: 'high' }), /specific model/);
  await engine.setInference({ scope: 'coordinator', model: 'codex/fast', effort: 'high' });
  assert.equal(providers.resolve(engine.inference().coordinator, 'coordinator').model, 'fast');
  assert.equal(engine.inference().workers.model, 'codex/default'); store.close();
});

test('a task for an unconnected worker provider is never silently dispatched to Codex', async () => {
  const { engine, transport, store } = fixture();
  const task = engine.capture({ title: 'Claude work', provider: 'claude' });
  await assert.rejects(engine.dispatch(task.id), /claude-code adapter is not connected/);
  assert.equal(store.get(task.id).status, 'queued'); assert.equal(transport.calls.length, 0); store.close();
});

test('model and effort changes affect the next turn while preserving an owned worker session', async () => {
  const { engine, transport, store } = fixture(), task = engine.capture({ title: 'Work' });
  await engine.dispatch(task.id);
  const first = store.get(task.id);
  await engine.setInference({ scope: 'task', taskId: task.id, model: 'codex/careful', effort: 'high' });
  assert.equal(transport.calls.filter(c => c.method === 'turn/start').length, 1);
  transport.emit('notification', { method: 'turn/completed', params: { threadId: first.threadId, turn: { status: 'completed' } } });
  await engine.dispatch(task.id, 'Continue');
  const turn = transport.calls.filter(c => c.method === 'turn/start').at(-1);
  assert.equal(turn.params.threadId, first.threadId); assert.equal(turn.params.model, 'careful'); assert.equal(turn.params.effort, 'high');
  assert.equal(transport.calls.find(c => c.method === 'thread/start').params.modelProvider, 'openai');
  assert.equal(transport.calls.find(c => c.method === 'thread/start').params.allowProviderModelFallback, false);
  assert.equal(transport.calls.filter(c => c.method === 'thread/start').length, 1);
  const imported = engine.capture({ title: 'Source' }); store.update(imported.id, { external: true });
  await assert.rejects(engine.setInference({ scope: 'task', taskId: imported.id, model: 'codex/fast' }), /source app/); store.close();
});

test('normalized Codex events and questions traverse the adapter and preserve exact answers', async () => {
  const { engine, transport, store } = fixture(), task = engine.capture({ title: 'Question' });
  await engine.dispatch(task.id); const id = store.get(task.id).threadId;
  transport.emit('request', { id: 31, method: 'item/tool/call', params: { threadId: id, tool: 'lounge_ask', arguments: { question: 'Which format?' } } });
  await until(() => store.get(task.id).status === 'waiting');
  await engine.answer(task.id, '31', { text: 'PDF, including the entire appendix.' });
  assert.equal(transport.replies.at(-1).result.contentItems[0].text, 'PDF, including the entire appendix.');
  transport.emit('notification', { method: 'item/completed', params: { threadId: id, item: { type: 'agentMessage', phase: 'final_answer', text: 'Finished.' } } });
  transport.emit('notification', { method: 'turn/completed', params: { threadId: id, turn: { status: 'completed' } } });
  assert.equal(store.get(task.id).status, 'review'); assert.equal(store.get(task.id).summary, 'Finished.'); store.close();
});

test('subscription mode refuses API-key Codex authentication before any inference', async () => {
  const transport = new Transport(), original = transport.call.bind(transport);
  transport.call = (method, params) => method === 'account/read' ? Promise.resolve({ account: { type: 'apiKey' } }) : original(method, params);
  const adapter = new CodexAdapter(transport);
  await assert.rejects(adapter.openSession({ cwd: process.cwd(), instructions: 'Test' }), /paid API inference is not enabled/);
  assert.equal(transport.calls.some(c => ['thread/start', 'turn/start'].includes(c.method)), false);
});

test('local API performs real tool rounds and waits for a complete answer without starting a Codex worker', async () => {
  const calls = []; let round = 0;
  const local = new LocalAdapter('http://127.0.0.1:1234/v1', { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'own-model' }] }));
    round++;
    if (round === 1) return completion({ tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'lounge_queue', arguments: '{}' } }] });
    if (round === 2) return completion({ tool_calls: [{ id: 'tool-2', type: 'function', function: { name: 'lounge_ask', arguments: JSON.stringify({ question: 'What should we work on?' }) } }] });
    const payload = JSON.parse(options.body);
    assert.equal(payload.messages.at(-1).content, 'Let me finish my complete thought first.');
    return completion({ content: JSON.stringify(scene) });
  } });
  const { engine, transport, store } = fixture(local);
  await engine.setInference({ scope: 'coordinator', model: 'local/own-model' });
  const coordinator = await engine.conductor('What needs me?');
  await until(() => store.get(coordinator.id).status === 'waiting');
  assert.equal(round, 2);
  await engine.conductor('Let me finish my complete thought first.',{taskId:coordinator.id,requestId:store.get(coordinator.id).pending[0].id});
  await until(() => store.get(coordinator.id).status === 'review');
  assert.deepEqual(JSON.parse(store.get(coordinator.id).summary), scene);
  assert.equal(transport.calls.some(c => c.method === 'turn/start'), false);
  assert.ok(calls.every(c => c.url.startsWith('http://127.0.0.1:1234/v1/')));
  assert.ok(calls.every(c => c.options.redirect === 'error' && !('Authorization' in c.options.headers)));
  engine.close(); store.close();
});

test('local endpoint rejects remote URLs, embedded secrets and redirects rather than changing billing routes', () => {
  for (const value of ['https://api.openai.com/v1', 'http://example.com/v1', 'http://user:secret@localhost:1234/v1', 'http://localhost:1234/v1?key=secret']) assert.throws(() => localEndpoint(value), /loopback/);
  assert.equal(localEndpoint('http://[::1]:1234/v1/'), 'http://[::1]:1234/v1');
});

test('local failure surfaces as a failed turn with no Codex fallback', async () => {
  const local = new LocalAdapter('http://localhost:1234/v1', { fetchImpl: async url => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'own-model' }] })) : new Response('Unavailable', { status: 503 }) });
  const { engine, transport, store } = fixture(local);
  await engine.setInference({ scope: 'coordinator', model: 'local/own-model' });
  const task = await engine.conductor('Test the connection'); await until(() => store.get(task.id).status === 'error');
  assert.match(store.get(task.id).lastError, /HTTP 503/); assert.equal(transport.calls.length, 0); engine.close(); store.close();
});

test('an ephemeral briefing cannot execute a queue tool and releases its local session', async () => {
  const local = new LocalAdapter('http://localhost:1234/v1', { fetchImpl: async url => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'own-model' }] })) : completion({ tool_calls: [{ id: 'bad-tool', type: 'function', function: { name: 'lounge_capture', arguments: '{"title":"Unwanted work"}' } }] }) });
  const { engine, store } = fixture(local); await engine.setInference({ scope: 'coordinator', model: 'local/own-model' });
  await assert.rejects(engine.readOnlyJson('Summarize only.', {}, { type: 'object' }), /tried to take an action/);
  assert.equal(store.all().length, 0); assert.equal(local.sessions.size, 0); assert.equal(local.pending.size, 0); engine.close(); store.close();
});

test('interrupting a local question clears its live handle and leaves a resumable tool transcript', async () => {
  let round = 0;
  const local = new LocalAdapter('http://localhost:1234/v1', { fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'own-model' }] }));
    if (++round === 1) return completion({ tool_calls: [{ id: 'question-1', type: 'function', function: { name: 'lounge_ask', arguments: '{"question":"Which task?"}' } }] });
    const messages = JSON.parse(options.body).messages;
    assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'question-1' && m.content.includes('Interrupted')));
    return completion({ content: JSON.stringify(scene) });
  } });
  const { engine, store } = fixture(local); await engine.setInference({ scope: 'coordinator', model: 'local/own-model' });
  const task = await engine.conductor('Ask a question.'); await until(() => store.get(task.id).status === 'waiting');
  await engine.interrupt(task.id); await until(() => store.get(task.id).status === 'paused');
  assert.equal(local.pending.size, 0); assert.equal(engine.requests.size, 0);
  await engine.conductor('Continue after interruption.'); await until(() => store.get(task.id).status === 'review');
  assert.equal(round, 2); engine.close(); store.close();
});

test('coordinator switching preserves its local history and separates provider session identities', async () => {
  const local = new LocalAdapter('http://localhost:1234/v1', { fetchImpl: async url => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'own-model' }] })) : completion({ content: JSON.stringify(scene) }) });
  const { engine, transport, store } = fixture(local);
  const first = await engine.conductor('Remember the flow.');
  transport.emit('notification', { method: 'turn/completed', params: { threadId: first.threadId, turn: { status: 'completed' } } });
  await engine.setInference({ scope: 'coordinator', model: 'local/own-model' });
  const next = await engine.conductor('Continue in the local model.'); await until(() => store.get(next.id).status === 'review');
  assert.equal(next.id, first.id); assert.equal(store.get(next.id).runtimeProvider, 'local');
  assert.deepEqual(store.get(next.id).previousSessions, [{ providerId: 'codex', id: first.threadId }]);
  assert.equal(store.get(next.id).messages[0].role, 'user');
  await assert.rejects(engine.setInference({ scope: 'workers', model: 'local/own-model' }), /does not support worker/);
  engine.close(); store.close();
});

test('context scopes stay separate and portable snapshots omit credentials and live request handles', () => {
  const { engine, store } = fixture(), task = engine.capture({ title: 'Case', brief: 'Goal' });
  engine.context({ scope: 'project', projectKey: `task:${task.id}`, text: 'A short project decision.' });
  assert.equal(engine.context({ scope: 'project', projectKey: `task:${task.id}` }).text, 'A short project decision.');
  assert.ok(!engine.state().profile.memories.includes('A short project decision.'));
  store.update(task.id, { status: 'waiting', pending: [{ id: 'process-only' }], messages: [{ role: 'user', text: 'Private source context' }] });
  store.setMeta('credential-do-not-export', 'sentinel-secret');
  const source=store.create({title:'Existing source',projectId:'inbox'});store.update(source.id,{external:true,threadId:'original-source-id',runtimeProvider:'desktop',runtimeSessionId:'ephemeral-native-only',sourceControlReserved:true,observationReserved:true,status:'waiting'});
  const exported = portableSnapshot(store), value = JSON.stringify(exported);
  assert.ok(!value.includes('sentinel-secret')); assert.ok(!value.includes('process-only'));
  assert.equal(exported.tasks[0].status, 'paused'); assert.ok(value.includes('A short project decision.'));
  assert.ok(!value.includes('ephemeral-native-only'));const savedSource=exported.tasks.find(t=>t.id===source.id);assert.equal(savedSource.threadId,'original-source-id');assert.equal(savedSource.status,'paused');assert.equal(savedSource.sourceControlReserved,false);assert.equal(savedSource.observationReserved,false);
  const frontier = taskFrontier(store.get(task.id)); assert.ok(!('messages' in frontier)); store.close();
});

test('recent conversation flattens prior envelopes instead of recursively copying context', () => {
  const context = { messages: [{ role: 'user', text: JSON.stringify({ userInstruction: 'My actual thought.', recentConversation: ['Old context repeated here'] }) }, { role: 'agent', phase: 'final_answer', text: JSON.stringify(scene) }] };
  assert.deepEqual(recentConversation(context), [{ role: 'user', text: 'My actual thought.' }, { role: 'agent', text: 'Ready\nYour next step is ready.' }]);
});
