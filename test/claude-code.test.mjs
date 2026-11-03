import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { Providers } from '../lib/providers.mjs';
import { ClaudeCodeAdapter, claudeEnvironment } from '../lib/adapters/claude-code.mjs';
import { applicationFor, taskCapabilities } from '../public/applications.js';
import { sourceUrl } from '../public/flow.js';

const scene = { title: 'Ready', body: 'The task is ready.', spoken: 'Ready.', needsReply: false, advance: false };
function fakeSdk(script = async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'Verified.' }; }) {
  const calls = [];
  return {
    calls, tool: (name, description, schema, handler) => ({ name, description, schema, handler }), createSdkMcpServer: options => options,
    renameSession: async () => {}, listSessions: async () => [], getSessionInfo: async () => undefined, getSessionMessages: async () => [],
    query({ prompt, options }) {
      const call = { prompt, options, closed: false }; calls.push(call);
      const iterator = (async function* () {
        const input = await prompt.next(); if (input.done) return;
        call.input = input.value;
        yield { type: 'system', subtype: 'init', session_id: options.sessionId || options.resume };
        yield* script(call);
      })();
      iterator.accountInfo = async () => ({ apiProvider: 'firstParty', tokenSource: 'none' });
      iterator.supportedModels = async () => [{ value: 'default', resolvedModel: 'claude-test', displayName: 'Default' }, { value: 'sonnet', resolvedModel: 'claude-test', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }];
      iterator.close = () => { call.closed = true; prompt.close(); };
      return iterator;
    },
  };
}
function fixture(sdk = fakeSdk()) {
  const store = new Store(':memory:'), adapter = new ClaudeCodeAdapter({ cwd: process.cwd(), binary: '/test/claude', sdk, environment: {}, authCheck: async () => ({ authMethod: 'claude.ai', subscriptionType: 'team' }) });
  const providers = new Providers([adapter]), engine = new Engine(store, null, process.cwd(), { providers });
  return { store, adapter, providers, engine, sdk };
}
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Expected state did not arrive'); }

