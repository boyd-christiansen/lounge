import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';

export function withinWorkspace(path, cwd) {
  if (typeof path !== 'string' || !path) return false;
  const target = resolve(cwd, path); let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, target));
  const displacement = relative(realpathSync(cwd), canonical);
  return !isAbsolute(displacement) && displacement !== '..' && !displacement.startsWith('../');
}
