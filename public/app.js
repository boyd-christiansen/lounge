import { fingerprint, pickNext, sourceUrl, isDictationCommit, parseScene, normalizeScene, assertDraftTarget, queuePreview, renderMarkdown, briefingNarration, canRefocus, acceptsRoomPaste, taskBrief, entryScene, entryIntent, maySurfaceQueue } from './flow.js';
import { icon } from './icons.js';
import { inRotation, rotationTasks, projectGroups } from './rotation.js';
import { applicationInfo } from './applications.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeLoad = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
let state = {tasks:[],projects:[],profile:{},connection:{},queueOrder:[],orderRevision:0}, token, session = false, currentId = null, currentScene = null, busy = false, speechActive = false, soundGeneration = 0, recognition, recording = false, voiceSession = null, pendingConductor = null, pendingAutoAdvance = false, generation = 0,managedQueueId=null;
let settingsDirty=false,settingsEditVersion=0;
let drawerPinned = false, hoverTimer, closeTimer, noticeTimer, autoSendTimer, advanceTimer, dragId, lastPasteAt = 0, lastManualKeyAt = 0, lastValue = '';
let voiceAudio = null, voiceAbort = null, voiceUrl = null, audioContext=null, audioSource=null, queuedPaste=false, firstBrief=true,queueStarted=false;
const sceneCache=new Map(), audioCache=new Map(), audioErrors=new Set();let warming=false,greetingAudioWarmed=false,explicitVoiceRetry=false,voiceFailure=null;
function unlockAudio(){try{const AudioContext=window.AudioContext||window.webkitAudioContext;if(AudioContext){audioContext ||= new AudioContext();audioContext.resume().catch(()=>{});}}catch{}}
function sceneKey(task){return JSON.stringify([fingerprint(task),task.brief,task.overview,task.statusText,task.cachedBrief?.key,state.projectContexts,state.inference?.coordinator,state.profile.name,state.profile.personality,state.profile.memories,state.profile.voiceTone]);}
function preparedScene(task){const key=sceneKey(task);if(!sceneCache.has(key)){const pending=api('brief',{taskId:task.id});sceneCache.set(key,pending);pending.then(scene=>{if(scene.saved&&sceneCache.get(key)===pending)sceneCache.delete(key);},()=>{if(sceneCache.get(key)===pending)sceneCache.delete(key);});while(sceneCache.size>12)sceneCache.delete(sceneCache.keys().next().value);}return sceneCache.get(key);}
function resetVoicePlayback(){voiceFailure=null;audioCache.clear();audioErrors.clear();explicitVoiceRetry=true;greetingAudioWarmed=false;}
function voiceInput(text,profile){return{text:text.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[#*`]/g,''),voiceId:profile.naturalVoiceId,rate:profile.voiceRate||1,tone:profile.voiceTone||'natural'};}
function preparedAudio(text,profile){const input=voiceInput(text,profile),key=JSON.stringify(input);if(explicitVoiceRetry){if(audioErrors.has(key))audioCache.delete(key);audioErrors.delete(key);input.retry=true;voiceFailure=null;explicitVoiceRetry=false;}if(voiceFailure)return Promise.reject(voiceFailure);if(!audioCache.has(key)){const pending=fetch('/api/voice/speak',{method:'POST',headers:{'Content-Type':'application/json','X-Lounge-Token':token},body:JSON.stringify(input)}).then(async res=>{if(!res.ok){const value=await res.json();throw new Error(value.error||'The voice could not be played');}return res.arrayBuffer();});audioCache.set(key,pending);pending.catch(error=>{audioErrors.add(key);voiceFailure=error;});while(audioCache.size>4)audioCache.delete(audioCache.keys().next().value);}return audioCache.get(key);}
async function warmUpcoming(){
  if(warming||!token)return;warming=true;
  try{
    const canSpeak=state.profile.autoRead&&state.speech?.ready&&state.profile.voiceProvider==='elevenlabs'&&!silentPreview;
    // Warm the short greeting first; synthesis of a source never delays entry.
    if(!queueStarted&&!greetingAudioWarmed&&canSpeak){greetingAudioWarmed=true;preparedAudio(entryScene(state.profile.name).spoken,state.profile).catch(()=>{});}
    const candidates=openTasks().filter(t=>t.status!=='running'&&t.id!==currentId&&seen[t.id]!==fingerprint(t)).slice(0,2);
    await Promise.allSettled(candidates.map(t=>preparedScene(t)));
    if(canSpeak&&candidates[0]){
      const task=candidates[0],scene=await preparedScene(task);
      if(!scene.saved)await preparedAudio(briefingNarration(taskBrief(scene,task),task,{name:state.profile.name,first:firstBrief,next:!firstBrief,returning:!!task.briefedAt}),state.profile);
    }
  }catch{}finally{warming=false;}
}
function safeToRefocus(){return canRefocus({busy,recording,pendingConductor,text:$('#thought').value,answers:[...$('#scene-question').querySelectorAll('textarea,input:checked')].map(e=>e.value)});}

let importPreview=null;
const presentedTasks=new Set();
const seen = {}, drafts = safeLoad('lounge-room-drafts', {}), questionDrafts = safeLoad('lounge-room-answers', {});
const savedCollapsed=safeLoad('lounge-collapsed-projects',[]),collapsedProjects=new Set(Array.isArray(savedCollapsed)?savedCollapsed:[]);
const silentPreview = new URLSearchParams(location.search).has('silent');
const currentTask = () => state.tasks.find(t => t.id === currentId);
const conductor = () => state.tasks.find(t => t.isConductor);
const openTasks = () => rotationTasks(state.tasks, state.rotationMode);
const projectName = t => t.sourceProjectName || state.projects.find(p => p.path === t.sourceCwd || p.id === t.projectId)?.name || 'Your work';
const stateLabel = t => t.external && t.sourceTurnStatus === 'unknown' ? 'Source snapshot' : ({queued:'Ready when you are',running:'Working',waiting:'Needs you',review:'A result came back',paused:'Ready to pick up',error:'Needs a next step',snoozed:'Set aside'}[t.status] || 'In your queue');
const markdown = renderMarkdown;
async function api(path, data) {
  const res = await fetch('/api/'+path, {method:data ? 'POST':'GET',headers:data ? {'Content-Type':'application/json','X-Lounge-Token':token}:{},body:data ? JSON.stringify({commandId:crypto.randomUUID(),...data}):undefined});
  const value = await res.json(); if (!res.ok) throw new Error(value.error || 'Something interrupted the connection'); return value;
}
function notice(text) { $('#notice').textContent = text; $('#notice').classList.add('visible'); clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>$('#notice').classList.remove('visible'),6500); }
function setBusy(value) { busy=value; document.body.classList.toggle('busy',value); $('#thought-area').classList.toggle('sending',value); $('#submit-thought').disabled=value;if(!value&&queuedPaste){queuedPaste=false;scheduleSend();} }
function showTransition(title, subtitle='Checking what has come back.') {
  $('#welcome').hidden=true; $('#scene').hidden=true; $('#transition').hidden=false;
  $('#transition-text').textContent=title; $('#transition-subtext').textContent=subtitle;
}
function stopSpeaking() { soundGeneration++;if(audioSource){audioSource.onended=null;try{audioSource.stop();}catch{}audioSource=null;}voiceAbort?.abort(); voiceAbort=null; if(voiceAudio){voiceAudio.pause();voiceAudio.src='';voiceAudio=null;}if(voiceUrl){URL.revokeObjectURL(voiceUrl);voiceUrl=null;} if ('speechSynthesis' in window) speechSynthesis.cancel(); speechActive=false; document.body.classList.remove('speaking'); }
async function speak(text, onEnd, profile = state.profile) {
  stopSpeaking(); const run=soundGeneration;
  if (!text || !profile.autoRead || silentPreview) { if (onEnd) advanceTimer=setTimeout(onEnd,3500); return; }
  const clean=text.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[#*`]/g,'');
  const ended=()=>{if(run!==soundGeneration)return;speechActive=false;document.body.classList.remove('speaking');if(onEnd)advanceTimer=setTimeout(onEnd,900);};
  speechActive=true; document.body.classList.add('speaking');
  if(profile.voiceProvider==='elevenlabs'){
    try{
      const bytes=await preparedAudio(clean,profile);if(run!==soundGeneration)return;
      if(audioContext){await audioContext.resume();const buffer=await audioContext.decodeAudioData(bytes.slice(0));if(run!==soundGeneration)return;if(audioContext.state!=='running')throw new Error('Press Listen to enable voice playback.');audioSource=audioContext.createBufferSource();audioSource.buffer=buffer;audioSource.connect(audioContext.destination);audioSource.onended=ended;audioSource.start();}
      else{voiceUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/mpeg'}));voiceAudio=new Audio(voiceUrl);voiceAudio.onended=ended;await voiceAudio.play();}
    }catch(error){if(run!==soundGeneration)return;stopSpeaking();notice(error.message);if(!$('#replay-voice'))$('#scene-actions').insertAdjacentHTML('beforeend','<button id="replay-voice">Listen ↗</button>');}
    return;
  }
  if(!('speechSynthesis' in window)){ended();return;}
  const voices=speechSynthesis.getVoices();
  const voice=voices.find(v=>v.name===profile.voiceName)||voices.find(v=>/premium|enhanced|natural/i.test(v.name)&&v.lang.startsWith('en'));
  const utterance=new SpeechSynthesisUtterance(clean);utterance.rate=profile.voiceRate||1;if(voice)utterance.voice=voice;
  utterance.onend=ended;utterance.onerror=()=>{if(run===soundGeneration)stopSpeaking();};speechSynthesis.speak(utterance);
}
function renderChrome() {
  $('#hello').textContent=entryScene(state.profile.name).title;
  $('#rotation-mode').value=state.rotationMode||'all';
  $('#codex-status').textContent=state.connection.state==='connected'?'Connected with your ChatGPT sign-in':'Use your existing ChatGPT sign-in';
  $('#connect-codex').textContent=state.connection.state==='connected'?'Reconnect ↗':'Connect ↗';
  const claude=state.runtimes?.find(r=>r.id==='claude-code');
  $('#claude-status').textContent=claude?.ready?`Connected · ${claude.subscriptionType||'Claude'} sign-in`:claude?.error||'Use your existing Claude Code sign-in';
  $('#connect-claude').textContent=claude?.ready?'Reconnect ↗':'Connect ↗';
  const desktop=state.desktop;$('#desktop-status').textContent=desktop?.ready?'Connected · existing Claude conversations':desktop?.error||(desktop?.available?(desktop.permission?'Ready to connect':'Enable Lounge in macOS Accessibility settings'):'Open Lounge.app for existing-chat control');
  $('#connect-desktop').textContent=desktop?.ready?'Reconnect ↗':desktop?.permission?'Connect ↗':'Enable ↗';$('#connect-desktop').disabled=!desktop?.available;
  $('#disconnect-desktop').hidden=!desktop?.ready;
  $('#sound').innerHTML=icon(state.profile.autoRead?'speaker-wave':'speaker-x-mark');
  $('#sound').setAttribute('aria-label',state.profile.autoRead?'Mute read-aloud':'Enable read-aloud');
  if(!dragId)renderQueue();
  offerConductorQuestion();
}
function offerConductorQuestion(){if(currentScene?.entry&&conductor()?.pending?.length&&!$('#waiting-question'))$('#scene-actions').insertAdjacentHTML('beforeend','<button id="waiting-question" data-entry="question">Hear waiting question ↗</button>');}
function queueGroups(){return projectGroups(state.tasks,{mode:state.rotationMode,projectOrder:state.projectOrder||[],projects:state.projects});}
function taskRow(t,{standalone=false,rank=0}={}){
  const url=sourceUrl(t),drag=standalone?`data-drag-project="${esc(t.projectKey)}"`:`data-drag="${esc(t.id)}"`,copy=`<strong>${esc(t.title)}</strong><small><span class="task-status-dot ${esc(t.status)}"></span><span>${esc(applicationInfo(t).name)}</span><span aria-hidden="true">·</span><span>${esc(stateLabel(t))}</span>${t.isPersonal?'<span class="personal-label">Personal</span>':''}</small>`;
  const attributes=!t.external?`data-native-handoff="${esc(t.id)}"`:t.capabilities?.bridged?`data-reveal="${esc(t.id)}"`:'';
  return `<li class="queue-item ${t.id===currentId?'focused':''} ${standalone?'standalone-task':''}" data-task="${esc(t.id)}" data-project-key="${esc(t.projectKey)}"><div class="queue-item-main">${standalone?`<span class="project-rank">P${rank}</span>`:''}<button class="drag-handle" draggable="true" ${drag} aria-label="Move ${esc(t.title)}${standalone?' in project priority':''}" title="Drag to reorder · Alt + arrow keys">${icon('bars-2')}</button>${url?`<a class="task-copy" ${attributes} href="${esc(url)}" title="Open ${esc(t.sourceTitle||t.title)} in its source app">${copy}</a>`:`<button class="task-copy" data-focus="${esc(t.id)}">${copy}</button>`}<button class="queue-more" data-manage="${esc(t.id)}" aria-label="Options for ${esc(t.title)}" aria-expanded="${managedQueueId===t.id}">${icon('ellipsis-horizontal')}</button><button class="source-link" data-focus="${esc(t.id)}" aria-label="Bring ${esc(t.title)} into focus" title="Bring into focus">${icon('arrow-up-right')}</button></div>${managedQueueId===t.id?`<div class="queue-actions"><button data-queue-action="work" data-task-id="${esc(t.id)}" aria-pressed="${!t.isPersonal}">Work</button><button data-queue-action="personal" data-task-id="${esc(t.id)}" aria-pressed="${!!t.isPersonal}">Personal</button><button data-queue-action="remove" data-task-id="${esc(t.id)}" ${['running','waiting'].includes(t.status)?'disabled title="Pause this task before removing it"':''}>Remove from queue</button></div>`:''}</li>`;
}
let lastQueueHtml='',previewAnchor=null;
function renderQueue(){
  $('#automatic-order').hidden=!(state.queueOrder.length||state.projectOrder?.length);
  const html=queueGroups().map((group,index)=>{
    if(group.standalone)return `<li class="project-group standalone" data-project-group="${esc(group.key)}"><ol>${taskRow(group.tasks[0],{standalone:true,rank:index+1})}</ol></li>`;
    const collapsed=collapsedProjects.has(group.key),id=`project-chats-${index}`;
    return `<li class="project-group ${group.tasks.some(t=>t.id===currentId)?'has-focus':''}" data-project-group="${esc(group.key)}"><div class="project-header"><span class="project-rank">P${index+1}</span><button class="drag-handle" draggable="true" data-drag-project="${esc(group.key)}" aria-label="Move project ${esc(group.name)}" title="Project priority · Drag or Alt + arrow keys">${icon('bars-2')}</button><button class="project-toggle" data-collapse-project="${esc(group.key)}" aria-expanded="${!collapsed}" aria-controls="${id}"><span>${esc(group.name)}</span>${icon('chevron-down')}</button></div><ol id="${id}" class="project-chats" ${collapsed?'hidden':''}>${group.tasks.map(t=>taskRow(t)).join('')}</ol></li>`;
  }).join('')||'<li class="empty-queue">Nothing in this rotation.</li>';
  if(html===lastQueueHtml)return;
  hideQueuePreview();$('#queue-list').innerHTML=html;lastQueueHtml=html;
}
function hideQueuePreview(){previewAnchor?.removeAttribute('aria-describedby');previewAnchor=null;$('#queue-preview').hidden=true;}
function showQueuePreview(row){
  if(!row||dragId||!document.body.classList.contains('drawer-open')||!$('#settings-view').hidden)return hideQueuePreview();
  const task=state.tasks.find(t=>t.id===row.dataset.task);if(!task)return hideQueuePreview();
  const preview=queuePreview(task);if(!preview.overview&&!preview.status)return hideQueuePreview();
  previewAnchor?.removeAttribute('aria-describedby');previewAnchor=row.contains(document.activeElement)?document.activeElement:row.querySelector('.task-copy');previewAnchor?.setAttribute('aria-describedby','queue-preview');
  const popup=$('#queue-preview');$('#queue-preview-title').textContent=task.title;$('#queue-preview-overview').textContent=preview.overview;$('#queue-preview-status').textContent=preview.status;popup.hidden=false;
  const anchor=row.getBoundingClientRect(),edge=$('#drawer').getBoundingClientRect().right,width=popup.getBoundingClientRect().width;
  popup.style.left=`${edge+width+32<=innerWidth?edge+16:Math.max(16,innerWidth-width-16)}px`;
  popup.style.top=`${Math.max(16,Math.min(anchor.top,innerHeight-popup.getBoundingClientRect().height-16))}px`;
}
$('#queue-list').addEventListener('pointerover',e=>showQueuePreview(e.target.closest('.queue-item')));
$('#queue-list').addEventListener('pointerout',e=>{if(!e.relatedTarget?.closest?.('.queue-item')||e.relatedTarget.closest('.queue-item')!==e.target.closest('.queue-item'))hideQueuePreview();});
$('#queue-list').addEventListener('focusin',e=>showQueuePreview(e.target.closest('.queue-item')));
$('#queue-list').addEventListener('focusout',e=>{if(!e.relatedTarget?.closest?.('.queue-item'))hideQueuePreview();});
$('#queue-list').addEventListener('click',e=>{
  const button=e.target.closest('[data-collapse-project]');if(!button)return;
  const key=button.dataset.collapseProject;collapsedProjects.has(key)?collapsedProjects.delete(key):collapsedProjects.add(key);
  localStorage.setItem('lounge-collapsed-projects',JSON.stringify([...collapsedProjects]));renderQueue();$(`[data-collapse-project="${CSS.escape(key)}"]`)?.focus();
});
function openDrawer(pin=false) { clearTimeout(hoverTimer);clearTimeout(closeTimer);drawerPinned=pin;document.body.classList.add('drawer-open');$('#drawer').inert=false;$('#queue-edge').setAttribute('aria-expanded','true');$('#drawer-scrim').hidden=false; }
function closeDrawer() { hideQueuePreview();clearTimeout(closeTimer);drawerPinned=false;document.body.classList.remove('drawer-open');$('#drawer').inert=true;$('#queue-edge').setAttribute('aria-expanded','false');$('#drawer-scrim').hidden=true;if(session)$('#thought').focus({preventScroll:true}); }
function settings(show) { hideQueuePreview(); $('#queue-view').hidden=show;$('#settings-view').hidden=!show;$('#drawer-title').textContent=show?'Settings':'Your queue';$('#settings-toggle').innerHTML=show?icon('arrow-left')+'Your queue':icon('cog-6-tooth')+'Settings & memory';if(show)fillSettings(); }
function populateVoices() {
  const voices='speechSynthesis' in window ? speechSynthesis.getVoices().filter(v=>v.lang.startsWith('en')&&(/premium|enhanced|natural/i.test(v.name)||['Samantha','Daniel','Karen','Moira','Tessa','Rishi',state.profile.voiceName].includes(v.name))):[];
  const value=$('#voice-name').value||state.profile.voiceName||'';
  $('#voice-name').innerHTML='<option value="">System voice</option>'+voices.map(v=>`<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  $('#voice-name').value=value;
}
function fillSettings() {
  if(settingsDirty)return;
  $('#save-preferences').disabled=true;
  const p=state.profile;$('#profile-name').value=p.name||'';$('#profile-memories').value=(p.memories||[]).join('\n');$('#profile-personality').value=p.personality||'';
  $('#auto-read').checked=p.autoRead;$('#auto-send').checked=p.autoSend;$('#auto-advance').checked=p.autoAdvance;$('#voice-rate').value=String(p.voiceRate||1);$('#voice-tone').value=p.voiceTone||'natural';$('#prompt-policy').value=p.promptPolicy||'smart';populateVoices();$('#voice-name').value=p.voiceName||'';
  $('#voice-provider').value=p.voiceProvider||'system';fillNaturalVoices(p.naturalVoiceId);renderVoiceSettings();
  $('#workspace-list').innerHTML=state.projects.map(p=>`<p>${esc(p.name)}<small>${esc(p.path)}</small></p>`).join('');
  fillModels();fillProjectNotes();$('#local-endpoint').value=state.localEndpoint||'';
  $('#local-status').textContent=state.runtimes?.find(r=>r.id==='local')?.ready?'Connected · stays on this Mac':'Optional · no model server started by Lounge';
}
function fillModels(){
  for(const scope of ['coordinator','workers']){
    const saved=state.inference?.[scope]||{model:'codex/default',effort:null};
    const options=(state.runtimes||[]).filter(r=>r.newWork!==false&&r.configured!==false&&r.roles.includes(scope==='workers'?'worker':'coordinator')&&r.id!=='local').map(r=>({selector:`${r.id}/default`,name:`${r.name} preference · ${r.billing}`}));
    if(!options.some(m=>m.selector==='codex/default'))options.unshift({selector:'codex/default',name:'Codex preference · subscription'});
    for(const runtime of state.runtimes||[])if(runtime.roles.includes(scope==='workers'?'worker':'coordinator'))for(const model of runtime.models)options.push({...model,name:`${runtime.name} · ${model.name}`});
    if(!options.some(m=>m.selector===saved.model))options.push({selector:saved.model,name:saved.model});
    $(`#${scope}-model`).innerHTML=options.map(m=>`<option value="${esc(m.selector)}">${esc(m.name)}</option>`).join('');$(`#${scope}-model`).value=saved.model;
    fillEfforts(scope,saved.effort);
  }
}
function fillEfforts(scope,preferred=null){
  const selector=$(`#${scope}-model`).value,model=(state.runtimes||[]).flatMap(r=>r.models).find(m=>m.selector===selector);
  const efforts=model?.efforts||[];
  $(`#${scope}-effort`).innerHTML='<option value="">Model default</option>'+efforts.map(e=>`<option value="${esc(e)}">${esc(e.replaceAll('_',' '))}</option>`).join('');
  $(`#${scope}-effort`).value=efforts.includes(preferred)?preferred:'';$(`#${scope}-effort`).disabled=!efforts.length;
}
function fillProjectNotes(){
  const projects=new Map();for(const p of state.projects)if(!['inbox','lounge'].includes(p.id))projects.set(`project:${p.id}`,p.name);
  for(const t of state.tasks)if(!t.isConductor)projects.set(t.projectKey,t.projectKey.startsWith('task:')?t.title:projectName(t));
  const previous=$('#context-project').value;
  $('#context-project').innerHTML=[...projects].map(([key,name])=>`<option value="${esc(key)}">${esc(name)}</option>`).join('');
  if(projects.has(previous))$('#context-project').value=previous;
  $('#project-context').value=state.projectContexts?.[$('#context-project').value]?.text||'';
  $('#save-project-context').disabled=!projects.size;
}
function fillNaturalVoices(preferred=$('#natural-voice-name').value||state.profile.naturalVoiceId||'KH1SQLVulwP6uG4O3nmT'){
  const voices=state.speech?.voices||[], options=voices.map(v=>({value:v.id,label:v.name+(v.libraryVoice?' · paid API':'')}));
  if(!options.some(v=>v.value===preferred))options.unshift({value:preferred,label:preferred==='KH1SQLVulwP6uG4O3nmT'?'Brad — Romantic & Gentle · paid API':preferred==='JBFqnCBsd6RMkjVDRZzb'?'George':'Your selected voice'});
  $('#natural-voice-name').innerHTML=options.map(v=>`<option value="${esc(v.value)}">${esc(v.label)}</option>`).join('');$('#natural-voice-name').value=preferred;
}
function renderVoiceSettings(){
  const natural=$('#voice-provider').value==='elevenlabs', speech=state.speech||{};
  $('#natural-voice').hidden=!natural;$('#system-voice-label').hidden=natural;
  if(!speech.ready||speech.error)$('#voice-service-details').open=true;
  $('#voice-connection-status').textContent=speech.error||(speech.ready?'Connected · AI-generated voice':'Connect ElevenLabs for natural read-aloud.');
  $('#voice-key-row').hidden=!!speech.configured||!!speech.ready;$('#voice-key-note').hidden=!!speech.configured||!!speech.ready;
  $('#disconnect-voice').hidden=!speech.configured&&!speech.ready;$('#reload-voices').hidden=!speech.configured;
  $('#test-voice').disabled=natural&&!speech.ready;
}
function persistDraft() {
  const key=currentId||'conductor', text=$('#thought').value;
  if(!drafts[key]?.text?.trim() && text.trim()){const task=currentTask()||conductor();drafts[key]={text,binding:{taskId:task?.id||null,requestId:task?.pending[0]?.id||null}};}
  else if(drafts[key]) drafts[key].text=text;
  if(!text.trim())delete drafts[key];localStorage.setItem('lounge-room-drafts',JSON.stringify(drafts));
}
function restoreDraft() { const key=currentId||'conductor';$('#thought').value=drafts[key]?.text||'';lastValue=$('#thought').value;resizeThought(); }
function acknowledgeDraftTarget(){const key=currentId||'conductor',task=currentTask()||conductor();if(drafts[key]){drafts[key].binding={taskId:task?.id||null,requestId:task?.pending[0]?.id||null};localStorage.setItem('lounge-room-drafts',JSON.stringify(drafts));}}
function resizeThought(){const el=$('#thought');el.rows=Math.min(4,Math.max(1,el.value.split('\n').length));}
function questionHtml(p) {
  if(!p)return '';
  if(p.kind==='approval')return `<pre class="approval-context">${esc(p.context)}</pre>`;
  return p.questions.map(q=>`<div><p class="question-label">${esc(q.question)}</p>${(q.options||[]).map(o=>`<label class="question-option"><input type="radio" name="answer-${esc(q.id)}" value="${esc(o.label)}" data-qid="${esc(q.id)}">${esc(o.label)}${o.description?`<small>${esc(o.description)}</small>`:''}</label>`).join('')}<textarea class="structured-answer" rows="2" data-qid="${esc(q.id)}" placeholder="Or give the full answer…" aria-label="Answer: ${esc(q.question)}">${esc(questionDrafts[`${currentId}:${p.id}:${q.id}`]||'')}</textarea></div>`).join('');
}
async function openNativeTask(id){
  if(busy||recording||pendingConductor)return notice('Finish the current recording or agent exchange before handing off.');
  persistDraft();setBusy(true);
  try{const transferred=await api('migration/handoff',{taskId:id});await fetchState();const task=state.tasks.find(t=>t.id===id);stopSpeaking();if(currentId===id)present({title:task.title,body:'This conversation is ready for you in its native app.',spoken:'',advance:false},task,{read:false});const url=sourceUrl(task);if(transferred.handoff?.nativeOpened){notice('The saved session is open in Claude’s Code tab.');}else if(url){const link=document.createElement('a');link.href=url;link.textContent='Open native conversation';link.click();}else if(window.webkit?.messageHandlers?.loungeShell)window.webkit.messageHandlers.loungeShell.postMessage({action:'openClaude'});else notice(task.handoff.instructions);}catch(error){notice(error.message);}finally{setBusy(false);}
}
function migrationCard(preview){const name=applicationInfo(preview.application).name,project=state.projects.find(p=>p.id===preview.projectId);return `<article class="artifact-card"><h3>${esc(preview.title)} → ${esc(name)}</h3><p>${esc(preview.coverage)}</p><p>Workspace: ${esc(project?.name || preview.projectId)} · ${esc(project?.path || '')}</p><p>${preview.gaps.map(esc).join('<br>')}</p><details><summary>Context to carry over</summary>${markdown(preview.context.goal)}${markdown(preview.context.latestResult)}${preview.context.entries.map(m=>`<p><small>${esc(m.role)}</small></p>${markdown(m.text)}`).join('')}</details><small>The original remains in ${esc(applicationInfo(preview.source.application).name)}.</small></article>`;}
async function showMigration(application){const t=currentTask();if(!t)return;if(!safeToRefocus())return notice('Finish your current thought before previewing an import.');setBusy(true);try{importPreview=await api('migration/preview',{taskId:t.id,application,projectId:$('#migration-project')?.value || t.projectId});present({title:'Bring this conversation into Lounge?',body:'Review what will carry over. This creates a linked continuation and starts no work until you give it a new instruction.',spoken:'',migrationPreview:importPreview,advance:false},t,{read:false});$('#scene-actions').innerHTML='<button class="primary-action" data-action="confirm-import">Confirm import ↗</button><button data-action="cancel-import">Keep using the source</button>';}catch(error){notice(error.message);}finally{setBusy(false);}}
function present(scene, task, {read=true,onEnd,narrate=false,next=false}={}) {
  scene=normalizeScene(scene.briefing?taskBrief(scene,task?{...task,briefedAt:task.briefedAt||presentedTasks.has(task.id)}:task):scene);
  document.body.classList.toggle('room-entry',!!scene.entry);$('#next-task').hidden=!!scene.entry;
  currentScene=scene;$('#welcome').hidden=true;$('#transition').hidden=true;$('#scene').hidden=false;$('#scene').scrollTop=0;
  $('.scene-meta').hidden=!task||task.isConductor;
  $('#scene-project').textContent=task?projectName(task):'';
  $('#scene-kind').textContent=task?`${applicationInfo(task).name} · ${stateLabel(task)}`:(scene.needsReply?'A question for you':'One thought at a time');
  $('#scene-title').textContent=scene.title;$('#scene-body').innerHTML=markdown(scene.body);
  const batch=scene.artifactBatch||(task?.isConductor?task.artifactBatch:null);
  $('#scene-artifacts').innerHTML=batch?`<p class="artifact-heading">${batch.candidates.length?'Chats I found':'No matching chats found'}</p>`+batch.candidates.map(c=>{const url=sourceUrl({application:c.application||batch.application||'codex',threadId:c.id,external:true});return `<article class="artifact-card"><h3>${esc(c.title)}</h3><p>${esc(c.preview)}</p><small>${esc(c.cwd?.split('/').pop()||applicationInfo(c.application||batch.application||'codex').name)} · ${batch.importedIds?.includes(c.id)?'Added to your queue':esc(applicationInfo(c.application||batch.application||'codex').name)}</small>${url?`<br><a href="${esc(url)}">View source ↗</a>`:''}</article>`;}).join(''):'';
  if(!batch&&task?.capabilities?.bridged)$('#scene-artifacts').innerHTML=(task.artifacts||[]).filter(a=>{try{const url=new URL(a.url);return url.protocol==='https:'&&url.hostname==='claude.ai'&&!url.username&&!url.password;}catch{return false;}}).map(a=>`<article class="artifact-card"><h3>${esc(a.title)}</h3><a href="${esc(a.url)}">View in Claude ↗</a></article>`).join('');
  if(scene.choices?.length)$('#scene-artifacts').innerHTML+='<div class="brief-choices">'+scene.choices.map((c,i)=>`<article class="brief-choice"><h3>Option ${i+1} · ${esc(c.label)}</h3>${markdown(c.quote)}</article>`).join('')+'</div>';
  else if(scene.choiceExcerpt)$('#scene-artifacts').innerHTML+=`<article class="brief-choice"><h3>Options from the source</h3>${markdown(scene.choiceExcerpt)}</article>`;
  const migration=scene.migrationPreview || (task?.isConductor?task.migrationPreview:null);document.body.classList.toggle('import-preview',!!migration);
  if(migration)$('#scene-artifacts').innerHTML+=migrationCard(migration);
  if(task?.handoff)$('#scene-artifacts').innerHTML+=`<article class="artifact-card"><p>${esc(task.handoff.instructions)}</p><small>Native app owns this conversation. Return by importing its latest context into a fresh linked continuation.</small>${task.application==='claude-code'?'<br><button data-action="open-claude">Open Claude ↗</button>':''}</article>`;
  const p=task?.pending[0];$('#scene-question').innerHTML=questionHtml(p);
  let actions='';
  if(task&&!task.isConductor){const url=sourceUrl(task);
    if(p?.kind==='approval'){if(p.sourceOnly){if(url)actions+=`<a class="primary-action" ${task.capabilities?.bridged?`data-reveal="${task.id}"`:""} href="${esc(url)}">Review in ${applicationInfo(task).name} ↗</a>`;}else{if(!/permissions\/requestApproval/.test(p.method))actions+='<button class="primary-action" data-action="approve">Approve this once ↗</button>';actions+='<button data-action="decline">Decline</button>';}}
    else if(url)actions+=`<a class="primary-action" ${!task.external?`data-native-handoff="${task.id}"`:task.capabilities?.bridged?`data-reveal="${task.id}"`:""} href="${esc(url)}">Open in ${applicationInfo(task).name} ↗</a>`;
    if(!['running','waiting','done'].includes(task.status)){if(task.external)actions+='<button data-action="import-choices">Bring into Lounge…</button>';else if(task.portableSession&&task.threadId&&!url)actions+='<button data-action="handoff">Type in native app ↗</button>';}
    if(!['running','waiting','done'].includes(task.status))actions+='<button data-action="clear">Remove from queue</button>';
    if(scene.needsSource&&task.external)actions+='<button data-action="refresh-source">Refresh source</button>';
    if(!['running','waiting'].includes(task.status))actions+='<button data-action="later">Later today</button>';
    if((!task.external||task.capabilities?.bridged)&&['running','waiting'].includes(task.status))actions+='<button data-action="interrupt">Pause this</button>';
  }
  $('#scene-actions').innerHTML=actions;offerConductorQuestion();$('#source-detail').hidden=!task||task.isConductor;$('#source-detail').open=false;
  $('#source-content').innerHTML=task?markdown(task.summary||task.brief):'';if(task?.origins?.length)$('#source-content').innerHTML+='<h3>Original conversations</h3>'+task.origins.map(o=>{const url=sourceUrl({application:o.application,threadId:o.threadId,sourceUrl:o.url,external:true});return `<p>${url?`<a href="${esc(url)}">${esc(o.title)} ↗</a>`:esc(o.title)}<br><small>${esc(applicationInfo(o.application).name)} · ${esc(o.importedAt)}</small></p>`;}).join('');
  if(read){const text=narrate?briefingNarration(scene,task,{name:state.profile.name||'',first:firstBrief,next:!firstBrief&&next,returning:!!scene.returning}):scene.spoken||scene.body;if(task&&narrate)firstBrief=false;currentScene.readAloud=text;speak(text,onEnd);}
  if(narrate&&task&&!task.isConductor){presentedTasks.add(task.id);task.briefedAt ||= new Date().toISOString();api(`tasks/${task.id}/presented`,{}).catch(()=>{});}
  warmUpcoming();
  if(session&&!document.body.classList.contains('drawer-open'))$('#thought').focus({preventScroll:true});
}
async function fetchState(){const next=await api('state');token=next.token;state=next;renderChrome();return state;}
async function refreshLoaded(){const next=await api('session/refresh',{});state={...state,...next};renderChrome();if(next.refreshErrors?.length)notice('Some source chats could not be refreshed. Their saved context is still here.');}
async function focusTask(id,{refresh=true,keepDrawer=false}={}) {
  if(busy)return;queueStarted=true;if(recording)stopMic(false);clearTimeout(autoSendTimer);clearTimeout(advanceTimer);stopSpeaking();persistDraft();
  const run=++generation;setBusy(true);currentId=id;restoreDraft();if(!keepDrawer)closeDrawer();
  showTransition('One moment.', 'Bringing this thread back into focus.');
  try{
    if(refresh)refreshLoaded().catch(()=>{});
    const task=currentTask();if(!task||task.status==='done')return await nextTask({skipCurrent:false,inside:true});
    const scene=await preparedScene(task);if(run!==generation)return;
    seen[id]=fingerprint(currentTask()||task);present(scene,currentTask()||task,{narrate:true});acknowledgeDraftTarget();renderQueue();
  }catch(error){if(run===generation){const task=currentTask();present({title:task?.title||'Your queue is still here.',body:task?'I couldn’t prepare a fresh briefing. The saved context is available below.':error.message,spoken:'',needsReply:false,advance:false},task,{read:false});notice(error.message);}}
  finally{if(run===generation)setBusy(false);}
}
async function nextTask({skipCurrent=true,inside=false}={}) {
  if(busy&&!inside)return;queueStarted=true;if(recording)stopMic(false);if($('#thought').value.trim()&&skipCurrent){notice('Your thought is saved with this task.');persistDraft();}
  clearTimeout(advanceTimer);clearTimeout(autoSendTimer);stopSpeaking();const run=++generation;setBusy(true);
  if(skipCurrent&&currentTask())seen[currentId]=fingerprint(currentTask());
  showTransition(session?'Let me see what’s next.':'Let me see where things stand.');
  try{
    refreshLoaded().catch(()=>{});if(run!==generation)return;
    const task=pickNext(state.tasks,seen,state.rotationMode);currentId=task?.id||null;restoreDraft();
    if(!task){const open=openTasks(), active=open.filter(t=>t.status==='running');const scene={title:!open.length?'You’re all caught up.':active.length===open.length?'A little room to breathe.':'You’ve made the rounds.',body:!open.length?'Tell me what’s on your mind.':active.length===open.length?'Your agents are working. I’ll bring back anything that needs you.':'The remaining threads are still in your queue. We can pick one back up, or make room for something new.',spoken:!open.length?'You’re all caught up. What’s on your mind?':active.length===open.length?'Your agents are working. I’ll bring back anything that needs you.':'You’ve made the rounds. The remaining threads are still in your queue.',needsReply:false,advance:false};present(scene,null);return;}
    const scene=await preparedScene(task);if(run!==generation)return;seen[task.id]=fingerprint(currentTask()||task);present(scene,currentTask()||task,{narrate:true,next:true});acknowledgeDraftTarget();renderQueue();
  }catch(error){if(run===generation){const task=currentTask();present({title:task?.title||'Let’s pick up here.',body:task?'I couldn’t refresh everything. Your saved context is here, and your queue is available on the left.':'The local queue is saved. Connect Codex in Settings to prepare your briefing.',spoken:'',needsReply:false,advance:false},task,{read:false});notice(error.message);}}
  finally{if(run===generation)setBusy(false);}
}
function openEntry(mode='greeting',{read=true}={}){
  if(busy||recording||pendingConductor)return notice('Finish your current exchange before changing focus.');
  unlockAudio();clearTimeout(autoSendTimer);clearTimeout(advanceTimer);pendingAutoAdvance=false;stopSpeaking();persistDraft();
  session=true;queueStarted=false;currentId=null;$('#thought-area').hidden=false;restoreDraft();closeDrawer();renderChrome();
  present(entryScene(state.profile.name,mode),null,{read});
}
function startSession(){if(session||busy)return;openEntry();if(!state.profile.autoRead)notice('Read-aloud is muted. Use the sound control to hear the greeting.');}
function clearSentDraft(key,text){if((drafts[key]?.text||'').trim()===text){delete drafts[key];localStorage.setItem('lounge-room-drafts',JSON.stringify(drafts));if((currentId||'conductor')===key){$('#thought').value='';lastValue='';resizeThought();}}}
async function sendThought() {
  if(busy||!session)return;clearTimeout(autoSendTimer);clearTimeout(advanceTimer);if(recording){voiceSession.forceSubmit=true;stopMic(true);return;}
  const task=currentTask(), key=currentId||'conductor';
  let text=$('#thought').value.trim();
  if(!text&&task?.pending[0]?.questions.length)text=task.pending[0].questions.map(q=>{const answer=$(`textarea[data-qid="${CSS.escape(q.id)}"]`)?.value||document.querySelector(`input[data-qid="${CSS.escape(q.id)}"]:checked`)?.value;return answer?`${q.question}\n${answer}`:'';}).filter(Boolean).join('\n\n');
  if(!text)return;
  if(pendingConductor&&currentId!==pendingConductor&&state.tasks.find(t=>t.id===pendingConductor)?.pending.length){notice('A new question is waiting. Choose “Hear the question” before answering it. Your current thought stays saved.');return;}
  persistDraft();const binding=drafts[key]?.binding;
  try{if(binding)assertDraftTarget(binding,task||conductor());}catch(error){notice(error.message);return;}
  stopSpeaking();
  const intent=entryIntent(text);
  if(intent==='queue'){clearSentDraft(key,text);await nextTask({skipCurrent:false});return;}
  if(!task&&intent){clearSentDraft(key,text);openEntry(intent);return;}
  if(/^(next( task)?|move on|what[’']?s next|skip this)[.!?]?$/i.test(text)){clearSentDraft(key,text);await nextTask();return;}
  if(/^(open( this| the task)?|open (in )?(codex|chatgpt|claude))[.!?]?$/i.test(text)&&sourceUrl(task||{})){clearSentDraft(key,text);const link=$('#scene-actions a');if(link)link.click();return;}
  setBusy(true);$('#input-hint').textContent='Thinking it through.';
  try{
    const result=await api('conductor',{text,taskId:task?.id,requestId:task?.pending[0]?.id||null,briefKey:currentScene?.briefKey||null});clearSentDraft(key,text);pendingConductor=result.id;
    showTransition('Thinking it through.','Your thought is with me.');
    await fetchState();consumeConductor();
  }catch(error){setBusy(false);if(error.message.includes('coordinator question'))await fetchState().catch(()=>{});notice(error.message);}
  finally{$('#input-hint').textContent='Your dictation shortcut works here.';}
}
function consumeConductor(){
  if(!pendingConductor)return;const t=state.tasks.find(t=>t.id===pendingConductor);if(!t)return;
  if(t.status==='waiting'&&t.pending.length){
    setBusy(false);
    if($('#thought').value.trim()||recording){
      if(!$('#hear-question'))$('#scene-actions').insertAdjacentHTML('beforeend','<button id="hear-question" class="primary-action">Hear the question ↗</button>');
      $('#hear-question').onclick=()=>{if(recording)stopMic(false);showConductorQuestion(t);};
      notice('A question came back. Finish your thought; it stays saved here.');return;
    }
    showConductorQuestion(t);return;
  }
  if(t.status==='error'||t.status==='paused'){pendingConductor=null;setBusy(false);present({title:'Let’s keep your place.',body:t.lastError||'The connection paused. Your thought is saved in this conversation.',spoken:'',needsReply:false,advance:false},currentTask(),{read:false});return;}
  if(t.status!=='review'||!t.summary)return;
  pendingConductor=null;setBusy(false);const scene=parseScene(t.summary);pendingAutoAdvance=!!(scene.advance&&state.profile.autoAdvance&&!scene.needsReply);
  const moveOn=()=>{if(pendingAutoAdvance&&safeToRefocus()){pendingAutoAdvance=false;nextTask();}};
  present({...scene,artifactBatch:t.artifactBatch,migrationPreview:t.migrationPreview},currentTask(),{onEnd:pendingAutoAdvance?moveOn:undefined});
}
function showConductorQuestion(t){pendingConductor=null;persistDraft();currentId=t.id;restoreDraft();const p=t.pending[0];present({title:p.question,body:p.context||'Take your time. I’m listening to the whole thought.',spoken:p.question,needsReply:true,advance:false},t);}
function scheduleSend(){clearTimeout(autoSendTimer);if(!state.profile.autoSend||recording)return;if(busy){queuedPaste=true;return;}$('#input-hint').textContent='Thought received. Sending…  ·  Esc to hold';autoSendTimer=setTimeout(()=>{autoSendTimer=null;$('#input-hint').textContent='Your dictation shortcut works here.';sendThought();},650);}
function cancelAutoSend(){clearTimeout(autoSendTimer);autoSendTimer=null;pendingAutoAdvance=false;clearTimeout(advanceTimer);$('#input-hint').textContent='Take your time. Enter when you’re ready.';}
$('#thought').addEventListener('input',e=>{if(speechActive)stopSpeaking();pendingAutoAdvance=false;clearTimeout(advanceTimer);persistDraft();resizeThought();const inserted=Math.max(e.data?.length||0,$('#thought').value.length-lastValue,0);lastValue=$('#thought').value;if(isDictationCommit({inputType:e.inputType,insertedLength:inserted,isComposing:e.isComposing,pasted:Date.now()-lastPasteAt<150,manualKeyRecent:Date.now()-lastManualKeyAt<100}))scheduleSend();else cancelAutoSend();});
$('#thought-form').onsubmit=e=>{e.preventDefault();sendThought();};
$('#thought').addEventListener('keydown',e=>{if(e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey)lastManualKeyAt=Date.now();if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendThought();}});
function textTarget(target){return target?.closest('input,textarea,select,[contenteditable="true"]');}
// Wispr's own shortcut stays with Wispr; the browser receives its finished text.
// Do not guess the function-key timing or send while dictation is in flight.
function onPaste(e){
  if(!acceptsRoomPaste({inDrawer:!!e.target.closest?.('#drawer'),editable:!!textTarget(e.target),thought:e.target===$('#thought')}))return;
  const text=e.clipboardData?.getData('text/plain');if(!text)return;
  unlockAudio();lastPasteAt=Date.now();
  if(!session){session=true;$('#thought-area').hidden=false;$('#welcome').hidden=true;renderChrome();present({title:'I’m listening.',body:'',spoken:'',needsReply:false,advance:false},null,{read:false});}
  // Capture once at the window boundary, including pastes onto buttons/body.
  e.preventDefault();stopSpeaking();const field=$('#thought'),a=field.selectionStart??field.value.length,b=field.selectionEnd??a;
  const inThought=e.target===field;field.value=inThought?field.value.slice(0,a)+text+field.value.slice(b):field.value+(field.value.trim()?'\n':'')+text;
  lastValue=field.value;field.focus();if(inThought)field.setSelectionRange(a+text.length,a+text.length);persistDraft();resizeThought();scheduleSend();
}
function finishVoice(voice, unexpected=false){
  if(voice.finished)return;voice.finished=true;recording=false;
  $('#mic').disabled=false;$('#mic').classList.remove('listening');$('#mic').setAttribute('aria-label','Start dictation');
  const key=voice.target||'conductor',sameTarget=(currentId||'conductor')===key;
  const base=sameTarget?$('#thought').value:(drafts[key]?.text||voice.prefix);
  const text=base+(base.trim()&&voice.words.trim()?' ':'')+voice.words.trim();
  if(text.trim()){
    drafts[key]={text,binding:voice.binding};localStorage.setItem('lounge-room-drafts',JSON.stringify(drafts));
    if(sameTarget){$('#thought').value=text;lastValue=text;resizeThought();}
  }
  $('#input-hint').textContent='Your dictation shortcut works here.';
  if(voice.forceSubmit&&sameTarget)sendThought();
  else if(voice.submit&&state.profile.autoSend&&sameTarget)scheduleSend();
  else if(unexpected)notice('Dictation paused. Your words are saved. Finish your thought, then press Enter.');
  if(voiceSession===voice)voiceSession=null;
}
function stopMic(submit=true){
  if(!voiceSession)return;const voice=voiceSession;voice.submit=submit;voice.stopping=true;recording=false;
  $('#mic').disabled=true;$('#input-hint').textContent='Finishing the thought…';
  try{voice.recognition.stop();}catch{finishVoice(voice);}
}
$('#mic').onclick=()=>{
  if(recording)return stopMic();
  const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Speech){$('#thought').focus();return notice('Use your Wispr Flow shortcut here. The completed thought will send automatically.');}
  stopSpeaking();recognition=new Speech();recognition.continuous=true;recognition.interimResults=false;recognition.lang='en-US';
  const task=currentTask()||conductor();
  const voice={target:currentId,prefix:$('#thought').value,words:'',submit:false,stopping:false,finished:false,recognition,binding:{taskId:task?.id||null,requestId:task?.pending[0]?.id||null}};
  voiceSession=voice;
  recognition.onresult=e=>{for(let i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)voice.words+=e.results[i][0].transcript+' ';if(!voice.stopping)$('#input-hint').textContent='Listening. Finish your thought, then tap to stop.';};
  recognition.onerror=e=>{voice.submit=false;voice.forceSubmit=false;notice(`Dictation stopped: ${e.error}. Your words stay saved.`);finishVoice(voice);};
  recognition.onend=()=>finishVoice(voice,!voice.stopping);
  try{recognition.start();recording=true;$('#mic').classList.add('listening');$('#mic').setAttribute('aria-label','Finish dictation');$('#input-hint').textContent='Listening. Take your time.';}catch(e){finishVoice(voice);notice(e.message);}
};
$('#start').onclick=startSession;$('#next-task').onclick=()=>nextTask();
$('#queue-edge').onmouseenter=()=>{hoverTimer=setTimeout(()=>{settings(false);openDrawer(false);},130);};
$('#queue-edge').onmouseleave=()=>clearTimeout(hoverTimer);$('#queue-edge').onclick=()=>{settings(false);openDrawer(true);};
$('#drawer').onmouseenter=()=>clearTimeout(closeTimer);$('#drawer').onmouseleave=()=>{if(!drawerPinned&&!dragId)closeTimer=setTimeout(closeDrawer,400);};
$('#drawer').addEventListener('focusin',()=>{drawerPinned=true;});$('#close-drawer').onclick=closeDrawer;$('#drawer-scrim').onclick=closeDrawer;
$('#settings-toggle').onclick=()=>{openDrawer(true);settings($('#settings-view').hidden);};
document.addEventListener('lounge:settings',()=>{openDrawer(true);settings(true);});
$('#sound').onclick=async()=>{try{stopSpeaking();state.profile=await api('profile',{autoRead:!state.profile.autoRead});renderChrome();}catch(e){notice(e.message);}};
$('#fullscreen').onclick=async()=>{if(window.webkit?.messageHandlers?.loungeShell){window.webkit.messageHandlers.loungeShell.postMessage({action:'fullscreen'});return;}try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notice('Fullscreen is available through your browser or app window controls.');}};
$('#talk-about-queue').onclick=()=>openEntry('add');
$('#scene-actions').addEventListener('click',e=>{const action=e.target.closest('[data-entry]')?.dataset.entry;if(!action||busy)return;if(action==='queue')nextTask({skipCurrent:false});else if(action==='question'){const t=conductor();if(t?.pending?.length)showConductorQuestion(t);}else openEntry(action);});
const preferenceFields=new Set(['profile-name','profile-memories','profile-personality','auto-read','auto-send','auto-advance','voice-name','voice-provider','natural-voice-name','voice-rate','voice-tone','prompt-policy']);
$('#settings-form').addEventListener('input',e=>{if(preferenceFields.has(e.target.id)){settingsDirty=true;settingsEditVersion++;$('#save-preferences').disabled=false;}});
$('#settings-form').onsubmit=async e=>{e.preventDefault();const savedEditVersion=settingsEditVersion;const previousVoice=JSON.stringify([state.profile.voiceProvider,state.profile.naturalVoiceId,state.profile.voiceTone,state.profile.voiceRate]);try{if($('#voice-provider').value==='elevenlabs'&&!state.speech?.ready)throw new Error('Connect ElevenLabs before choosing natural speech.');state.profile=await api('profile',{name:$('#profile-name').value,memories:$('#profile-memories').value.split('\n').filter(Boolean),personality:$('#profile-personality').value,autoRead:$('#auto-read').checked,autoSend:$('#auto-send').checked,autoAdvance:$('#auto-advance').checked,voiceName:$('#voice-name').value,voiceRate:Number($('#voice-rate').value),voiceTone:$('#voice-tone').value,voiceProvider:$('#voice-provider').value,naturalVoiceId:$('#natural-voice-name').value,promptPolicy:$('#prompt-policy').value});if(previousVoice!==JSON.stringify([state.profile.voiceProvider,state.profile.naturalVoiceId,state.profile.voiceTone,state.profile.voiceRate]))resetVoicePlayback();if(savedEditVersion===settingsEditVersion){settingsDirty=false;$('#save-preferences').disabled=true;}renderChrome();notice('I’ll remember.');}catch(error){notice(error.message);}};
$('#voice-provider').onchange=renderVoiceSettings;
for(const scope of ['coordinator','workers']){
  $(`#${scope}-model`).onchange=()=>fillEfforts(scope);
  $(`#save-${scope==='workers'?'workers':'coordinator'}-model`).onclick=async()=>{try{await api('inference',{scope,model:$(`#${scope}-model`).value,effort:$(`#${scope}-effort`).value||null});await fetchState();notice('Model preference saved for the next turn.');}catch(error){notice(error.message);}};
}
async function refreshModels(){const button=$('#reload-models');button.disabled=true;try{const result=await api('models',{});state.runtimes=result.providers;state.inference=result.inference;fillModels();if(result.errors.length)notice(result.errors.map(e=>e.error).join(' '));}catch(error){notice(error.message);}finally{button.disabled=false;}}
$('#reload-models').onclick=refreshModels;
$('#models-settings').ontoggle=()=>{if($('#models-settings').open&&!(state.runtimes||[]).some(r=>r.models.length))refreshModels();};
$('#connect-local').onclick=async()=>{const button=$('#connect-local');button.disabled=true;try{const result=await api('local/connect',{url:$('#local-endpoint').value});state.runtimes=result.providers;fillModels();$('#local-status').textContent='Connected · choose a coordinator model above';notice('Local models are available.');}catch(error){$('#local-status').textContent=error.message;notice(error.message);}finally{button.disabled=false;}};
$('#context-project').onchange=()=>{$('#project-context').value=state.projectContexts?.[$('#context-project').value]?.text||'';};
$('#save-project-context').onclick=async()=>{try{await api('context',{scope:'project',projectKey:$('#context-project').value,text:$('#project-context').value});await fetchState();notice('Project note saved.');}catch(error){notice(error.message);}};
$('#export-lounge').onclick=async()=>{try{const snapshot=await api('export',{}),url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`command-lounge-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('Exported your queue and preferences. Credentials stay on this Mac.');}catch(error){notice(error.message);}};
const rotationLabels={all:'All projects',work:'Work projects only',personal:'Personal projects only'};
async function changeRotation(mode){try{await api('rotation',{mode});await fetchState();notice(rotationLabels[mode]);}catch(error){$('#rotation-mode').value=state.rotationMode||'all';notice(error.message);}}
$('#rotation-mode').onchange=e=>changeRotation(e.target.value);
$('#reload-voices').onclick=async()=>{const button=$('#reload-voices');button.disabled=true;try{state.speech=await api('voice/refresh',{});fillNaturalVoices();renderVoiceSettings();notice('Your voices are up to date.');}catch(error){notice(error.message);}finally{button.disabled=false;}};
$('#disconnect-voice').onclick=async()=>{try{stopSpeaking();state.speech=await api('voice/disconnect',{});state.profile=await api('profile',{voiceProvider:'system'});$('#voice-provider').value='system';renderVoiceSettings();notice('Natural speech disconnected.');}catch(error){notice(error.message);}};
$('#connect-voice').onclick=async()=>{const button=$('#connect-voice');button.disabled=true;try{state.speech=await api('voice/connect',{key:$('#voice-key').value});resetVoicePlayback();$('#voice-key').value='';fillNaturalVoices();renderVoiceSettings();notice('Your natural voice is connected. Use Listen to try it.');}catch(error){notice(error.message);}finally{button.disabled=false;}};
$('#test-voice').onclick=()=>{unlockAudio();explicitVoiceRetry=true;speak(entryScene(state.profile.name).spoken,undefined,{...state.profile,autoRead:true,voiceProvider:$('#voice-provider').value,voiceName:$('#voice-name').value,naturalVoiceId:$('#natural-voice-name').value,voiceRate:Number($('#voice-rate').value),voiceTone:$('#voice-tone').value});};
if('speechSynthesis' in window)speechSynthesis.onvoiceschanged=populateVoices;
$('#connect-claude').onclick=async()=>{const button=$('#connect-claude');button.disabled=true;try{await api('connect',{provider:'claude-code'});await refreshModels();await fetchState();notice('Claude Code is connected with your subscription.');}catch(error){await fetchState();notice(error.message);}finally{button.disabled=false;}};
$('#connect-desktop').onclick=async()=>{const button=$('#connect-desktop');button.disabled=true;try{await api('desktop/status',{});await fetchState();if(!state.desktop.permission){await api('desktop/permission',{});notice('Enable Lounge in System Settings → Privacy & Security → Accessibility, then connect here.');}else{await api('desktop/connect',{});notice('Existing Claude conversations can now continue here.');}await fetchState();}catch(error){notice(error.message);await fetchState();}finally{button.disabled=!state.desktop?.available;}};
$('#disconnect-desktop').onclick=async()=>{try{await api('desktop/disconnect',{});await fetchState();notice('Desktop control is off. Source conversations stay in their app.');}catch(error){notice(error.message);}};
$('#connect-codex').onclick=async()=>{try{await api('connect',{});await fetchState();notice('Codex is connected.');}catch(error){try{const result=await api('login',{});if(result.authUrl&&/^https:\/\//.test(result.authUrl)){$('#codex-status').innerHTML=`<a href="${esc(result.authUrl)}" target="_blank" rel="noopener noreferrer">Continue sign-in with OpenAI ↗</a>`;window.open(result.authUrl,'_blank','noopener');}notice('Use the OpenAI sign-in link here, then reconnect.');}catch{notice(error.message);}}};
async function focusTop(){const task=openTasks().find(t=>t.status!=='running');if(!task)return notice('Your agents are working. I’ll bring back anything that needs you.');if(busy||recording||pendingConductor)return notice('Finish the current recording or agent exchange before changing focus.');if($('#thought').value.trim())notice('Your unfinished thought is saved with its task.');if(!session){session=true;$('#thought-area').hidden=false;unlockAudio();}await focusTask(task.id,{refresh:false});}
$('#focus-top').onclick=focusTop;
async function afterReorder(){
  await fetchState();warmUpcoming();const task=openTasks().find(t=>t.status!=='running');
  if(session&&queueStarted&&task&&task.id!==currentId){if(safeToRefocus())await focusTask(task.id,{refresh:false,keepDrawer:true});else notice('Queue reordered. Your current thought stays here. Choose Focus top task when you’re ready.');}
}
async function reorderProjects(keys){await api('order/projects',{keys,revision:state.projectOrderRevision});await afterReorder();}
async function reorderChats(projectKey,ids){await api('order/chats',{projectKey,ids,revision:state.orderRevision});await afterReorder();}
$('#automatic-order').onclick=async()=>{try{await api('order/projects',{keys:[],revision:state.projectOrderRevision});await fetchState();await api('order',{ids:[],revision:state.orderRevision});await afterReorder();notice('Back to automatic priority.');}catch(error){notice(error.message);}};
function moveBeforeOrAfter(ids,id,target,after){const result=ids.filter(key=>key!==id),index=result.indexOf(target);if(index<0)throw new Error('The queue changed. Try the move again.');result.splice(index+(after?1:0),0,id);return result;}
function dragTarget(e){
  if(!dragId)return null;
  if(dragId.kind==='project')return e.target.closest('.project-group');
  const row=e.target.closest('.queue-item');return row?.dataset.projectKey===dragId.projectKey?row:null;
}
$('#queue-list').addEventListener('dragstart',e=>{
  const handle=e.target.closest('[data-drag-project],[data-drag]');if(!handle)return;
  dragId=handle.dataset.dragProject?{kind:'project',key:handle.dataset.dragProject}:{kind:'chat',key:handle.dataset.drag,projectKey:handle.closest('.queue-item').dataset.projectKey};
  hideQueuePreview();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragId));
  const row=handle.closest(dragId.kind==='project'?'.project-group':'.queue-item');row.classList.add('dragging');e.dataTransfer.setDragImage(row.querySelector('.project-header')||row.querySelector('.queue-item-main')||row,20,20);
});
$('#queue-list').addEventListener('dragover',e=>{
  const row=dragTarget(e);for(const old of $('#queue-list').querySelectorAll('.drop-before,.drop-after'))old.classList.remove('drop-before','drop-after');if(!row)return;
  e.preventDefault();e.dataTransfer.dropEffect='move';const rect=(row.querySelector('.project-header')||row).getBoundingClientRect();row.classList.add(e.clientY<rect.top+rect.height/2?'drop-before':'drop-after');
});
$('#queue-list').addEventListener('drop',async e=>{
  const row=dragTarget(e);if(!dragId)return;e.preventDefault();const source=dragId;dragId=null;
  if(!row){renderQueue();return notice('Chats stay in their project. Move the project heading to change its priority.');}
  const target=source.kind==='project'?row.dataset.projectGroup:row.dataset.task,after=row.classList.contains('drop-after');lastQueueHtml='';
  try{if(source.key!==target){if(source.kind==='project')await reorderProjects(moveBeforeOrAfter(queueGroups().map(g=>g.key),source.key,target,after));else{const group=queueGroups().find(g=>g.key===source.projectKey);await reorderChats(source.projectKey,moveBeforeOrAfter(group.tasks.map(t=>t.id),source.key,target,after));}}}catch(error){notice(error.message);}finally{renderQueue();}
});
$('#queue-list').addEventListener('dragend',()=>{dragId=null;lastQueueHtml='';renderQueue();});
$('#queue-list').addEventListener('keydown',async e=>{
  const handle=e.target.closest('[data-drag-project],[data-drag]');if(!handle||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();
  const project=handle.dataset.dragProject,key=project||handle.dataset.drag,group=queueGroups().find(g=>g.key===handle.closest('.project-group').dataset.projectGroup);
  const ids=project?queueGroups().map(g=>g.key):group.tasks.map(t=>t.id),i=ids.indexOf(key),j=i+(e.key==='ArrowUp'?-1:1);if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];
  try{if(project)await reorderProjects(ids);else await reorderChats(group.key,ids);$(`[${project?'data-drag-project':'data-drag'}="${CSS.escape(key)}"]`)?.focus();}catch(error){notice(error.message);}
});
$('#scene-question').addEventListener('input',e=>{const id=e.target.dataset.qid,p=currentTask()?.pending[0];if(id&&p){questionDrafts[`${currentId}:${p.id}:${id}`]=e.target.value;localStorage.setItem('lounge-room-answers',JSON.stringify(questionDrafts));}});
async function removeTask(id){
  await api(`tasks/${id}/clear`,{});managedQueueId=null;await fetchState();notice('Removed from the queue. The original conversation stays in its app.');
  const undo=document.createElement('button');undo.textContent='Undo';undo.onclick=async()=>{try{await api(`tasks/${id}/restore`,{});await fetchState();delete seen[id];notice('Task restored to the queue.');}catch(error){notice(error.message);}};$('#notice').append(undo);
  if(currentId===id)await nextTask({skipCurrent:false});
}
document.addEventListener('click',async e=>{const manage=e.target.closest('[data-manage]');if(manage){managedQueueId=managedQueueId===manage.dataset.manage?null:manage.dataset.manage;renderQueue();return;}const queueAction=e.target.closest('[data-queue-action]');if(queueAction){try{if(queueAction.dataset.queueAction==='remove')await removeTask(queueAction.dataset.taskId);else{await api(`tasks/${queueAction.dataset.taskId}/classify`,{personal:queueAction.dataset.queueAction==='personal',scope:'task'});await fetchState();notice(queueAction.dataset.queueAction==='personal'?'Marked this task as personal.':'Marked this task as work.');}}catch(error){notice(error.message);}return;}const handoffLink=e.target.closest('[data-native-handoff]');if(handoffLink){e.preventDefault();await openNativeTask(handoffLink.dataset.nativeHandoff);return;}if(e.target.closest('#replay-voice')){unlockAudio();explicitVoiceRetry=true;speak(currentScene?.readAloud||currentScene?.spoken||currentScene?.body);return;}const reveal=e.target.closest('[data-reveal]');if(reveal){e.preventDefault();try{await api(`tasks/${reveal.dataset.reveal}/reveal`,{});}catch(error){notice(error.message);}return;}const el=e.target.closest('[data-focus],[data-action]');if(!el)return;try{if(el.dataset.focus){if(!session){session=true;$('#thought-area').hidden=false;}await focusTask(el.dataset.focus);}if(el.dataset.action){const t=currentTask();if(!t)return;const action=el.dataset.action;el.disabled=true;
if(action==='import-choices'){if(!safeToRefocus())return notice('Finish your current thought before importing.');$('#scene-artifacts').innerHTML=`<article class="artifact-card"><h3>Continue in Lounge</h3><p>Choose a runtime and workspace. You’ll review the available context before anything moves.</p><select id="migration-project" aria-label="Continuation workspace">${state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===t.projectId?'selected':''}>${esc(p.name)} · ${esc(p.path)}</option>`).join('')}</select><p><button data-action="preview-codex">Codex</button> <button data-action="preview-claude-code">Claude Code</button></p></article>`;}
if(action==='preview-codex'||action==='preview-claude-code')await showMigration(action.slice(8));
if(action==='cancel-import'){importPreview=null;await focusTask(t.id,{refresh:false});}
if(action==='confirm-import'){if(!safeToRefocus())return notice('Finish your current thought before confirming.');await api('migration/confirm',{taskId:t.id,previewId:importPreview?.id});importPreview=null;await fetchState();await focusTask(t.id,{refresh:false});notice('Context imported. Give this continuation its next instruction.');}
if(action==='handoff')await openNativeTask(t.id);
if(action==='refresh-source'){await api(`tasks/${t.id}/refresh`,{});await fetchState();await focusTask(t.id,{refresh:false});}
if(action==='refresh'){if(safeToRefocus())await focusTask(t.id,{refresh:false});else notice('Finish your current thought before refreshing.');}
if(action==='open-claude'){if(window.webkit?.messageHandlers?.loungeShell)window.webkit.messageHandlers.loungeShell.postMessage({action:'openClaude'});else notice('Open Claude → Code and use /resume to select the saved session shown here.');}
if(action==='clear'){await removeTask(t.id);}if(action==='later'){await api(`tasks/${t.id}/snooze`,{hours:4});await nextTask();}if(action==='approve'||action==='decline'){await api(`tasks/${t.id}/answer`,{requestId:t.pending[0].id,decision:action==='approve'?'accept':'decline'});await nextTask();}if(action==='interrupt'){await api(`tasks/${t.id}/interrupt`,{});notice('I’ve asked the agent to pause.');}}}catch(error){notice(error.message);}finally{if(el.isConnected)el.disabled=false;}});
document.addEventListener('paste',onPaste);
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.code==='KeyP'){e.preventDefault();changeRotation(state.rotationMode==='work'?'all':'work');return;}if(e.key==='Escape'){cancelAutoSend();stopSpeaking();if(recording)stopMic(false);if(document.body.classList.contains('drawer-open'))closeDrawer();return;}if(e.code==='Space'&&!session&&!textTarget(e.target)&&!document.body.classList.contains('drawer-open')){e.preventDefault();startSession();return;}if((e.metaKey||e.ctrlKey)&&e.key==='\\'){e.preventDefault();document.body.classList.contains('drawer-open')?closeDrawer():openDrawer(true);return;}if(session&&!textTarget(e.target)&&!document.body.classList.contains('drawer-open')&&e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey){$('#thought').focus();}});
await fetchState();warmUpcoming();refreshLoaded().catch(()=>{});
const events=new EventSource('/api/events');
events.addEventListener('state',e=>{
  const previous=state, next=JSON.parse(e.data);state={...state,...next};
  for(const task of state.tasks){const old=previous.tasks.find(t=>t.id===task.id);if(inRotation(task,state.rotationMode)&&old&&!inRotation(old,previous.rotationMode))delete seen[task.id];}
  renderChrome();consumeConductor();warmUpcoming();
  if(!maySurfaceQueue({session,queueStarted,busy,pendingConductor}))return;
  const old=currentId?previous.tasks.find(t=>t.id===currentId):null,t=currentTask();
  if(t&&!t.isConductor&&old&&inRotation(old,previous.rotationMode)&&!inRotation(t,state.rotationMode)){
    if($('#thought').value.trim()||recording)return;
    if(document.body.classList.contains('drawer-open'))return;
    nextTask({skipCurrent:false});return;
  }
  if(t&&currentScene?.saved&&t.cachedBrief?.key!==old?.cachedBrief?.key&&safeToRefocus()&&!speechActive){const target=currentId,run=generation;preparedScene(t).then(scene=>{if(currentId===target&&generation===run&&currentScene?.saved&&safeToRefocus()&&!speechActive)present(scene,t,{read:false});}).catch(()=>{});}
  if(t&&old&&fingerprint(old)!==fingerprint(t)){
    if($('#thought').value.trim()||recording){notice('An update came back. Your thought stays where it is.');return;}
    if(t.status==='waiting'&&t.pending.length){seen[t.id]=fingerprint(t);present({title:t.pending[0].question,body:t.pending[0].context||'Your answer will let this move forward.',spoken:t.pending[0].question,needsReply:true,advance:false},t);}
    else if(t.status==='review'){if(!speechActive&&!document.body.classList.contains('drawer-open'))focusTask(t.id,{refresh:false});else if(!$('#refresh-current')){$('#scene-actions').insertAdjacentHTML('beforeend','<button id="refresh-current" data-action="refresh">Hear the update ↗</button>');notice('An update is ready when you are.');}}
  }
  if(!currentId&&!speechActive&&safeToRefocus()&&!document.body.classList.contains('drawer-open')&&pickNext(state.tasks,seen,state.rotationMode))nextTask({skipCurrent:false});
});
events.onerror=()=>{};