test('Claude catalog uses its native metadata without sending a user turn and strips alternate billing credentials', async () => {
  const { adapter, sdk, store } = fixture(); const models = await adapter.listModels();
  assert.equal(models[0].id, 'claude-test'); assert.equal(sdk.calls[0].input, undefined); assert.equal(sdk.calls[0].closed, true);
  assert.equal(sdk.calls[0].options.strictMcpConfig, true);
  const env = claudeEnvironment({ ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://other', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'secret', ELEVENLABS_API_KEY: 'secret', PATH: '/bin', CLAUDE_CONFIG_DIR: '/native-config' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/native-config', CLAUDE_CODE_MAX_RETRIES: '0' }); store.close();
});

test('Claude coordinator executes Lounge tools and returns structured scenes without filesystem tools', async () => {
  const sdk = fakeSdk(async function* (call) {
    const tool = call.options.mcpServers.lounge.tools.find(t => t.name === 'lounge_rotation');
    const result = await tool.handler({ mode: 'work' }); assert.equal(result.isError, false);
    yield { type: 'result', subtype: 'success', is_error: false, structured_output: scene };
  });
  const { engine, store } = fixture(sdk); await engine.setInference({ scope: 'coordinator', model: 'claude-code/claude-test', effort: 'low' });
  const task = await engine.conductor('Turn personal work off.'); await until(() => store.get(task.id).status === 'review');
  assert.equal(engine.state().rotationMode, 'work'); assert.deepEqual(JSON.parse(store.get(task.id).summary), scene);
  assert.deepEqual(sdk.calls.at(-1).options.tools, []); assert.equal(sdk.calls.at(-1).options.effort, 'low');
  assert.equal(sdk.calls.at(-1).options.permissionMode, 'default'); engine.close(); store.close();
});

test('Claude read-only briefings work without queue tools and release their ephemeral session', async () => {
  const sdk = fakeSdk(async function* () { yield { type: 'result', subtype: 'success', is_error: false, structured_output: scene }; });
  const { engine, adapter, store } = fixture(sdk); await engine.setInference({ scope: 'coordinator', model: 'claude-code/claude-test', effort: 'low' });
  const result = await engine.readOnlyJson('Summarize only.', { sample: 'Saved evidence.' }, { type: 'object' });
  assert.deepEqual(result, scene); assert.equal(adapter.sessions.size, 0); assert.deepEqual(sdk.calls.at(-1).options.mcpServers, {});
  assert.equal(sdk.calls.at(-1).options.persistSession, false); assert.equal(sdk.calls.at(-1).options.effort, 'low'); engine.close(); store.close();
});

test('Claude native questions and explicit approvals round-trip without saving broader permission rules', async () => {
  const sdk = fakeSdk(async function* (call) {
    const signal = call.options.abortController.signal;
    const answer = await call.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which format?', options: [{ label: 'PDF' }, { label: 'Text' }] }] }, { signal });
    assert.equal(answer.updatedInput.answers['Which format?'], 'PDF with the complete appendix.');
    const input = { file_path: process.cwd() + '/fixture.txt', content: 'A test.' };
    const approval = await call.options.canUseTool('Write', input, { signal });
    assert.deepEqual(approval, { behavior: 'allow', updatedInput: input });
    assert.equal('updatedPermissions' in approval, false);
    yield { type: 'result', subtype: 'success', is_error: false, result: 'A result for review.' };
  });
  const { engine, store } = fixture(sdk), task = engine.capture({ title: 'Claude task', application: 'claude-code' });
  await engine.dispatch(task.id); await until(() => store.get(task.id).pending[0]?.kind === 'question');
  const question = store.get(task.id).pending[0]; assert.equal(question.questions[0].id, 'q0');
  await engine.answer(task.id, question.id, { text: 'PDF with the complete appendix.', answers: { q0: 'PDF with the complete appendix.' } });
  await until(() => store.get(task.id).pending[0]?.kind === 'approval');
  await assert.rejects(engine.answer(task.id, store.get(task.id).pending[0].id, { text: 'yes' }), /approval decision/);
  await engine.answer(task.id, store.get(task.id).pending[0].id, { decision: 'accept' });
  await until(() => store.get(task.id).status === 'review'); assert.equal(store.get(task.id).summary, 'A result for review.'); engine.close(); store.close();
});

test('Claude cancellation resolves blocked questions and later turns resume the owned session', async () => {
  let turn = 0;
  const sdk = fakeSdk(async function* (call) {
    if (++turn === 1) await call.options.canUseTool('AskUserQuestion',{questions:[{question:'A question.',options:[]}]},{signal:call.options.abortController.signal});
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Resumed.' };
  });
  const { engine, store, adapter } = fixture(sdk), task = engine.capture({ title: 'Wait', application: 'claude-code' });
  await engine.dispatch(task.id); await until(() => store.get(task.id).status === 'waiting'); const first = store.get(task.id);
  await engine.interrupt(task.id); assert.equal(store.get(task.id).status, 'paused'); assert.equal(adapter.pending.size, 0); assert.equal(engine.requests.size, 0);
  await engine.setInference({ scope: 'task', taskId: task.id, model: 'claude-code/claude-test', effort: 'high' });
  await engine.dispatch(task.id, 'Continue'); await until(() => store.get(task.id).status === 'review');
  assert.equal(sdk.calls.at(-1).options.resume, first.threadId); assert.equal(sdk.calls.at(-1).options.effort, 'high');
  assert.equal(sdk.calls.at(-1).options.sandbox.enabled, true); assert.equal(sdk.calls.at(-1).options.sandbox.allowUnsandboxedCommands, false);
  engine.close(); store.close();
});

test('Claude respects source ownership and rejects writes through symlinks outside the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-bounds-')), workspace = join(dir, 'work'), outside = join(dir, 'outside'); mkdirSync(workspace); mkdirSync(outside); symlinkSync(outside, join(workspace, 'escape'));
  const { engine, adapter, store } = fixture();
  const source = engine.capture({ title: 'Native source', application: 'claude-code' }); store.update(source.id, { external: true, threadId: 'foreign-owned' });
  await assert.rejects(engine.dispatch(source.id), /owned by Claude Code/);
  assert.throws(() => engine.setApplication(source.id, 'codex'), /source conversation/);
  engine.setApplication(source.id, 'claude-code'); assert.equal(store.get(source.id).external, true);
  const guard = adapter.guard({ readOnly: false, cwd: workspace, tools: [] }, { tool_name: 'Write', tool_input: { file_path: join(workspace, 'escape/file.txt') } });
  assert.equal(guard.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(adapter.guard({ readOnly: false, cwd: workspace }, { tool_name: 'Bash', tool_input: { dangerouslyDisableSandbox: true } }).hookSpecificOutput.permissionDecision, 'deny');
  rmSync(dir, { recursive: true }); store.close();
});

