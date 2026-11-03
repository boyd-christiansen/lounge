import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { Store, now } from './lib/store.mjs';
import { Codex } from './lib/codex.mjs';
import { Engine } from './lib/engine.mjs';
import { Speech } from './lib/speech.mjs';
import { mergeRotationOrder } from './public/rotation.js';
import { Providers } from './lib/providers.mjs';
import { CodexAdapter } from './lib/adapters/codex.mjs';
import { LocalAdapter } from './lib/adapters/local.mjs';
import { portableSnapshot } from './lib/portable.mjs';
import { ClaudeCodeAdapter } from './lib/adapters/claude-code.mjs';
import {NativeDesktop} from './lib/desktop/native.mjs';
import {ClaudeDesktopDriver} from './lib/desktop/claude.mjs';
import {DesktopAdapter} from './lib/adapters/desktop.mjs';
import {acquireInstance} from './lib/instance.mjs';

const root = dirname(fileURLToPath(import.meta.url));
// The onboarding CLI writes this ignored file; runtime uses the API directly.
// Load internally without printing its contents or putting credentials in args.
const envPath = process.env.LOUNGE_ENV_FILE || resolve(root, '.env.local');
if (existsSync(envPath)) loadEnvFile(envPath);
const port = Number(process.env.PORT || 4317);
const dbPath=process.env.LOUNGE_DB||resolve(root,'data/lounge.sqlite');
const releaseInstance=acquireInstance(dbPath+'.lock');
const workspace=process.env.LOUNGE_WORKSPACE||root;
const store = new Store(dbPath);
const codex = new Codex({ cwd: workspace });
const local = new LocalAdapter(store.getMeta('localEndpoint', ''));
const native=new NativeDesktop(root),desktop=new DesktopAdapter(native,new ClaudeDesktopDriver(native));
const claude = new ClaudeCodeAdapter({ cwd: workspace,desktopLaunch:params=>native.call('openClaudeCode',params) });
await desktop.check().catch(()=>{});
if(store.getMeta('desktopEnabled',false)&&desktop.permission)await desktop.connect().catch(()=>{});
const engine = new Engine(store, codex, workspace, { providers: new Providers([new CodexAdapter(codex), claude, local,desktop]) });
const speech = new Speech();
await speech.initialize().catch(() => {});
const clients = new Set();
const token = randomBytes(32).toString('hex');
const mime = { '.svg':'image/svg+xml', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function broadcast(type, data) { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
engine.on('change', () => broadcast('state', { ...engine.state(), speech: speech.state() }));
engine.on('delta', data => broadcast('delta', data));
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 250000) throw Object.assign(new Error('Request too large'), { status: 413 }); }
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (req, res) => {
  // Loopback only, strict Host/Origin checks, and a same-origin CSRF capability.
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return send(res, 403, { error: 'Cross-origin requests are not allowed' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site requests are not allowed' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...engine.state(), speech: speech.state(), token });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify({ ...engine.state(), speech: speech.state() })}\n\n`); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) return send(res, 200, store.history(url.pathname.split('/').pop()));
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-lounge-token'] !== token) return send(res, 403, { error: 'Refresh this tab to reconnect securely' });
      const b = await body(req);
      if (url.pathname === '/api/voice/connect') { const result = await speech.connect(b.key); engine.changed(); return send(res, 200, result); }
      if (url.pathname === '/api/voice/refresh') { const result = await speech.initialize(); engine.changed(); return send(res, 200, result); }
      if (url.pathname === '/api/voice/disconnect') { const result = speech.disconnect(); engine.changed(); return send(res, 200, result); }
      if (url.pathname === '/api/voice/speak') {
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        let audio;try{audio=await speech.cachedGenerate(b);}catch(error){engine.changed();throw error;}
        if(abort.signal.aborted)return;
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }); return res.end(audio);
      }
      if (url.pathname === '/api/connect') return send(res, 200, await engine.connect(b.provider || 'codex'));
      if(url.pathname==='/api/desktop/status'){await desktop.check();engine.changed();return send(res,200,desktop.state());}
      if(url.pathname==='/api/desktop/connect'){const result=await desktop.connect();store.setMeta('desktopEnabled',true);engine.changed();return send(res,200,result);}
      if(url.pathname==='/api/desktop/disconnect'){store.setMeta('desktopEnabled',false);const result=await desktop.disconnect();engine.changed();return send(res,200,result);}
      if(url.pathname==='/api/desktop/permission'){const result=await desktop.requestPermission();engine.changed();return send(res,200,result);}
      if(url.pathname==='/api/desktop/preview')return send(res,200,await desktop.previewCurrent(b.application||'claude-chat'));
      if (url.pathname === '/api/discover') return send(res, 200, await engine.discover(b.cursor, b.searchTerm, b.application || 'codex'));
      if (url.pathname === '/api/import') return send(res, 200, await engine.importThread(b.threadId, b.application || 'codex'));
      if (url.pathname === '/api/projects') return send(res, 200, engine.addProject(b));
      if (url.pathname === '/api/profile') return send(res, 200, engine.saveProfile(b));
      if (url.pathname === '/api/models') return send(res, 200, await engine.models());
      if (url.pathname === '/api/inference') return send(res, 200, await engine.setInference(b));
      if (url.pathname === '/api/context') return send(res, 200, engine.context(b));
      if (url.pathname === '/api/export') return send(res, 200, portableSnapshot(store));
      if (url.pathname === '/api/local/connect') {
        const previous = local.endpoint;
        try { local.configure(b.url); await local.connect(); }
        catch (error) { local.configure(previous); throw error; }
        engine.providers.catalogs.delete('local');
        store.setMeta('localEndpoint', local.endpoint); engine.changed();
        return send(res, 200, await engine.models());
      }
      if (url.pathname === '/api/rotation') return send(res, 200, engine.setRotation(b.mode));
      if(url.pathname==='/api/order/chats')return send(res,200,engine.orderChats(b.projectKey,b.ids,b.revision));
      if(url.pathname==='/api/order/projects')return send(res,200,engine.orderProjects(b.keys,b.revision));
      if (url.pathname === '/api/order') {
        const state = engine.state();
        const ids = Array.isArray(b.ids) && b.ids.length ? mergeRotationOrder(state.tasks, b.ids, state.rotationMode) : b.ids;
        const result = store.reorder(ids, b.revision); engine.changed(); return send(res, 200, result);
      }
      if (url.pathname === '/api/session/refresh') { engine.refreshLoaded().catch(()=>{}); return send(res, 200, {...engine.state(),refreshing:true}); }
      if (url.pathname === '/api/migration/preview') return send(res,200,await engine.migration.preview(b));
      if (url.pathname === '/api/migration/confirm') return send(res,200,engine.migration.confirm(b));
      if (url.pathname === '/api/migration/handoff') return send(res,200,await engine.migration.handoff(b.taskId));
      if (url.pathname === '/api/brief') return send(res, 200, await engine.brief(b.taskId));
      if (url.pathname === '/api/login') return send(res, 200, await engine.providers.adapter('codex').login());
      if (url.pathname === '/api/conductor') {
        const prior = store.receipt(b.commandId);
        if (prior) return send(res, 200, prior);
        store.once(b.commandId, () => ({ accepted: true, kind: 'conductor' }));
        return send(res, 200, await engine.conductor(b.text, { taskId: b.taskId, requestId: b.requestId, briefKey:b.briefKey }));
      }
      if (url.pathname === '/api/capture') {
        const t = store.once(b.commandId, () => engine.capture(b)); engine.changed(); return send(res, 200, t);
      }
      if (url.pathname === '/api/settings') {
        if (!Number.isInteger(b.parallelLimit) || b.parallelLimit < 1 || b.parallelLimit > 8) throw new Error('Choose 1–8 parallel slots');
        store.setMeta('settings', { ...store.getMeta('settings'), parallelLimit: b.parallelLimit }); engine.changed(); return send(res, 200, engine.state());
      }
      const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(\w+)$/);
      if (m) {
        const [, id, action] = m; let result;
        if (action === 'dispatch' || action === 'answer') {
          const prior = store.receipt(b.commandId);
          if (prior) {
            if (prior.taskId !== id || prior.kind !== action) throw new Error('Command ID belongs to another operation');
            return send(res, 200, store.get(id));
          }
          store.once(b.commandId, () => ({ taskId: id, kind: action, accepted: true }));
          result = action === 'dispatch' ? await engine.dispatch(id, b.text) : await engine.answer(id, b.requestId, b);
        }
        else if (action === 'sourceModels') result = await engine.sourceModels(id);
        else if (action === 'sourceModel') result = await engine.setSourceModel(id,b);
        else if (action === 'watch') result = await engine.resumeSource(id);
        else if (action === 'reveal') result = await desktop.revealSource(store.get(id));
        else if (action === 'interrupt') result = await engine.interrupt(id);
        else if (action === 'presented') result = engine.presented(id);
        else if (action === 'clear') result = engine.clear(id);
        else if (action === 'restore') result = engine.restore(id);
        else if (action === 'classify') result = engine.classify(id, b.personal, b.scope);
        else if (action === 'application') result = engine.setApplication(id, b.application);
        else if (action === 'snooze') result = engine.defer(id, b.hours);
        else if (action === 'wake') result = engine.wake(id);
        else if (action === 'refresh') result = await engine.refreshSource(id);
        else if (action === 'update') {
          result = store.once(b.commandId, () => {
            const t = store.get(id), patch = {};
            for (const k of ['priority', 'dueAt', 'pin']) if (k in b.patch) patch[k] = b.patch[k];
            if (t.external && 'sourceProjectName' in b.patch) patch.sourceProjectName = String(b.patch.sourceProjectName).slice(0, 100);
            if (b.patch.status) {
              if (!['done', 'queued', 'snoozed', 'review'].includes(b.patch.status)) throw new Error('Use task controls to change execution state');
              if (['running', 'waiting'].includes(t.status) || t.pending.length) throw new Error('Finish or interrupt the active turn first');
              patch.status = b.patch.status; patch.attendedAt = now();
              if (patch.status === 'snoozed') { if (!b.patch.snoozedUntil || Date.parse(b.patch.snoozedUntil) <= Date.now()) throw new Error('Choose a future resurface time'); patch.snoozedUntil = b.patch.snoozedUntil; patch.resumeStatus = t.status === 'snoozed' ? t.resumeStatus || 'queued' : t.status; }
            }
            const out = store.update(id, patch, b.revision); store.event(id, 'user_updated', patch); return out;
          }); engine.changed();
        } else throw Object.assign(new Error('Unknown operation'), { status: 404 });
        return send(res, 200, result);
      }
      throw Object.assign(new Error('Unknown endpoint'), { status: 404 });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const path = resolve(root, 'public', url.pathname === '/' ? 'index.html' : '.' + url.pathname);
    if (!path.startsWith(resolve(root, 'public') + '/') || !existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(path));
  } catch (error) { send(res, error.status || 400, { error: error.message }); }
});
const ping = setInterval(() => { for (const res of clients) res.write(': keepalive\n\n'); }, 20000);
let polling = false;
const sourcePoll = setInterval(async () => {
  if (store.all().some(t => t.status === 'snoozed' && Date.parse(t.snoozedUntil) <= Date.now())) engine.changed();
  if (polling) return;
  polling = true;
  try {
    const sources = store.all().filter(t => t.external && t.threadId && (desktop.canControl(t)||engine.providers.adapters.get(t.provider)?.canObserve && engine.providers.adapters.get(t.provider)?.ready) && !['done', 'snoozed'].includes(t.status));
    for (const t of sources) { const interval=['running','waiting'].includes(t.status)?5000:30000;if(Date.now()-Date.parse(t.sourceObservedAt || 0)<interval)continue;try { await engine.refreshSource(t.id); } catch {} }
    // Wake due snoozed items even if no browser is open.
    store.snapshot();
  } finally { polling = false; }
}, 5000);
server.listen(port, '127.0.0.1', () => {if(process.env.LOUNGE_DESKTOP_HOST==='1')process.stdout.write(JSON.stringify({kind:'server.ready',port})+'\n');else console.log(`Command Lounge is ready at http://127.0.0.1:${port}`);});
server.on('error',()=>{engine.close();store.close();releaseInstance();process.stderr.write('Lounge could not reserve its loopback port. Close any other instance.\n');process.exit(1);});
let closing=false;
function close() { if(closing)return;closing=true;clearInterval(ping); clearInterval(sourcePoll); engine.close(); for (const res of clients) res.end(); server.close(() => { store.close();releaseInstance(); process.exit(0); }); }
if(process.env.LOUNGE_DESKTOP_HOST==='1')native.on('disconnected',close);
process.on('SIGTERM', close); process.on('SIGINT', close);
