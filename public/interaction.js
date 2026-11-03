const modifiers=['control','alt','shift','meta'];
const modifierKeys={Fn:null,ControlLeft:'control',ControlRight:'control',AltLeft:'alt',AltRight:'alt',ShiftLeft:'shift',ShiftRight:'shift',MetaLeft:'meta',MetaRight:'meta'};
export const DEFAULT_DICTATION_SHORTCUT={code:'Fn',modifiers:[]};
export const isModifierCode=code=>Object.hasOwn(modifierKeys,code);
export function validateShortcut(value){
  if(value===null)return null;
  if(!value||typeof value.code!=='string'||!Array.isArray(value.modifiers)||value.modifiers.some(m=>!modifiers.includes(m))||new Set(value.modifiers).size!==value.modifiers.length)throw new Error('Choose a valid dictation shortcut');
  if(!isModifierCode(value.code)&&! /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(value.code))throw new Error('Use Fn, a modifier key, or a keyboard shortcut');
  if(!isModifierCode(value.code)&&!value.modifiers.length&&!/^F\d+$/.test(value.code))throw new Error('Add a modifier so ordinary typing does not pause playback');
  return{code:value.code,modifiers:modifiers.filter(m=>value.modifiers.includes(m)&&m!==modifierKeys[value.code])};
}
export function shortcutEvent(event){
  const code=event.code==='Function'?'Fn':event.code;
  if(!code||event.repeat||event.isComposing)return null;
  return{code,modifiers:modifiers.filter(m=>event[({control:'ctrlKey',alt:'altKey',shift:'shiftKey',meta:'metaKey'})[m]]&&m!==modifierKeys[code]),pressed:event.pressed??event.type!=='keyup'};
}
export function matchesShortcut(shortcut,event){return !!shortcut&&!!event&&event.pressed&&shortcut.code===event.code&&modifiers.every(m=>shortcut.modifiers.includes(m)===event.modifiers.includes(m));}
export function shortcutLabel(shortcut,mac=true){
  if(!shortcut)return'Off';
  const labels=mac?{control:'⌃',alt:'⌥',shift:'⇧',meta:'⌘'}:{control:'Ctrl',alt:'Alt',shift:'Shift',meta:'Meta'};
  const key=shortcut.code==='Fn'?'Fn / Globe':isModifierCode(shortcut.code)?({ControlLeft:'Left Control',ControlRight:'Right Control',AltLeft:'Left Option',AltRight:'Right Option',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',MetaLeft:'Left Command',MetaRight:'Right Command'})[shortcut.code]:shortcut.code.replace(/^Key|^Digit/,'');
  return[...shortcut.modifiers.map(m=>labels[m]),key].join(' + ');
}
// Fn release and further taps do not signal completion of external dictation.
// Only a completed commit or an explicit resume releases the audio hold.
export function createDictationHold(){
  let snapshot=null,keyDown=false;
  return{
    get held(){return snapshot!==null;},get keyDown(){return keyDown;},get snapshot(){return snapshot;},
    press(value){if(!snapshot)snapshot=value;keyDown=true;},releaseKey(){keyDown=false;},
    complete(){const value=snapshot;snapshot=null;keyDown=false;return value;}
  };
}
export function canResumeReadAloud({held=false,keyDown=false,session=false,busy=false,recording=false,drawer=false,editing=false,draft='',answers=[]}={}){
  return held&&!keyDown&&session&&!busy&&!recording&&!drawer&&!editing&&!draft.trim()&&!answers.some(value=>String(value||'').trim());
}
export function playbackPosition(playback,at){
  const offset=Number.isFinite(playback?.offset)?playback.offset:0;
  const elapsed=Number.isFinite(playback?.startedAt)&&Number.isFinite(at)?Math.max(0,at-playback.startedAt):0;
  return Math.max(0,offset+elapsed);
}
// Decisions use explicit intent and actual tool outcomes, rather than a model's
// numeric confidence. A new task remains in focus even if work was dispatched.
export function transitionDecision(scene,{actions=[],instruction='',activeTaskIds=[]}={}){
  const explicitNext=scene.transition==='next'&&/\b(?:move on|next task|then next|go to (?:the )?next|work through (?:the |my )?queue)\b/i.test(instruction)&&! /\b(?:don['’]?t|do not|without|not|never|stay|wait)\b/i.test(instruction);
  if(explicitNext)return'next';
  if(scene.needsReply||actions.some(a=>a.tool==='lounge_capture'||a.tool==='lounge_confirm_plan'))return'stay';
  if(scene.transition==='stay')return'stay';
  const handedOff=actions.some(a=>['lounge_dispatch','lounge_send','lounge_answer'].includes(a.tool)&&activeTaskIds.includes(a.taskId));
  if(handedOff&&scene.transition==='next')return'next';
  return scene.transition==='ask'||scene.transition==='next'||scene.advance?'ask':'stay';
}
