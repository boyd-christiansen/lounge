// Heroicons outline: one 24px grid, stroke weight and optical treatment.
const names=new Set(['speaker-wave','speaker-x-mark','arrows-pointing-out','microphone','x-mark','cog-6-tooth','bars-2','chevron-down','ellipsis-horizontal','arrow-up-right','arrow-left','play','arrow-up']);
export function icon(name){
  if(!names.has(name))throw new Error('Unknown interface icon');
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#${name}"></use></svg>`;
}
