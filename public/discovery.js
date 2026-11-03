import {plainText} from './flow.js';

// Metadata belongs to tool state, not a spoken confirmation.
const technical=/\b(?:batch|thread)[ _-]?(?:id|[0-9a-f]{8})\b|\b[0-9a-f]{8}-[0-9a-f-]{20,}\b|\/(?:Users|home|private|tmp)\/|proposedInRun|execution ownership|preview is restored|search batch|later exchange/i;
function humanText(value='',limit=45){
  const lines=String(value).split(/\n+/).filter(line=>!technical.test(line));
  return plainText(lines.join(' ')).split(/\s+/).slice(0,limit).join(' ').replace(/[,;:]$/,'');
}
export function chatDescription(candidate={}){
  const value=humanText(candidate.description||candidate.preview||candidate.sourcePreview||'',40);
  return value||'Open the source to check the details of this conversation.';
}
export function importPreviewScene(batch,{question='',context=''}={}){
  const selected=batch.candidates.filter(c=>question.toLowerCase().includes(c.title?.toLowerCase()));
  const candidates=selected.length?selected:batch.candidates;
  const app=batch.application==='codex'?'Codex':batch.application==='claude-code'?'Claude Code':'Claude';
  if(candidates.length===1){
    const c=candidates[0],description=humanText(context,45)||chatDescription(c);
    return {title:'I found this conversation.',body:`“${c.title}”\n\n${description}\n\nShould I add it to your queue?`,spoken:`I found “${c.title}” in ${app}. ${description} Should I add it to your queue?`,needsReply:true,advance:false};
  }
  return {title:`I found ${candidates.length} conversations.`,body:'Here’s what each one is about. Which should I add to your queue?',spoken:`I found ${candidates.length} possible conversations in ${app}. ${candidates.slice(0,2).map(c=>`“${c.title}”: ${chatDescription(c)}`).join(' ')} Which should I add to your queue?`,needsReply:true,advance:false};
}

const noise=new Set('a an the i my me we our can could would you please hey find search look looking for in on of to and or this that chat chats conversation conversations thread threads chatgpt codex was were working about with it'.split(' '));
export function searchWords(query=''){
  return [...new Set(String(query).match(/[\p{L}\p{N}]+/gu)||[])].filter(w=>w.length>1&&!noise.has(w.toLowerCase())).slice(0,8);
}
export function rankChatMatches(candidates,query){
  const words=searchWords(query).map(w=>w.toLowerCase());
  if(!words.length)return [];
  return candidates.map(c=>{
    const title=String(c.title||'').toLowerCase(),preview=String(c.preview||'').toLowerCase();
    const hits=words.filter(w=>title.includes(w)||preview.includes(w));
    const score=words.reduce((n,w)=>n+(title.includes(w)?4:preview.includes(w)?1:0),0)+(title.includes(query.toLowerCase())?8:0);
    return {c,score,hits:hits.length};
  }).filter(x=>x.hits>=Math.min(2,words.length)).sort((a,b)=>b.score-a.score||String(b.c.updatedAt).localeCompare(String(a.c.updatedAt))).map(x=>x.c);
}
