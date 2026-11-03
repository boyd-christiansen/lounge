import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectIdentity } from '../public/rotation.js';
import { applicationInfo, applicationFor, validSourceUrl } from '../public/applications.js';

export const STATES = ['queued', 'running', 'waiting', 'review', 'done', 'snoozed', 'paused', 'error'];
export const PRIORITIES = ['critical', 'high', 'normal', 'low'];
export const now = () => new Date().toISOString();
export function rank(task, at = Date.now()) {
  const age = Math.max(0, (at - Date.parse(task.attendedAt || task.createdAt)) / 86400000);
  const due = task.dueAt ? (Date.parse(task.dueAt) - at) / 86400000 : Infinity;
  // Age can break ties within a priority band, never outrank an urgent obligation.
  return (4 - PRIORITIES.indexOf(task.priority)) * 1000
    + (due < 0 ? 500 : due < 1 ? 400 : due < 3 ? 300 : 0)
    + Math.min(age * 8, 180) + (task.status === 'waiting' ? 100 : 0)
    + (task.status === 'review' ? 60 : 0) + (task.pin ? 200 : 0);
}
export function attentionReason(t, at = Date.now()) {
  if (t.status === 'waiting') return 'Your answer unblocks this work';
  if (t.status === 'review') return 'A result is ready for your review';
  if (t.status === 'error') return 'This task needs recovery';
  if (t.status === 'paused') return 'This task paused and needs a next step';
  if (t.dueAt && Date.parse(t.dueAt) < at) return 'Past the due date you set';
  if (t.dueAt && Date.parse(t.dueAt) - at < 3 * 86400000) return 'Due soon';
  const days = Math.floor((at - Date.parse(t.attendedAt || t.createdAt)) / 86400000);
  if (days >= 7) return `Resurfaced after ${days} days without attention`;
  if (t.priority === 'critical' || t.priority === 'high') return 'A priority you set';
  return 'Ready for the next step';
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT data FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.data) : fallback;
  }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  event(taskId, kind, data = {}) {
    this.db.prepare('INSERT INTO events (at,task_id,kind,data) VALUES (?,?,?,?)').run(now(), taskId, kind, JSON.stringify(data));
  }
  history(taskId) {
    return this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY seq DESC LIMIT 80').all(taskId).map(e => ({ ...e, data: JSON.parse(e.data) }));
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Task not found'), { status: 404 });
    return JSON.parse(row.data);
  }
  all() { return this.db.prepare('SELECT data FROM tasks').all().map(r => JSON.parse(r.data)); }
  save(t) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(t.id, JSON.stringify(t)); return t; }
  create(input) {
    const timestamp = now();
    if (input.provider && !['codex', 'claude', 'claude-code', 'chatgpt', 'claude-chat', 'claude-cowork', 'hermes'].includes(input.provider)) throw new Error('Unknown provider');
    const application = input.application || applicationFor({ provider: input.provider || 'codex', external: input.external });
    const app = applicationInfo(application);
    const t = { id: randomUUID(), title: String(input.title || '').trim().slice(0, 220),
      projectId: input.projectId || 'inbox', provider: app.adapterId || app.id, application, priority: input.priority || 'normal',
      personal: input.personal ?? null,
      status: 'queued', brief: String(input.brief || ''), summary: '', messages: [], pending: [], artifacts: [],
      createdAt: timestamp, updatedAt: timestamp, attendedAt: timestamp, dueAt: input.dueAt || null,
      snoozedUntil: null, pin: false, threadId: null, turnId: null, external: !app.adapterId || !!input.external, revision: 1,
      ...(input.sourceUrl ? { sourceUrl: validSourceUrl(application, input.sourceUrl) } : {}) };
    if (!t.title) throw new Error('Give the task a title');
    if (t.personal !== null && typeof t.personal !== 'boolean') throw new Error('Personal classification must be true or false');
    if (!PRIORITIES.includes(t.priority)) throw new Error('Invalid priority');
    if (t.dueAt && !Number.isFinite(Date.parse(t.dueAt))) throw new Error('Invalid due date');
    this.save(t); this.event(t.id, 'created', { title: t.title }); return t;
  }
  update(id, patch, expectedRevision) {
    const t = this.get(id);
    if (expectedRevision != null && t.revision !== expectedRevision) throw Object.assign(new Error('This task changed. Refresh and try again.'), { status: 409 });
    if (patch.status && !STATES.includes(patch.status)) throw new Error('Invalid state');
    if (patch.priority && !PRIORITIES.includes(patch.priority)) throw new Error('Invalid priority');
    if ('personal' in patch && patch.personal !== null && typeof patch.personal !== 'boolean') throw new Error('Personal classification must be true or false');
    for (const key of ['dueAt', 'snoozedUntil']) if (patch[key] && !Number.isFinite(Date.parse(patch[key]))) throw new Error('Invalid date');
    const result = { ...t, ...patch, id, revision: t.revision + 1, updatedAt: now() };
    this.save(result); return result;
  }
  once(id, action) {
    if (!id || typeof id !== 'string' || id.length > 150) throw new Error('A valid command ID is required');
    const row = this.db.prepare('SELECT data FROM receipts WHERE id=?').get(id);
    if (row) return JSON.parse(row.data);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (result instanceof Promise) throw new Error('Receipt transactions must be synchronous');
      this.db.prepare('INSERT INTO receipts VALUES (?,?)').run(id, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  receipt(id) {
    const r = this.db.prepare('SELECT data FROM receipts WHERE id=?').get(id);
    return r ? JSON.parse(r.data) : null;
  }
  reorder(ids, expectedRevision) {
    const revision = this.getMeta('orderRevision', 0);
    if (expectedRevision !== revision) throw Object.assign(new Error('The queue order changed. Try the move again.'), { status: 409 });
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Invalid queue order');
    const valid = new Set(this.all().filter(t => !t.isConductor && t.status !== 'done').map(t => t.id));
    if (ids.some(id => !valid.has(id))) throw new Error('A task in this order is no longer in the queue');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setMeta('queueOrder', ids); this.setMeta('orderRevision', revision + 1);
      this.event(null, 'queue_reordered', { ids }); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ids, revision: revision + 1 };
  }
  reorderProjects(keys, expectedRevision) {
    const revision = this.getMeta('projectOrderRevision', 0);
    if(expectedRevision !== revision) throw Object.assign(new Error('Project priorities changed. Try the move again.'), {status:409});
    const projects=this.getMeta('projects',[]),valid=new Set(this.all().filter(t=>!t.isConductor&&t.status!=='done').map(t=>projectIdentity(t,projects).key));
    if(!Array.isArray(keys)||new Set(keys).size!==keys.length||keys.some(key=>typeof key!=='string'||!valid.has(key))) throw new Error('Choose projects currently in the queue');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setMeta('projectOrder',keys);this.setMeta('projectOrderRevision',revision+1);this.event(null,'projects_reordered',{keys});this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return {keys,revision:revision+1};
  }
  snapshot() {
    const at = Date.now();
    for (const t of this.all()) if (t.status === 'snoozed' && Date.parse(t.snoozedUntil) <= at) {
      this.update(t.id, { status: t.resumeStatus && t.resumeStatus !== 'snoozed' ? t.resumeStatus : 'queued', resumeStatus: null, snoozedUntil: null, resurfacedAt: now() });
      this.event(t.id, 'resurfaced');
    }
    const order = new Map(this.getMeta('queueOrder', []).map((id, i) => [id, i]));
    return this.all().map(t => ({ ...t, score: rank(t, at), reason: attentionReason(t, at), stale: at - Date.parse(t.attendedAt) >= 7 * 86400000 }))
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || b.score - a.score || a.createdAt.localeCompare(b.createdAt));
  }
  close() { this.db.close(); }
}
