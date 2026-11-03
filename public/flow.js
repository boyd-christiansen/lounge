import { rotationTasks } from './rotation.js';
import { applicationFor, applicationInfo, validSourceUrl } from './applications.js';

export function fingerprint(task) {
  return JSON.stringify([task.id, task.status, task.sourceTurnId || null, task.pending?.map(p => p.id), task.summary || '', task.resurfacedAt || null]);
}
export function pickNext(tasks, seen = {}, mode = 'all') {
  const candidates = rotationTasks(tasks, mode).filter(t => t.status !== 'running');
  return candidates.find(t => seen[t.id] !== fingerprint(t)) || null;
}
export function sourceUrl(task) {
  const application = applicationFor(task);
  if (task.sourceUrl) { try { return validSourceUrl(application, task.sourceUrl); } catch {} }
  const id = task.conversationId || task.threadId;
  if (application === 'claude-code' || application === 'hermes') return null;
  if (!id) return task.external ? applicationInfo(application).home : null;
  if (application === 'chatgpt') return `https://chatgpt.com/c/${encodeURIComponent(id)}`;
  if (application === 'claude-chat' || application === 'claude-cowork') return `https://claude.ai/chat/${encodeURIComponent(id)}`;
  return `codex://threads/${encodeURIComponent(id)}`;
}
export function isDictationCommit({ inputType, insertedLength = 0, isComposing = false, pasted = false, manualKeyRecent = false }) {
  if (isComposing) return false;
  if (pasted || inputType === 'insertFromPaste') return true;
  if (manualKeyRecent) return false;
  return ['insertReplacementText', 'insertText'].includes(inputType) && insertedLength > 1;
}
export function parseScene(text) {
  try { const scene = JSON.parse(text); if (typeof scene.title === 'string' && typeof scene.body === 'string') return normalizeScene(scene); } catch {}
  return { title: 'Here’s where things stand.', body: text, spoken: text, needsReply: /\?\s*$/.test(text), advance: false };
}
export function normalizeScene(scene) {
  if (scene.title?.trim()) return scene;
  const body = String(scene.body || '').trim();
  if (body && body.length <= 100) return { ...scene, title: body, body: '', spoken: scene.spoken || body };
  return { ...scene, title: 'Here’s where things stand.' };
}
export function assertDraftTarget(binding, task) {
  if (binding.taskId !== (task?.id || null) || binding.requestId !== (task?.pending?.[0]?.id || null)) throw new Error('The question changed while you were thinking. Your thought is saved. Pick this task again before sending.');
}

export function plainText(text = '') {
  return String(text).replace(/```[\s\S]*?```/g, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}
export function queuePreview(task) {
  return { overview: plainText(task.overview || '').slice(0, 400), status: plainText(task.pending?.[0]?.question || task.statusText || '').slice(0, 300) };
}

// A deliberately small, escaped Markdown renderer. No embedded HTML or scripts.
export function renderMarkdown(text = '') {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const inline = s => {
    const tokens = [];
    let value = String(s).replace(/`([^`]+)`/g, (_, code) => { tokens.push(`<code>${esc(code)}</code>`); return `\u0000${tokens.length-1}\u0000`; });
    value = esc(value).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|codex:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return value.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[n] || '');
  };
  const lines = String(text).split('\n'), out = []; let i = 0;
  const isBlock = line => /^(?:\s*$|```|#{1,6} |\s*[-*+] |\s*\d+[.)] |>)\s*/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) { const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue; }
    if (/^#{1,6} /.test(line)) { out.push(`<h3>${inline(line.replace(/^#{1,6} /, ''))}</h3>`); i++; continue; }
    if (/^>/.test(line)) { const quote = []; while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); continue; }
    const list = line.match(/^\s*(?:([-*+]) |(\d+)[.)] )(.*)$/);
    if (list) { const tag = list[2] ? 'ol' : 'ul', items = []; while (i < lines.length) { const item = lines[i].match(tag === 'ol' ? /^\s*\d+[.)] (.*)$/ : /^\s*[-*+] (.*)$/); if (!item) break; items.push(`<li>${inline(item[1])}</li>`); i++; } out.push(`<${tag}>${items.join('')}</${tag}>`); continue; }
    const paragraph = [line]; i++; while (i < lines.length && !isBlock(lines[i])) paragraph.push(lines[i++]);
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('');
}

export function briefingNarration(scene, task, {name='', first=false, next=false, returning=false}={}) {
  const hello=name?.trim()?`Hey ${name.trim()}`:'Hello';
  const lead=returning?`${first?`${hello}. `:''}Back to ${task?.title||'this task'}.`:first?`${hello}, here’s your first task.`:next?'Here’s your next task.':'';
  return [lead, returning?null:task?.title, plainText(scene.spoken || scene.body)].filter(Boolean).join(' ');
}
export function canRefocus({busy=false,recording=false,pendingConductor=false,text='',answers=[]}={}) {
  return !busy&&!recording&&!pendingConductor&&!text.trim()&&!answers.some(value=>String(value || '').trim());
}
export function acceptsRoomPaste({inDrawer=false,editable=false,thought=false}={}) {
  return !inDrawer&&(!editable||thought);
}

export function taskBrief(scene,task){
  if(!task?.briefedAt||(!scene.resumeBody&&!scene.resumeSpoken))return scene;
  return {...scene,returning:true,body:scene.resumeBody || scene.body,spoken:scene.resumeSpoken || scene.spoken};
}

// Entry choices are navigation, never authorization to dispatch an agent.
export function entryScene(name = '', mode = 'greeting') {
  if (mode === 'add') return { entry: 'add', title: 'A new task.', body: '', spoken: 'What would you like to work on? Tell me the whole thought.', needsReply: true, advance: false };
  if (mode === 'find') return { entry: 'find', title: 'Find a conversation.', body: '', spoken: 'Which conversation should we find? Tell me the topic and where you were working.', needsReply: true, advance: false };
  const hello = name.trim() ? `Hello ${name.trim()}` : 'Hello';
  return { entry: 'greeting', title: `${hello}.`, body: '', spoken: name.trim() ? `Hello ${name.trim()}, what’s on your mind?` : 'Hello, what’s on your mind?', needsReply: true, advance: false };
}
export function entryIntent(text = '') {
  const words = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/^hey[, ]+/, '').replace(/^(?:please |let[’']s )/, '').replace(/ please$/, '');
  if (/^(?:start|begin|work through|go through|resume)(?: the| my)? queue$/.test(words)) return 'queue';
  if (/^(?:add|start|create)(?: a)?(?: new)? task$/.test(words)) return 'add';
  if (/^(?:find|import|bring in) (?:an? )?(?:existing )?(?:chat|conversation)$/.test(words)) return 'find';
  return null;
}
export function maySurfaceQueue({ session = false, queueStarted = false, busy = false, pendingConductor = false } = {}) {
  return session && queueStarted && !busy && !pendingConductor;
}
