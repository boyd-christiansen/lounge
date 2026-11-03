import { EventEmitter } from 'node:events';

export const DEFAULT_INFERENCE = { coordinator: { model: 'codex/default', effort: null }, workers: { model: 'codex/default', effort: null } };
export const sessionKey = (providerId, sessionId) => `${providerId}:${sessionId}`;

export function parseModel(value) {
  if (typeof value !== 'string' || value.length > 250 || !/^[a-z][a-z0-9-]*\/[^\s]+$/.test(value)) throw new Error('Choose a model as provider/model');
  const split = value.indexOf('/');
  return { providerId: value.slice(0, split), model: value.slice(split + 1) === 'default' ? null : value.slice(split + 1) };
}

export class Providers extends EventEmitter {
  constructor(adapters) {
    super(); this.adapters = new Map(); this.catalogs = new Map(); this.auxiliary = new Set();
    for (const adapter of adapters) this.register(adapter);
  }
  register(adapter) {
    if (this.adapters.has(adapter.id)) throw new Error('Provider is already registered');
    this.adapters.set(adapter.id, adapter);
    for (const event of ['event', 'request', 'connected', 'disconnected']) adapter.on(event, value => {
      if (event === 'request' && this.auxiliary.has(sessionKey(adapter.id, value.sessionId))) return;
      this.emit(event, value, adapter.id);
    });
  }
  adapter(id) { const adapter = this.adapters.get(id); if (!adapter) throw new Error(`The ${id} adapter is not connected`); return adapter; }
  resolve(configuration, role) {
    const route = parseModel(configuration.model), adapter = this.adapter(route.providerId);
    if(adapter.newWork===false)throw new Error('New conversations must use an agent-server or SDK provider. The desktop bridge attaches existing sources only.');
    if (!adapter.roles.includes(role)) throw new Error(`${adapter.name} does not support ${role} sessions`);
    return { ...route, effort: configuration.effort || null, selector: configuration.model, adapter };
  }
  async validate(configuration, role) {
    const route = this.resolve(configuration, role);
    if (configuration.effort !== null && configuration.effort !== undefined && typeof configuration.effort !== 'string') throw new Error('Choose a supported reasoning effort');
    if (!route.model && route.effort) throw new Error('Choose a specific model before setting effort');
    if (route.model) {
      const models = await this.models(route.providerId), model = models.find(m => m.id === route.model);
      if (!model) throw new Error('That model is not available from this provider. Refresh models and choose again.');
      if (route.effort && !model.efforts.includes(route.effort)) throw new Error('That reasoning effort is not supported by this model');
    }
    return { model: configuration.model, effort: route.effort };
  }
  async models(id, refresh = false) {
    if (refresh || !this.catalogs.has(id)) this.catalogs.set(id, await this.adapter(id).listModels());
    return this.catalogs.get(id);
  }
  state() {
    return [...this.adapters.values()].map(a => ({ id: a.id, name: a.name, roles: a.roles, billing: a.billing, ready: a.ready, configured: a.configured !== false, newWork: a.newWork!==false, canObserve: !!a.canObserve, error: a.error || null, subscriptionType: a.account?.subscriptionType, models: (this.catalogs.get(a.id) || []).map(m => ({ ...m, selector: `${a.id}/${m.id}` })) }));
  }
  async json(configuration, { cwd, instructions, input, schema }) {
    const route = this.resolve(configuration, 'coordinator'), adapter = route.adapter;
    const session = await adapter.openSession({ cwd, instructions, readOnly: true, ephemeral: true, model: route.model });
    this.auxiliary.add(sessionKey(adapter.id, session.id));
    try {
      return await new Promise((resolve, reject) => {
        let final = '', delta = '', ended = false, turnId;
        const finish = (error, value) => { if (ended) return; ended = true; clearTimeout(timer); adapter.off('event', onEvent); adapter.off('disconnected', onDisconnect); adapter.off('request', onRequest); error ? reject(error) : resolve(value); };
        const onDisconnect = error => finish(error);
        const onRequest = request => {
          if (request.sessionId !== session.id) return;
          adapter.reject(request, 'Briefings cannot execute tools');
          if (turnId) adapter.interrupt(session.id, turnId).catch(() => {});
          finish(new Error('A briefing tried to take an action'));
        };
        const onEvent = event => {
          if (event.sessionId !== session.id) return;
          if (event.type === 'text.delta') delta += event.text;
          if (event.type === 'message' && event.phase === 'final_answer') final = event.text;
          if (event.type === 'turn.ended') {
            if (event.status !== 'completed') return finish(new Error(event.error || 'The briefing was interrupted'));
            try { finish(null, JSON.parse(final || delta)); } catch { finish(new Error('The briefing response could not be read')); }
          }
        };
        const timer = setTimeout(() => { if (turnId) adapter.interrupt(session.id, turnId).catch(() => {}); finish(new Error('The briefing took too long. Your queue is saved.')); }, 90000);
        adapter.on('event', onEvent); adapter.on('disconnected', onDisconnect); adapter.on('request', onRequest);
        adapter.startTurn({ sessionId: session.id, text: JSON.stringify(input), model: route.model, effort: route.effort, outputSchema: schema }).then(turn => { turnId = turn.id; }).catch(error => finish(error));
      });
    } finally { await adapter.release(session.id); this.auxiliary.delete(sessionKey(adapter.id, session.id)); }
  }
  close() { for (const adapter of this.adapters.values()) adapter.close(); }
}
