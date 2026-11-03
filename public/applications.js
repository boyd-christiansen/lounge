// Application identity is independent of the model used by the coordinator.
export const APPLICATIONS = [
  { id: 'codex', name: 'Codex', adapterId: 'codex', home: 'https://chatgpt.com/' },
  { id: 'chatgpt', name: 'ChatGPT', adapterId: null, home: 'https://chatgpt.com/' },
  { id: 'claude-code', name: 'Claude Code', adapterId: 'claude-code', home: null },
  { id: 'claude-chat', name: 'Claude chat', adapterId: null, home: 'https://claude.ai/' },
  { id: 'claude-cowork', name: 'Claude Cowork', adapterId: null, home: 'https://claude.ai/' },
  { id: 'hermes', name: 'Hermes', adapterId: 'hermes', home: null },
];
export function applicationFor(task) {
  if (APPLICATIONS.some(a => a.id === task.application)) return task.application;
  if (task.sourceApp === 'chatgpt' || task.provider === 'chatgpt') return 'chatgpt';
  if (task.sourceApp === 'claude' || (task.provider === 'claude' && task.external)) return 'claude-chat';
  if (task.provider === 'claude') return 'claude-code';
  return APPLICATIONS.some(a => a.id === task.provider) ? task.provider : 'codex';
}
export function applicationInfo(taskOrId) {
  const id = typeof taskOrId === 'string' ? taskOrId : applicationFor(taskOrId);
  const application = APPLICATIONS.find(a => a.id === id);
  if (!application) throw new Error('Choose a supported application');
  return application;
}
export function validSourceUrl(application, value) {
  let url; try { url = new URL(value); } catch { throw new Error('Enter a valid source chat link'); }
  const app = applicationInfo(application);
  if (url.username || url.password) throw new Error('Source links cannot contain credentials');
  if (app.id === 'codex' && url.protocol === 'codex:' && url.hostname === 'threads' && /^\/[A-Za-z0-9-]+$/.test(url.pathname)) return url.href;
  const host = app.id === 'chatgpt' ? 'chatgpt.com' : ['claude-chat', 'claude-cowork'].includes(app.id) ? 'claude.ai' : null;
  if (!host || url.protocol !== 'https:' || url.hostname !== host || url.port) throw new Error('That source link belongs to another application');
  return url.href;
}
export function taskCapabilities(task, runtimes = []) {
  const app = applicationInfo(task), runtime = runtimes.find(r => r.id === app.adapterId), managed = !task.external && runtime?.configured !== false && !!runtime?.roles.includes('worker');
  const desktop=runtimes.find(r=>r.id==='desktop');
  const bridged=!!desktop?.ready&&!!desktopSourceUrl(task);
  const controlled=managed||bridged;
  const active = ['running', 'waiting'].includes(task.status);
  const ownership = task.external ? task.threadId || task.sourceUrl ? 'source' : 'handoff' : 'lounge';
  return {
    ownership, managed, bridged, importContinuation:!!task.external&&!active&&!task.pending?.length&&!task.migrationReserved,nativeHandoff:managed&&!!task.portableSession&&!!task.threadId&&!active&&!task.pending?.length&&!task.migrationReserved, connected: bridged||!!runtime?.ready, dispatch: managed && !active && !task.pending?.length&&!task.sourceControlReserved&&!task.migrationReserved, followUp: controlled && !active && !task.pending?.length&&!task.sourceControlReserved&&!task.migrationReserved,
    answer: controlled && !!task.pending?.length && !task.pending[0]?.sourceOnly, interrupt: controlled && active, modelControl: controlled&&(!bridged||!active&&!task.pending?.length&&!task.sourceControlReserved&&!task.migrationReserved),
    observe: !!task.external && (bridged||!!task.threadId&&!!runtime?.canObserve),
    reason: bridged?'Continues in the original Claude app conversation.':ownership === 'source' ? `${app.name} retains this conversation. Review it here and continue in its source.` : ownership === 'handoff' || !app.adapterId ? `${app.name} requires a source-app handoff; no execution bridge is connected.` : !runtime ? `${app.name} is not connected.` : 'Managed by Command Lounge',
  };
}
export function desktopSourceUrl(task){
  if(!task.external||!['claude-chat','claude-cowork'].includes(applicationFor(task)))return null;
  try{const url=new URL(task.sourceUrl||`https://claude.ai/chat/${encodeURIComponent(task.threadId||'')}`);
    if(url.protocol!=='https:'||url.hostname!=='claude.ai'||url.username||url.password||url.port||!/^\/chat\/[A-Za-z0-9-]+\/?$/.test(url.pathname))return null;
    const id=url.pathname.replace(/\/$/,'').split('/').pop();if(task.threadId&&task.threadId!==id)return null;
    return url.origin+url.pathname.replace(/\/$/,'');
  }catch{return null;}
}