test('application type, provider and handoff capabilities stay distinct when defaults change', async () => {
  const { engine, store } = fixture(); await engine.setInference({ scope: 'workers', model: 'claude-code/claude-test', effort: 'low' });
  const a = engine.capture({ title: 'Default worker' }), b = engine.capture({ title: 'ChatGPT work', application: 'chatgpt', sourceUrl: 'https://chatgpt.com/c/sample' }), c = engine.capture({ title: 'Cowork work', application: 'claude-cowork' });
  assert.equal(a.application, 'claude-code'); assert.equal(b.application, 'chatgpt'); assert.equal(c.application, 'claude-cowork');
  assert.equal(sourceUrl(a), null); assert.equal(sourceUrl(b), 'https://chatgpt.com/c/sample'); assert.equal(sourceUrl(c), 'https://claude.ai/');
  for (const t of [b, c]) { assert.equal(taskCapabilities(t, engine.providers.state()).dispatch, false); await assert.rejects(engine.dispatch(t.id), /owned by|handoff/); }
  assert.equal(taskCapabilities(c).ownership, 'handoff'); assert.equal(taskCapabilities(b).ownership, 'source');
  assert.equal(engine.state().tasks.find(t => t.id === a.id).capabilities.managed, true);
  assert.throws(() => engine.capture({ title: 'Wrong link', application: 'chatgpt', sourceUrl: 'https://claude.ai/chat/other' }), /another application/);
  assert.equal(applicationFor({ provider: 'claude', external: true }), 'claude-chat'); assert.equal(applicationFor({ provider: 'claude', external: false }), 'claude-code');
  store.close();
});

test('Claude source discovery is scoped to registered workspaces and preserves native source titles', async () => {
  const sdk = fakeSdk(), searched = []; const cwd = process.cwd();
  sdk.listSessions = async options => { searched.push(options.dir); return [{ sessionId: 'source-1', customTitle: 'Exact native title', firstPrompt: 'Original purpose', cwd, lastModified: 1000 }]; };
  sdk.getSessionInfo = async () => ({ sessionId: 'source-1', customTitle: 'Exact native title', firstPrompt: 'Original purpose', cwd, lastModified: 1000 });
  sdk.getSessionMessages = async () => [{ type: 'user', uuid: 'u', message: { content: 'Original purpose' } }, { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'Saved result' }] } }];
  const { engine, store } = fixture(sdk); engine.scheduleOverview = () => {};
  const found = await engine.discover(null, 'native', 'claude-code'); assert.equal(found.threads[0].title, 'Exact native title'); assert.ok(searched.every(p => p === cwd));
  const imported = await engine.importThread('source-1', 'claude-code');
  assert.equal(imported.title, 'Exact native title'); assert.equal(imported.external, true); assert.equal(imported.summary, 'Saved result'); assert.equal(imported.sourceTurnStatus, 'unknown');
  assert.equal(engine.state().tasks.find(t => t.id === imported.id).capabilities.observe, true);
  await assert.rejects(engine.dispatch(imported.id), /owned by Claude Code/); store.close();
});

