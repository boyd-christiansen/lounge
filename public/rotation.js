// Shared by the server and renderer so the drawer and next-task rotation agree.
export const SORT_MODES=['recent','oldest','priority'];
export function activityTime(task){
  const times=[task.lastActivityAt,task.sourceUpdatedAt,task.messages?.at(-1)?.at].map(Date.parse).filter(Number.isFinite);
  return times.length?Math.max(...times):(Date.parse(task.createdAt)||0);
}
export function compareTasks(a,b,sortMode='recent'){
  if(sortMode==='priority')return (b.score||0)-(a.score||0)||activityTime(a)-activityTime(b)||String(a.id).localeCompare(String(b.id));
  return (sortMode==='oldest'?1:-1)*(activityTime(a)-activityTime(b))||String(a.createdAt||'').localeCompare(String(b.createdAt||''))||String(a.id).localeCompare(String(b.id));
}
export const ROTATION_MODES = ['all', 'work', 'personal'];
export function projectIdentity(task, projects = []) {
  if(!task.external&&task.queueProject?.key&&task.queueProject?.name)return task.queueProject;
  const label = task.external ? task.sourceProjectName?.trim() : '';
  if (label) {
    const project = projects.find(p => p.name === label);
    return { key: project ? `project:${project.id}` : `source-project:${label}`, name: label };
  }
  if (task.external && task.sourceCwd) {
    const project = projects.find(p => p.path === task.sourceCwd && !['inbox', 'lounge'].includes(p.id));
    return { key: project ? `project:${project.id}` : `path:${task.sourceCwd}`, name: project?.name || task.sourceCwd.split('/').filter(Boolean).pop() || task.title };
  }
  const project = projects.find(p => p.id === task.projectId);
  // Inbox items do not all belong to one meaningful project.
  return project && !['inbox', 'lounge'].includes(project.id)
    ? { key: `project:${project.id}`, name: project.name }
    : { key: `task:${task.id}`, name: task.title };
}
export function taskIsPersonal(task, categories = {}, projects = []) {
  return typeof task.personal === 'boolean' ? task.personal : categories[projectIdentity(task, projects).key] === 'personal';
}
export function inRotation(task, mode = 'all') {
  if (task.isConductor || ['done', 'snoozed'].includes(task.status)) return false;
  return mode === 'all' || (mode === 'personal' ? !!task.isPersonal : !task.isPersonal);
}
export function rotationTasks(tasks, mode = 'all') { return tasks.filter(task => inRotation(task, mode)); }
export function mergeRotationOrder(tasks, ids, mode = 'all') {
  const visible = rotationTasks(tasks, mode), valid = new Set(visible.map(t => t.id));
  if (!Array.isArray(ids) || ids.length !== visible.length || new Set(ids).size !== ids.length || ids.some(id => !valid.has(id))) throw Object.assign(new Error('The rotation changed. Try the move again.'), { status: 409 });
  let index = 0;
  return tasks.filter(t => !t.isConductor && t.status !== 'done').map(t => valid.has(t.id) ? ids[index++] : t.id);
}

// Project rank is the outer queue; the existing task order is local to a group.
export function projectGroups(tasks, { mode = 'all', projectOrder = [], projects = [], sortMode='recent' } = {}) {
  const groups = new Map();
  for (const task of rotationTasks(tasks, mode)) {
    const identity = projectIdentity(task, projects), key = task.projectKey || identity.key;
    if (!groups.has(key)) groups.set(key, { key, name: task.projectName || identity.name, standalone: key.startsWith('task:'), tasks: [], score: -Infinity, activity:0, position: groups.size });
    const group = groups.get(key); group.tasks.push(task); group.score = Math.max(group.score, task.score || 0);group.activity=Math.max(group.activity,activityTime(task));
  }
  const order = new Map(projectOrder.map((key, index) => [key, index]));
  return [...groups.values()].sort((a,b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) || (sortMode==='priority'?b.score-a.score:(sortMode==='oldest'?1:-1)*(a.activity-b.activity)) || a.position - b.position);
}
export function orderProjectTasks(tasks, options = {}) {
  const visible = projectGroups(tasks, options).flatMap(group => group.tasks), ids = new Set(visible.map(t => t.id));
  return [...visible, ...tasks.filter(t => !ids.has(t.id))];
}
export function mergeProjectOrder(tasks, keys, options = {}) {
  const visible = projectGroups(tasks, options), valid = new Set(visible.map(g => g.key));
  if (!Array.isArray(keys) || keys.length !== valid.size || new Set(keys).size !== keys.length || keys.some(key => !valid.has(key))) throw Object.assign(new Error('The projects in this rotation changed. Try the move again.'), { status: 409 });
  const existing=new Set(tasks.filter(t=>!t.isConductor&&t.status!=='done').map(t=>t.projectKey||projectIdentity(t,options.projects).key));
  const all=[...new Set([...(options.projectOrder||[]).filter(key=>existing.has(key)),...projectGroups(tasks,{...options,mode:'all'}).map(g=>g.key),...existing])];let index=0;
  return all.map(key=>valid.has(key)?keys[index++]:key);
}
export function reorderProjectChats(tasks, projectKey, ids, options = {}) {
  const group = projectGroups(tasks, options).find(group => group.key === projectKey), valid = new Set(group?.tasks.map(t => t.id));
  if (!group || !Array.isArray(ids) || ids.length !== valid.size || new Set(ids).size !== ids.length || ids.some(id => !valid.has(id))) throw Object.assign(new Error('The chats in this project changed. Try the move again.'), { status: 409 });
  let index = 0;
  return rotationTasks(tasks, options.mode).map(task => valid.has(task.id) ? ids[index++] : task.id);
}
