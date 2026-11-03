import { projectIdentity } from '../public/rotation.js';
import { applicationFor } from '../public/applications.js';

// Small task frontiers are shared with the coordinator; complete source
// transcripts remain in the provider session and are retrieved on demand.
export function taskFrontier(task, projects = []) {
  return { id: task.id, title: task.title, application: applicationFor(task), capabilities: task.capabilities, provider: task.provider, external: task.external, status: task.status, threadId: task.threadId, sourceUrl: task.sourceUrl, sourceCwd: task.sourceCwd, project: projectIdentity(task, projects), priority: task.priority, isPersonal: task.isPersonal, overview: task.overview || task.brief.slice(0, 1000), statusText: task.statusText || '', summary: task.summary.slice(0, 2500), pending: task.pending, observedAt: task.sourceObservedAt || task.updatedAt, snoozedUntil: task.snoozedUntil, inference: task.inference || null, continuation:{portable:!!task.portableSession,needsInstruction:!!task.continuationNeedsPrompt,handoff:task.handoff || null,origins:(task.origins || []).map(o=>({application:o.application,title:o.title,threadId:o.threadId,url:o.url,importedAt:o.importedAt}))} };
}

export function projectContext(task, projects, notes) {
  if (!task) return null;
  const project = projectIdentity(task, projects);
  return { ...project, ...(notes[project.key] || { text: '', updatedAt: null }) };
}

export function recentConversation(task) {
  return task.messages.filter(m => m.role === 'user' || m.phase === 'final_answer').slice(-8).map(m => {
    let text = String(m.text);
    try {
      const data = JSON.parse(text);
      if (m.role === 'user' && typeof data.userInstruction === 'string') text = data.userInstruction;
      else if (m.role === 'agent' && typeof data.body === 'string') text = [data.title, data.body].filter(Boolean).join('\n');
    } catch {}
    return { role: m.role, text: text.slice(0, 2500) };
  });
}
