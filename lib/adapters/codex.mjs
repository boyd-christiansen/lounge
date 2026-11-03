import { EventEmitter } from 'node:events';

// Only this adapter knows Codex's wire protocol. The engine handles normalized
// sessions, events and requests, so other runtimes need not impersonate Codex.
export class CodexAdapter extends EventEmitter {
  constructor(transport) {
    super(); this.transport = transport; this.id = 'codex'; this.name = 'Codex';
    this.roles = ['coordinator', 'worker']; this.billing = 'subscription'; this.canObserve = true;
    transport.on('connected', () => this.emit('connected'));
    transport.on('disconnected', error => this.emit('disconnected', error));
    transport.on('notification', message => { const event = this.normalizeEvent(message); if (event) this.emit('event', event); });
    transport.on('request', message => this.emit('request', this.normalizeRequest(message)));
  }
  get ready() { return this.transport.ready; }
  async connect() {
    await this.transport.start();
    const auth = await this.transport.call('account/read', {});
    if (auth.account === null) throw new Error('Sign in to OpenAI to connect Codex.');
    if (auth.account?.type === 'apiKey') throw new Error('Codex is signed in with an API key. Sign in with ChatGPT to use your subscription; paid API inference is not enabled in Lounge.');
  }
  async listModels() {
    await this.transport.start(); const models = []; let cursor;
    do {
      const page = await this.transport.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of page.data || []) models.push({ id: model.model || model.id, name: model.displayName || model.model || model.id, efforts: (model.supportedReasoningEfforts || []).map(e => e.reasoningEffort), defaultEffort: model.defaultReasoningEffort, isDefault: model.isDefault });
      cursor = page.nextCursor;
    } while (cursor);
    this.models = models; return models;
  }
  async openSession({ sessionId, cwd, instructions, tools = [], readOnly = false, ephemeral = false, model, title }) {
    await this.connect();
    const params = { developerInstructions: instructions, modelProvider: 'openai', ...(model ? { model } : {}) };
    const result = sessionId
      ? await this.transport.call('thread/resume', { ...params, threadId: sessionId, excludeTurns: true })
      : await this.transport.call('thread/start', { ...params, cwd, sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request', allowProviderModelFallback: false, dynamicTools: tools, ...(ephemeral ? { ephemeral: true } : {}) });
    if (result.modelProvider && result.modelProvider !== 'openai') throw new Error('The Codex subscription adapter cannot switch to another billing provider');
    if (result.thread.status?.type === 'active') throw new Error('The saved thread is still active. It was not dispatched again.');
    // Naming is cosmetic: failure must not replace or discard a saved session.
    if (!sessionId && !ephemeral && title) await this.transport.call('thread/name/set', { threadId: result.thread.id, name: title }).catch(() => {});
    return { id: result.thread.id, model: result.model, effort: result.reasoningEffort };
  }
  async startTurn({ sessionId, text, model, effort, outputSchema }) {
    effort ||= this.models?.find(m => m.id === model)?.defaultEffort;
    const result = await this.transport.call('turn/start', { threadId: sessionId, input: [{ type: 'text', text, text_elements: [] }], ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(outputSchema ? { outputSchema } : {}) });
    return { id: result.turn.id };
  }
  interrupt(sessionId, turnId) { return this.transport.call('turn/interrupt', { threadId: sessionId, turnId }); }
  release(sessionId) { return this.transport.call('thread/unsubscribe', { threadId: sessionId }).catch(() => {}); }
  async handoff(sessionId) {
    const before=await this.transport.call('thread/read',{threadId:sessionId});
    if(before.thread.status?.type==='active')throw new Error('Wait for the native turn to finish.');
    await this.transport.call('thread/unsubscribe',{threadId:sessionId});
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      const result=await this.transport.call('thread/read',{threadId:sessionId});
      if(result.thread.status?.type==='notLoaded')return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('The runtime has not released this conversation. Native handoff was not opened.');
  }
  async login() { await this.transport.start(); return this.transport.call('account/login/start', { type: 'chatgpt' }); }
  normalizeEvent(message) {
    const p = message.params || {}, base = { providerId: this.id, sessionId: p.threadId };
    if (message.method === 'item/agentMessage/delta') return { ...base, type: 'text.delta', text: p.delta };
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') return { ...base, type: 'message', text: p.item.text, phase: p.item.phase };
    if (message.method === 'serverRequest/resolved') return { ...base, type: 'request.resolved', requestId: String(p.requestId) };
    if (message.method === 'turn/completed') return { ...base, type: 'turn.ended', status: p.turn?.status, error: p.turn?.error?.message };
    return null;
  }
  normalizeRequest(message) {
    const p = message.params || {}, lounge = message.method === 'item/tool/call';
    const kind = lounge ? 'tool' : /requestUserInput/.test(message.method) ? 'question' : /requestApproval/.test(message.method) ? 'approval' : 'unsupported';
    return { providerId: this.id, id: String(message.id), sessionId: p.threadId, kind, tool: p.tool, args: p.arguments || {}, question: p.questions?.map(q => q.question).join('\n\n') || p.reason || 'Codex needs approval to continue', context: p.command || p.reason || '', questions: p.questions || [], blocking: p.isBlocking !== false, permissionGrant: /permissions\/requestApproval/.test(message.method), wireId: message.id, method: message.method };
  }
  respond(request, result) {
    let response;
    if (request.kind === 'tool') response = { contentItems: [{ type: 'inputText', text: result.text }], success: result.success !== false };
    else if (request.kind === 'question') response = { answers: Object.fromEntries(Object.entries(result.answers || {}).map(([key, value]) => [key, { answers: [value] }])) };
    else response = request.permissionGrant ? { permissions: {}, scope: 'turn' } : { decision: result.decision };
    this.transport.reply(request.wireId, response);
  }
  reject(request, message) { this.transport.send({ id: request.wireId, error: { code: -32601, message } }); }
  async discover(cursor, searchTerm) {
    await this.transport.start();
    const result = await this.transport.call('thread/list', { limit: 30, sortKey: 'updated_at', useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], ...(cursor ? { cursor } : {}), ...(searchTerm ? { searchTerm } : {}) });
    return { data: (result.data || []).map(t => this.source(t)), nextCursor: result.nextCursor };
  }
  source(t) { return { id: t.id, title: t.name || t.preview?.slice(0, 100) || 'Untitled chat', preview: t.preview?.slice(0, 5000) || '', cwd: t.cwd, updatedAt: new Date(t.updatedAt * 1000).toISOString(), application: 'codex', provider: 'codex' }; }
  async readSource(sessionId) { await this.transport.start(); const result = await this.transport.call('thread/read', { threadId: sessionId }); return this.source(result.thread); }
  async sourceHistory(sessionId) {
    await this.transport.start();
    const result = await this.transport.call('thread/turns/list', { threadId: sessionId, limit: 4, sortDirection: 'desc', itemsView: 'full' });
    const turn = result.data?.[0], final = [...(turn?.items || [])].reverse().find(x => x.type === 'agentMessage' && x.phase === 'final_answer'), progress = [...(turn?.items || [])].reverse().find(x => x.type === 'agentMessage');
    const entries = [...(result.data || [])].reverse().flatMap(t => (t.items || []).filter(item => item.type === 'userMessage' || (item.type === 'agentMessage' && item.phase === 'final_answer')).map(item => ({ role: item.type === 'userMessage' ? 'user' : 'agent', text: String(item.text || (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')).slice(0, 3500) }))).slice(-8);
    return { entries, latest: { id: turn?.id || null, status: turn?.status || 'unknown', summary: final?.text || progress?.text || '' } };
  }
  close() { this.transport.stop(); }
}
