// Shared by the server and renderer so the drawer and next-task rotation agree.
export const ROTATION_MODES = ['all', 'work', 'personal'];
export function projectIdentity(task, projects = []) {
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
