export function taskState(task={}){
  if(task.status==='done')return{label:'Removed',detail:'Removed from Lounge by you. The original conversation is retained.'};
  if(task.status==='snoozed')return{label:'Snoozed',detail:'Hidden from rotation until its snooze expires or you bring it back.'};
  if(task.status==='error')return{label:'Needs attention',detail:'The last run or connection reported an error. This task needs a recovery step.'};
  if(task.status==='paused')return{label:'Paused',detail:'Lounge is not continuing this run. Resume it explicitly when ready.'};
  if(task.pending?.length||task.status==='waiting')return task.pending?.some(p=>p.kind==='approval')?{label:'Approval needed',detail:'An agent is waiting for an explicit permission decision. Opening the task shows the request.'}:{label:'Needs your answer',detail:'An agent is waiting for information or a decision. Your answer lets it continue.'};
  if(task.status==='running')return{label:'Working',detail:'The runtime reports work in progress. It can still return a question or approval request.'};
  if(task.status==='review'&&task.external&&!['completed','failed','interrupted'].includes(task.sourceTurnStatus))return{label:'Saved snapshot',detail:'Saved source context is available, but Lounge cannot verify a live completion state for this conversation.'};
  if(task.status==='review')return task.attentionVersion&&task.presentedVersion===task.attentionVersion?{label:'Next step',detail:'Lounge has shown this result. It stays in your queue for your next instruction or explicit removal.'}:{label:'Ready for review',detail:'The latest agent turn finished. Its result awaits your attention; this does not mean the whole task is done.'};
  return{label:'Ready',detail:'Saved in your queue; no agent is currently working on it.'};
}
export function shortcutMarkup(action,mac=true){
  const keys=action==='rotation'?(mac?['⇧','⌘','P']:['Ctrl','Shift','P']):action==='settings'?(mac?['⌘',',']:['Ctrl',',']):(mac?['⌘','\\']:['Ctrl','\\']);
  const label=action==='rotation'?(mac?'Shift Command P':'Control Shift P'):action==='settings'?(mac?'Command comma':'Control comma'):(mac?'Command backslash':'Control backslash');
  return `<span class="shortcut" aria-label="${label}">${keys.map(key=>`<kbd>${key}</kbd>`).join('')}</span>`;
}