test('Claude refuses API billing and reports non-success native results as failed work', async () => {
  const sdk = fakeSdk(async function* () { yield { type: 'result', subtype: 'error_max_turns', is_error: true }; });
  const { engine, store } = fixture(sdk), task = engine.capture({ title: 'Stops early', application: 'claude-code' });
  await engine.dispatch(task.id); await until(() => store.get(task.id).status === 'error'); assert.match(store.get(task.id).lastError, /error_max_turns/);
  const prior = sdk.query; sdk.query = params => { const q = prior(params); q.accountInfo = async () => ({ apiProvider: 'firstParty', apiKeySource: 'environment' }); return q; };
  await assert.rejects(engine.providers.models('claude-code', true), /API-key authentication/);
  assert.equal(sdk.calls.at(-1).input, undefined);
  const refused = engine.capture({ title: 'Reject alternate billing before prompting', application: 'claude-code' });
  await engine.dispatch(refused.id); await until(() => ['error', 'paused'].includes(store.get(refused.id).status));
  assert.equal(store.get(refused.id).status, 'error'); assert.equal(sdk.calls.at(-1).input, undefined);
  engine.close(); store.close();
});

test('a Claude failure before native init can be retried, and restart reconciles missing versus saved owned sessions', async () => {
  const sdk = fakeSdk(), original = sdk.query; let first = true;
  sdk.query = input => { if (first) { first = false; throw new Error('Native process could not start'); } return original(input); };
  const { engine, adapter, store } = fixture(sdk), task = engine.capture({ title: 'Retry startup', application: 'claude-code' });
  await engine.dispatch(task.id); await until(() => store.get(task.id).status === 'error');
  const sessionId = store.get(task.id).threadId;
  assert.equal(adapter.sessions.get(sessionId).input.closed, true);
  await engine.dispatch(task.id, 'Retry the authorized work'); await until(() => store.get(task.id).status === 'review');
  assert.equal(sdk.calls.at(-1).options.sessionId, sessionId); assert.equal(sdk.calls.at(-1).options.resume, undefined);
  adapter.sessions.delete(sessionId); sdk.getSessionInfo = async id => ({ sessionId: id });
  await engine.dispatch(task.id, 'Continue the saved work'); await until(() => store.get(task.id).status === 'review');
  assert.equal(sdk.calls.at(-1).options.resume, sessionId);
  adapter.sessions.delete(sessionId); sdk.getSessionInfo = async () => undefined;
  await engine.dispatch(task.id, 'Retry after startup recovery'); await until(() => store.get(task.id).status === 'review');
  assert.equal(sdk.calls.at(-1).options.sessionId, sessionId);
  const restored = JSON.parse(sdk.calls.at(-1).input.message.content);
  assert.equal(restored.userInstruction, 'Retry after startup recovery'); assert.ok(restored.restoredVisibleHistory.length);
  engine.close(); store.close();
});

test('model catalog lookup cannot transfer a worker whose dispatch was reserved during the lookup', async () => {
  const { engine, store } = fixture();
  const task = engine.capture({ title: 'Already starting in Codex', application: 'codex' });
  let release;
  engine.providers.models = () => new Promise(resolve => { release = resolve; });
  const change = engine.setInference({ scope: 'task', taskId: task.id, model: 'claude-code/claude-test', effort: null });
  store.update(task.id, { status: 'running' }); // Synchronous reservation before provider/session creation.
  release([{ id: 'claude-test', efforts: [] }]);
  await assert.rejects(change, /active worker keeps its runtime/);
  assert.equal(store.get(task.id).application, 'codex'); assert.equal(store.get(task.id).inference, undefined);
  engine.close(); store.close();
});

test('desktop handoff delegates only a saved session ID to the fixed native launcher after subscription authentication',async()=>{
  const {adapter,store,engine}=fixture();const calls=[];adapter.desktopLaunch=async params=>{calls.push(params);return{opened:true};};
  assert.equal(await adapter.openDesktop('--dangerously-skip-permissions',{cwd:process.cwd()}),false);assert.equal(calls.length,0);
  const id='12345678-1234-4234-8234-123456789abc';assert.equal(await adapter.openDesktop(id,{cwd:process.cwd()}),true);assert.deepEqual(calls,[{sessionId:id,cwd:process.cwd(),binary:'/test/claude'}]);assert.equal(adapter.ready,true);engine.close();store.close();
});
