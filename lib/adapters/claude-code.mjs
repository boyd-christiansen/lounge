import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputChannel } from '../channel.mjs';
import { withinWorkspace } from '../workspace.mjs';

const execute = promisify(execFile);
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'AskUserQuestion'];
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

export function claudeEnvironment(environment = process.env) {
  // The native CLI owns subscription authentication. Do not turn an inherited
  // API key, alternate endpoint or cloud-backend flag into another billing route.
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('ANTHROPIC_') && !key.startsWith('CLAUDE_CODE_USE_') && !['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY','LOUNGE_DESKTOP_HOST','LOUNGE_ENV_FILE','LOUNGE_DB'].includes(key))), CLAUDE_CODE_MAX_RETRIES: '0' };
}
export function findClaude(environment = process.env) {
  if (environment.CLAUDE_BIN) return environment.CLAUDE_BIN;
  return [...(environment.PATH || '').split(process.platform === 'win32' ? ';' : ':').map(path => join(path, process.platform === 'win32' ? 'claude.exe' : 'claude')), join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(path => existsSync(path)) || null;
}
export async function claudeSignIn(binary, env) {
  if (!binary) throw new Error('Install Claude Code and sign in, then reconnect.');
  let status;
  try { status = JSON.parse((await execute(binary, ['auth', 'status', '--json'], { env, timeout: 20000, maxBuffer: 65536 })).stdout); }
  catch (error) { try { status = JSON.parse(error.stdout); } catch { throw new Error('Claude Code sign-in could not be checked. Run claude auth login, then reconnect.'); } }
  if (!status.loggedIn) throw new Error('Sign in with claude auth login, then reconnect Claude Code.');
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') throw new Error('Claude Code must use your Claude subscription sign-in. API-key and cloud-provider billing are not enabled in Lounge.');
  return { subscriptionType: status.subscriptionType || 'Claude', authMethod: 'claude.ai' };
}
function assertNativeAccount(account) {
  if (account.apiProvider && account.apiProvider !== 'firstParty') throw new Error('Claude selected another inference backend; the subscription adapter will not continue.');
  if (account.apiKeySource && account.apiKeySource !== 'none') throw new Error('Claude selected API-key authentication; the subscription adapter will not continue.');
}

export class ClaudeCodeAdapter extends EventEmitter {
  constructor({ cwd, binary = findClaude(), sdk = agentSdk, authCheck = claudeSignIn, environment = process.env, desktopLaunch } = {}) {
    super(); this.id = 'claude-code'; this.name = 'Claude Code'; this.roles = ['coordinator', 'worker']; this.billing = 'subscription'; this.canObserve = true;
    this.cwd = cwd; this.binary = binary; this.sdk = sdk; this.authCheck = authCheck; this.env = claudeEnvironment(environment);this.desktopLaunch=desktopLaunch;
    this.ready = false; this.error = null; this.sessions = new Map(); this.pending = new Map(); this.sources = new Map(); this.sourceCache = new Map();
  }
  get configured() { return !!this.binary; }
  async connect() {
    try { this.account = await this.authCheck(this.binary, this.env); this.ready = true; this.error = null; this.emit('connected'); return { ready: true, subscriptionType: this.account.subscriptionType }; }
    catch (error) { this.ready = false; this.error = error.message; throw error; }
  }
  baseOptions(cwd) {
    return { cwd, pathToClaudeCodeExecutable: this.binary, env: this.env, permissionMode: 'default', settingSources: [], strictMcpConfig: true, stderr: () => {} };
  }
  async listModels() {
    await this.connect(); const input = new InputChannel();
    const query = this.sdk.query({ prompt: input, options: { ...this.baseOptions(this.cwd), persistSession: false, tools: [], canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery cannot execute tools.' }) } });
    try {
      assertNativeAccount(await query.accountInfo());
      const models = new Map();
      for (const model of await query.supportedModels()) {
        const id = model.resolvedModel || model.value;
        if (model.value === 'default' || id === 'default' || models.has(id)) continue;
        models.set(id, { id, name: model.displayName, efforts: model.supportedEffortLevels || [], alias: model.value });
      }
      return [...models.values()];
    } catch (error) { this.ready = false; this.error = error.message; throw error; }
    finally { input.close(); query.close(); }
  }
  async openSession(options) {
    await this.connect();
    const id = options.sessionId || randomUUID(), previous = this.sessions.get(id);
    if (previous?.active) throw new Error('This Claude Code session is already working');
    // An allocated UUID is not a persisted native session until init succeeds.
    // Reconcile after restart without trying to resume a session never created.
    const fresh = previous ? previous.fresh : !options.sessionId || !await this.sdk.getSessionInfo(id, { dir: options.cwd });
    this.sessions.set(id, { tools: [], ...options, id, fresh, active: false });
    return { id, model: options.model };
  }
  waitForReply(session, details, signal = session.abort.signal) {
    if (signal.aborted) return Promise.reject(new Error('Claude request interrupted'));
    return new Promise((resolve, reject) => {
      const id = `claude-code:${randomUUID()}`;
      const cancel = () => { this.pending.delete(id); this.emit('event', { providerId: this.id, sessionId: session.id, type: 'request.resolved', requestId: id }); reject(new Error('Claude request interrupted')); };
      this.pending.set(id, { sessionId: session.id, finish: result => { signal.removeEventListener('abort', cancel); resolve(result); } });
      signal.addEventListener('abort', cancel, { once: true });
      this.emit('request', { providerId: this.id, sessionId: session.id, id, blocking: true, ...details });
    });
  }
  toolServer(session) {
    const tools = session.tools.map(definition => {
      const schema = z.fromJSONSchema(definition.inputSchema);
      return this.sdk.tool(definition.name, definition.description, schema.shape, async args => {
        const result = await this.waitForReply(session, { kind: 'tool', tool: definition.name, args, questions: [] });
        return { content: [{ type: 'text', text: result.text }], isError: result.success === false };
      });
    });
    return this.sdk.createSdkMcpServer({ name: 'lounge', version: '1.0.0', tools, timeout: 24 * 60 * 60 * 1000 });
  }
  async permission(session, toolName, input, options) {
    if (toolName.startsWith('mcp__lounge__') && options.mcpServer?.source === 'sdk') return { behavior: 'allow', updatedInput: input };
    if (session.readOnly) return { behavior: 'deny', message: 'The coordinator can use only its Lounge tools.' };
    if (input.dangerouslyDisableSandbox || (options.blockedPath && !withinWorkspace(options.blockedPath, session.cwd))) return { behavior: 'deny', message: 'This task has no permission to expand its workspace or disable its sandbox.' };
    if (toolName === 'AskUserQuestion') {
      const questions = (input.questions || []).map((q, index) => ({ ...q, id: `q${index}` }));
      const result = await this.waitForReply(session, { kind: 'question', question: questions.map(q => q.question).join('\n\n'), context: '', questions, nativeInput: input }, options.signal);
      return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map(q => [q.question, result.answers[q.id]])) } };
    }
    const result = await this.waitForReply(session, { kind: 'approval', question: options.title || `Claude Code wants to use ${toolName}`, context: JSON.stringify({ tool: toolName, input }, null, 2), questions: [] }, options.signal);
    if (result.decision === 'cancel') session.interrupted = true;
    return result.decision === 'accept' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Boyd declined this action.', interrupt: result.decision === 'cancel' };
  }
  guard(session, input) {
    const name = input.tool_name, args = input.tool_input || {};
    let reason;
    if (session.readOnly && name !== 'StructuredOutput' && !session.tools.some(t => name === `mcp__lounge__${t.name}`)) reason = 'The coordinator can use only its Lounge tools.';
    if (['Write', 'Edit', 'NotebookEdit'].includes(name) && !withinWorkspace(args.file_path || args.notebook_path, session.cwd)) reason = 'Writes must stay in the reserved project workspace.';
    if (name === 'Bash' && (args.dangerouslyDisableSandbox || args.run_in_background)) reason = 'This task cannot disable its sandbox or launch detached commands.';
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  }
  async startTurn({ sessionId, text, model, effort, outputSchema }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.active) throw new Error('The Claude Code session is unavailable or already running');
    session.active = true; session.interrupted = false; session.abort = new AbortController(); session.input = new InputChannel(); session.turnId = randomUUID();
    session.run = this.run(session, { text, model, effort, outputSchema }).catch(() => {
      const interrupted = session.interrupted;
      session.abort.abort(); session.input.close();
      try { session.query?.close(); } catch {}
      session.query = null;
      this.finish(session, interrupted ? 'interrupted' : 'failed', interrupted ? null : 'Claude Code could not complete this turn. Check its sign-in, model availability, and native permission settings.');
    });
    return { id: session.turnId };
  }
  async run(session, { text, model, effort, outputSchema }) {
    const prefix = 'Your application tools are exposed as mcp__lounge__<tool name>. Use their full names. Never start a detached process or spawn subagents.\n';
    const options = {
      ...this.baseOptions(session.cwd), abortController: session.abort, persistSession: !session.ephemeral,
      ...(session.fresh ? { sessionId: session.id } : { resume: session.id }),
      systemPrompt: session.readOnly ? prefix + session.instructions : { type: 'preset', preset: 'claude_code', append: prefix + session.instructions },
      tools: session.readOnly ? [] : WORKER_TOOLS,
      mcpServers: session.tools.length ? { lounge: this.toolServer(session) } : {},
      allowedTools: session.tools.map(t => `mcp__lounge__${t.name}`),
      canUseTool: (name, input, context) => this.permission(session, name, input, context),
      hooks: { PreToolUse: [{ hooks: [async input => this.guard(session, input)] }] },
      includePartialMessages: true, maxTurns: 120,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(outputSchema ? { outputFormat: { type: 'json_schema', schema: outputSchema } } : {}),
      ...(!session.readOnly ? { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [session.cwd], denyRead: [join(homedir(), '.ssh'), join(homedir(), '.codex/auth.json'), join(homedir(), '.claude/.credentials.json'), join(this.cwd, '.env.local')] } } } : {}),
    };
    const query = this.sdk.query({ prompt: session.input, options }); session.query = query;
    try {
      assertNativeAccount(await query.accountInfo());
      if (session.abort.signal.aborted) return this.finish(session, 'interrupted');
      const history = session.fresh && session.sessionId ? (session.history || []).filter(m => m.role === 'user' || (m.role === 'agent' && m.phase === 'final_answer')).slice(-12).map(m => ({ role: m.role, text: String(m.text).slice(0, 6000) })) : [];
      const content = history.length ? JSON.stringify({ restoredVisibleHistory: history, userInstruction: text }) : text;
      session.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: session.id, uuid: session.turnId });
      for await (const message of query) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id !== session.id) throw new Error('Claude returned another session identity');
          session.fresh = false;
          if (!session.ephemeral && session.title) await this.sdk.renameSession(session.id, session.title, { dir: session.cwd }).catch(() => {});
        }
        if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') this.emit('event', { providerId: this.id, sessionId: session.id, type: 'text.delta', text: message.event.delta.text });
        if (message.type === 'assistant') {
          const text = textOf(message.message);
          if (text) this.emit('event', { providerId: this.id, sessionId: session.id, type: 'message', phase: 'commentary', text });
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) return this.finish(session, session.abort.signal.aborted ? 'interrupted' : 'failed', `Claude Code stopped: ${message.startup_failure_reason || message.terminal_reason || message.subtype}. No alternate provider was used.`);
          const final = outputSchema && message.structured_output !== undefined ? JSON.stringify(message.structured_output) : message.result;
          this.emit('event', { providerId: this.id, sessionId: session.id, type: 'message', phase: 'final_answer', text: final || 'Claude returned no final text.' });
          this.finish(session, 'completed'); return;
        }
      }
      this.finish(session, session.abort.signal.aborted ? 'interrupted' : 'failed', 'The Claude session ended without a completion result.');
    } finally { session.abort.abort(); session.input.close(); query.close(); session.query = null; }
  }
  finish(session, status, error = null) {
    if (!session.active) return;
    session.active = false;
    this.emit('event', { providerId: this.id, sessionId: session.id, type: 'turn.ended', status, error });
  }
  respond(request, result) {
    const pending = this.pending.get(request.id);
    if (!pending || pending.sessionId !== request.sessionId) throw new Error('This Claude request has expired');
    this.pending.delete(request.id); pending.finish(result);
  }
  reject(request, message) { this.respond(request, { text: message, success: false, decision: 'decline' }); }
  async interrupt(sessionId, turnId) {
    const session = this.sessions.get(sessionId);
    if (!session?.active || (turnId && session.turnId !== turnId)) throw new Error('No matching Claude turn to interrupt');
    session.interrupted = true; session.abort.abort(); session.input.close(); session.query?.close();
    await session.run;
  }
  async release(sessionId) { const session = this.sessions.get(sessionId); if (session?.active) await this.interrupt(sessionId); this.sessions.delete(sessionId); }
  async handoff(sessionId,{cwd}) {
    const session=this.sessions.get(sessionId);
    if(session?.active)throw new Error('Wait for Claude Code to finish.');
    await session?.run;
    if(!await this.sdk.getSessionInfo(sessionId,{dir:cwd}))throw new Error('The native session has not been saved yet.');
    await this.release(sessionId);
  }
  async openDesktop(sessionId,{cwd}) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))return false;
    await this.connect();
    // The subscription CLI owns the documented native handoff. No source UI
    // scripting, terminal prompt, shell interpolation or permission bypass.
    try {
      if(!this.desktopLaunch)return false;
      return !!(await this.desktopLaunch({sessionId,cwd,binary:this.binary})).opened;
    } catch {return false;} // Keep released ownership and offer /resume manually.
  }
  close() { for (const session of this.sessions.values()) { session.abort?.abort(); session.input?.close(); session.query?.close(); } }
  async discover(cursor, searchTerm, { projects = [] } = {}) {
    const sessions = new Map();
    for (const directory of new Set(projects.map(p => p.path))) for (const source of await this.sdk.listSessions({ dir: directory })) {
      if (!source.cwd || !withinWorkspace(source.cwd, directory)) continue;
      const title = source.customTitle || source.summary || source.firstPrompt || 'Untitled Claude Code session';
      if (searchTerm && !`${title} ${source.firstPrompt || ''}`.toLowerCase().includes(searchTerm.toLowerCase())) continue;
      const item = { id: source.sessionId, title, preview: String(source.firstPrompt || source.summary || '').slice(0, 400), cwd: source.cwd, updatedAt: new Date(source.lastModified).toISOString(), application: this.id, provider: this.id };
      sessions.set(item.id, item); this.sources.set(item.id, item);
    }
    const offset = Number(cursor || 0);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid session cursor');
    const rows = [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { data: rows.slice(offset, offset + 30), nextCursor: rows.length > offset + 30 ? String(offset + 30) : null };
  }
  async readSource(id, { cwd } = {}) {
    const directory = cwd || this.sources.get(id)?.cwd;
    if (!directory) throw new Error('Find this Claude Code session in a registered workspace before importing it');
    const info = await this.sdk.getSessionInfo(id, { dir: directory });
    if (!info) throw new Error('This Claude Code source session is unavailable');
    const source = { id, title: info.customTitle || info.summary || info.firstPrompt || 'Untitled Claude Code session', preview: String(info.firstPrompt || info.summary || '').slice(0, 5000), cwd: info.cwd || directory, updatedAt: new Date(info.lastModified).toISOString(), application: this.id, provider: this.id };
    this.sources.set(id, source); return source;
  }
  async sourceHistory(id, { cwd } = {}) {
    const source = await this.readSource(id, { cwd }), cached = this.sourceCache.get(id);
    if (cached?.updatedAt === source.updatedAt) return cached.history;
    const messages = await this.sdk.getSessionMessages(id, { dir: source.cwd });
    const entries = messages.filter(m => !m.parent_tool_use_id && ['user', 'assistant'].includes(m.type)).map(m => ({ id: m.uuid, role: m.type === 'user' ? 'user' : 'agent', text: textOf(m.message).slice(0, 3500) })).filter(m => m.text).slice(-8);
    const history = { entries, latest: { id: entries.at(-1)?.id || null, status: 'unknown', summary: entries.findLast(m => m.role === 'agent')?.text || '' } };
    this.sourceCache.set(id, { updatedAt: source.updatedAt, history }); return history;
  }
}
