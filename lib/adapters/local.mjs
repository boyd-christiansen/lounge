import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a local API URL, such as http://127.0.0.1:1234/v1'); }
  if (url.protocol !== 'http:' || !(['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('Local inference must use an HTTP loopback URL without credentials');
  return url.href.replace(/\/+$/, '');
}

// A coordinator-only tool loop for local OpenAI-compatible servers. It has no
// shell, filesystem, credential reader, or paid-provider fallback.
export class LocalAdapter extends EventEmitter {
  constructor(endpoint = '', { fetchImpl = fetch } = {}) {
    super(); this.id = 'local'; this.name = 'Local model'; this.roles = ['coordinator']; this.billing = 'local';
    this.sessions = new Map(); this.pending = new Map(); this.ready = false; this.fetch = fetchImpl; this.configure(endpoint);
  }
  get configured() { return !!this.endpoint; }
  configure(endpoint) {
    if ([...this.sessions.values()].some(s => s.active)) throw new Error('Wait for local inference to finish before changing its connection');
    this.endpoint = endpoint ? localEndpoint(endpoint) : ''; this.ready = false;
  }
  async request(path, options = {}) {
    if (!this.endpoint) throw new Error('Connect a local model server in Settings first');
    const response = await this.fetch(this.endpoint + path, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`The local model server returned HTTP ${response.status}. Check its API and model settings.`);
    return response.json();
  }
  async connect() { await this.listModels(); this.emit('connected'); }
  async listModels() {
    const result = await this.request('/models'); this.ready = true;
    return (result.data || []).filter(m => typeof m.id === 'string').map(m => ({ id: m.id, name: m.id, efforts: [] }));
  }
  async openSession({ sessionId, instructions, tools = [], model, history = [] }) {
    if (!this.configured) throw new Error('Connect a local model server in Settings first');
    if (!model) throw new Error('Choose a specific local model');
    const id = sessionId || randomUUID(), existing = this.sessions.get(id);
    if (existing?.active) throw new Error('The saved thread is still active. It was not dispatched again.');
    const messages = existing?.messages || history.filter(m => ['user', 'agent'].includes(m.role) && (!m.phase || m.phase === 'final_answer')).slice(-12).map(m => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: String(m.text).slice(0, 6000) }));
    this.sessions.set(id, { id, model, instructions, tools, messages, active: false });
    return { id };
  }
  async startTurn({ sessionId, text, model, outputSchema }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.active) throw new Error('The local session is unavailable or already working');
    const turnId = randomUUID(), abort = new AbortController();
    session.active = true; session.abort = abort; session.turnId = turnId;
    session.messages.push({ role: 'user', content: text });
    // Return admission immediately, like app-server. Completion/questions are events.
    session.run = this.run(session, model || session.model, outputSchema, abort.signal).catch(error => {
      // An interrupted tool question must not leave orphan tool calls that make
      // the next request invalid. The result is explicitly unknown, not success.
      const lastAssistant = session.messages.findLastIndex(m => m.role === 'assistant');
      const calls = session.messages[lastAssistant]?.tool_calls || [];
      const answered = new Set(session.messages.slice(lastAssistant + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id));
      for (const call of calls) if (!answered.has(call.id)) session.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Interrupted: no result was confirmed. Reconcile queue state before retrying an action.' });
      session.active = false;
      this.emit('event', { providerId: this.id, sessionId, type: 'turn.ended', status: abort.signal.aborted ? 'interrupted' : 'failed', error: abort.signal.aborted ? null : error.message });
    });
    return { id: turnId };
  }
  async run(session, model, schema, signal) {
    const base = { providerId: this.id, sessionId: session.id };
    for (let round = 0; round < 24; round++) {
      const result = await this.request('/chat/completions', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]), body: JSON.stringify({ model, messages: [{ role: 'system', content: session.instructions }, ...session.messages], stream: false, ...(session.tools.length ? { tools: session.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}), ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'lounge_scene', strict: true, schema } } } : {}) }) });
      const choice = result.choices?.[0], message = choice?.message;
      if (!message) throw new Error('The local model server did not return an assistant message');
      session.messages.push({ role: 'assistant', content: message.content || null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) });
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          if (signal.aborted) throw new Error('Interrupted');
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { throw new Error('The local model returned invalid tool arguments'); }
          const output = await new Promise((resolve, reject) => {
            const id = `local:${randomUUID()}`, abort = () => { this.pending.delete(id); reject(new Error('Interrupted')); };
            this.pending.set(id, { sessionId: session.id, finish: value => { signal.removeEventListener('abort', abort); resolve(value); } });
            signal.addEventListener('abort', abort, { once: true });
            this.emit('request', { ...base, id, kind: 'tool', tool: call.function.name, args, questions: [], blocking: true });
          });
          session.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
        continue;
      }
      if (choice.finish_reason !== 'stop') throw new Error('The local response stopped before completion. Review its context before retrying.');
      if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('The local model returned no final message');
      this.emit('event', { ...base, type: 'message', phase: 'final_answer', text: message.content });
      session.active = false;
      this.emit('event', { ...base, type: 'turn.ended', status: 'completed' }); return;
    }
    throw new Error('The local coordinator reached its tool limit. Your queue is saved.');
  }
  respond(request, result) {
    const pending = this.pending.get(request.id);
    if (!pending) throw new Error('This local request has expired');
    this.pending.delete(request.id); pending.finish(result.success === false ? JSON.stringify({ error: result.text }) : result.text);
  }
  reject(request, message) { this.respond(request, { success: false, text: message }); }
  async interrupt(sessionId) { this.sessions.get(sessionId)?.abort?.abort(); }
  async release(sessionId) { const session = this.sessions.get(sessionId); if (session?.active) await session.run; this.sessions.delete(sessionId); }
  close() { for (const session of this.sessions.values()) session.abort?.abort(); }
}
