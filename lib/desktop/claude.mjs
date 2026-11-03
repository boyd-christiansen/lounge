import {createHash} from 'node:crypto';

const label=node=>node?.title||node?.description||node?.value||'';
const error=(code,message)=>Object.assign(new Error(message),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const canonical=value=>value.replace(/\s+/g,' ').trim();
export function conversationUrl(value){
  let url;try{url=new URL(value);}catch{throw error('wrong_target','Open a supported Claude conversation.');}
  if(url.protocol!=='https:'||url.hostname!=='claude.ai'||url.username||url.password||url.port||!(/^\/chat\/[A-Za-z0-9-]+\/?$/.test(url.pathname)||['/','/new'].includes(url.pathname)||/^\/project\/[A-Za-z0-9-]+\/?$/.test(url.pathname)))throw error('wrong_target','This is not a supported Claude conversation.');
  return url.origin+url.pathname.replace(/\/$/,'');
}
function unique(nodes,predicate,name,optional=false){const matches=nodes.filter(predicate);if(optional&&!matches.length)return null;if(matches.length!==1)throw error('ambiguous_control',`Claude's ${name} is unavailable or ambiguous. No action was sent.`);return matches[0];}
export function claudeView(snapshot){
  if(snapshot.app!=='claude'||snapshot.bundleId!=='com.anthropic.claudefordesktop')throw error('wrong_app','The desktop bridge returned another application.');
  if(snapshot.clipped)throw error('incomplete_view','The Claude view is incomplete. No action was sent.');
  const url=conversationUrl(snapshot.conversation),all=snapshot.nodes;
  const byAllId=new Map(all.map(n=>[n.id,n]));
  const frame=unique(all,n=>n.role==='AXWebArea'&&(()=>{try{return conversationUrl(n.url)===url;}catch{return false;}})(),'conversation frame');
  const nodes=all.filter(node=>{let current=node;const seen=new Set();while(current&&!seen.has(current.id)){seen.add(current.id);if(current.role==='AXWebArea')return current.id===frame.id;current=byAllId.get(current.parent);}return false;});
  const composer=unique(nodes,n=>n.role==='AXTextArea'&&/^(Write your prompt to Claude|Reply to Claude|Message Claude)$/i.test(label(n)),'message input',true);
  if(composer?.valueTruncated)throw error('incomplete_draft','The entire existing draft could not be verified.');
  const controls=nodes.filter(n=>['AXButton','AXPopUpButton','AXRadioButton','AXMenuItem','AXLink'].includes(n.role));
  const byId=new Map(nodes.map(n=>[n.id,n])),descendants=id=>nodes.filter(n=>{let current=n;const seen=new Set();while(current.parent!==undefined&&!seen.has(current.id)){seen.add(current.id);if(current.parent===id)return true;current=byId.get(current.parent);if(!current)return false;}return false;});
  const inHeading=node=>{let parent=byId.get(node.parent);while(parent){if(['AXHeading','AXToolbar'].includes(parent.role))return true;parent=byId.get(parent.parent);}return false;};
  const messages=nodes.filter(n=>/^Message \d+ of \d+$/i.test(label(n))).map(n=>{
    const inside=descendants(n.id),heading=inside.find(x=>x.role==='AXHeading'&&/^(Claude responded:|You said:)/i.test(label(x)));
    if(!heading)return null;
    const role=/^You said:/i.test(label(heading))?'user':'agent';
    const parts=inside.filter(x=>x.role==='AXStaticText'&&!inHeading(x)).map(x=>x.value||x.title).filter(Boolean);
    const text=parts.filter((text,i)=>i===0||text!==parts[i-1]).join('\n').slice(0,18000);
    const ordinal=Number(label(n).match(/^Message (\d+)/i)[1]);return{text,role,id:n.id,ordinal,signature:digest(JSON.stringify([url,role,ordinal,text]))};
  }).filter(Boolean);
  const linkNodes=nodes.filter(n=>n.role==='AXLink'&&/^https:\/\//.test(n.url||''));
  const artifacts=linkNodes.filter(n=>/artifact|download|\.pdf|\.docx|\.pptx|\.xlsx/i.test(n.url+' '+label(n))).slice(-12).map(n=>{let url;try{const parsed=new URL(n.url);url=parsed.hostname==='claude.ai'&&!parsed.search&&!parsed.username&&!parsed.password?parsed.href:snapshot.conversation;}catch{url=snapshot.conversation;}return{title:label(n).slice(0,220),url};});
  const once=controls.filter(n=>n.role==='AXButton'&&/^(Allow once|Approve once|Allow this time)$/i.test(label(n)));
  const deny=controls.filter(n=>n.role==='AXButton'&&/^(Deny|Decline|Don't allow)$/i.test(label(n)));
  let approval=null;
  if(once.length===1&&deny.length===1){const lastText=nodes.filter(n=>n.role==='AXStaticText').slice(-35).map(n=>n.value||n.title||'').join('\n').slice(-6000);approval={allow:once[0],deny:deny[0],text:lastText,signature:digest(JSON.stringify([url,lastText,label(once[0]),label(deny[0])]))};}
  else if(controls.some(n=>n.role==='AXButton'&&/^(Allow(?:\s|$)|Always allow(?:\s|$)|Approve(?:\s|$))/i.test(label(n)))&&controls.some(n=>n.role==='AXButton'&&/^(Deny|Decline|Don't allow|Cancel)$/i.test(label(n)))){
    const text=nodes.filter(n=>n.role==='AXStaticText').slice(-35).map(n=>n.value||n.title||'').join('\n').slice(-6000);
    approval={sourceOnly:true,text,signature:digest(JSON.stringify([url,text,'source-only']))};
  }
  return {url,composer,controls,nodes,messages,latest:messages.at(-1)||null,artifacts,approval,mode:controls.some(n=>n.role==='AXRadioButton'&&label(n)==='Chat and Cowork')?'unified':'unknown',running:controls.some(n=>n.role==='AXButton'&&/^Stop(?: response| generating| task)?$/i.test(label(n))),snapshot};
}

// These commands are app-specific. Raw AX handles are not model-facing tools.
export class ClaudeDesktopDriver{
  constructor(native){this.native=native;this.lease=Promise.resolve();this.capabilities=new Set();}
  exclusive(work){const next=this.lease.then(work);this.lease=next.catch(()=>{});return next;}
  async _inspect(){return claudeView(await this.native.call('inspect',{app:'claude'}));}
  inspect(){return this.exclusive(()=>this._inspect());}
  status(){return this.exclusive(async()=>{const status=await this.native.status();this.capabilities=new Set(status.capabilities||[]);if(!status.accessibility)return{...status,ready:false};const view=await this._inspect();return{...status,ready:!!view.composer,mode:view.mode};});}
  assertDraftEmpty(view){if(!view.composer)throw error('input_unavailable','Open a Claude conversation with a message input.');if(view.composer.value?.trim())throw error('draft_present','Claude already contains a draft. It was preserved.');}
  assertUnattended(view){if(view.snapshot.foreground)throw error('source_in_use','Claude is in the foreground. Return to Lounge before controlling this conversation.');}
  assertTarget(view,expected){if(conversationUrl(expected)!==view.url)throw error('wrong_target','The Claude conversation changed. No action was sent.');}
  async press(view,node,guards=[]){if(node.enabled===false)throw error('disabled_control','That Claude control is disabled.');return this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:node.id,operation:'press',guards});}
  send(text,{conversation,questionSignature,source}={}){return this.exclusive(async()=>{
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw new Error('Provide one complete thought under 100,000 characters.');
    if(source)await this._open(source);
    let view=await this._inspect();this.assertTarget(view,conversation);this.assertDraftEmpty(view);this.assertUnattended(view);
    if(source&&!questionSignature&&view.latest?.role==='agent'&&/\?\s*$/.test(view.latest.text)&&view.latest.signature!==source.frontier)throw error('source_question_unseen','A new question arrived in Claude. Resume monitoring before replying. No message was sent.');
    if(view.running&&!questionSignature)throw error('busy','Claude is still working in this conversation. No new turn was submitted.');
    const priorUserOrdinal=Math.max(0,...view.messages.filter(m=>m.role==='user').map(m=>m.ordinal));
    if(questionSignature&&view.latest?.signature!==questionSignature)throw error('question_changed','The displayed Claude question changed. Your answer was not sent.');
    // Set and send are separate guarded actions. A changed draft is never replaced.
    await this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:view.composer.id,operation:'setValue',value:text,expectedValue:view.composer.value||''});
    view=await this._inspect();this.assertTarget(view,conversation);this.assertUnattended(view);
    if(view.composer?.value!==text)throw error('draft_changed','The Claude draft changed after insertion. Nothing was submitted.');
    if(questionSignature&&view.latest?.signature!==questionSignature)throw error('question_changed','The Claude question changed after insertion. The complete answer remains as a draft.');
    const send=unique(view.controls,n=>n.role==='AXButton'&&label(n)==='Send message','send control');
    await this.press(view,send,[{nodeId:view.composer.id,expectedValue:text}]);
    // Delivery can be uncertain after a UI action. Never replay this automatically.
    const delivered=await this.waitFor(next=>{if(/^https:\/\/claude.ai\/chat\//.test(view.url)&&next.url!==view.url)throw error('delivery_uncertain','The conversation changed after submission. Reconcile before retrying.');return next.messages.some(m=>m.role==='user'&&m.ordinal>priorUserOrdinal&&canonical(m.text)===canonical(text))||(!next.composer?.value&&next.running);});
    return{conversation:delivered.url,delivery:'observed',view:delivered};
  });}
  interrupt(conversation,{source,onlyIfRunning=false}={}){return this.exclusive(async()=>{if(source)await this._open(source);const view=await this._inspect();this.assertTarget(view,conversation);this.assertUnattended(view);if(onlyIfRunning&&!view.running)return{accepted:false};const stop=unique(view.controls,n=>n.role==='AXButton'&&/^Stop(?: response| generating| task)?$/i.test(label(n)),'stop control');await this.press(view,stop);return{accepted:true};});}
  reveal(source){return this.exclusive(async()=>{const view=await this._open(source);return this.native.call('reveal',{app:'claude',conversation:view.snapshot.conversation});});}
  sourceTitle(view){return label(view.controls.find(n=>/rename session$/i.test(label(n)))).replace(/,? rename session$/i,'');}
  sidebarSources(view){const byId=new Map(view.nodes.map(n=>[n.id,n]));return view.controls.filter(n=>n.role==='AXButton').flatMap(node=>{
    let parent=byId.get(node.parent),inside=false;while(parent){if(/^Sidebar$/i.test(label(parent))){inside=true;break;}parent=byId.get(parent.parent);}if(!inside)return[];
    const menu=view.controls.find(n=>n.parent===node.parent&&n.role==='AXPopUpButton'&&label(n).startsWith('More options for '));if(!menu)return[];
    const title=label(menu).slice('More options for '.length);if(!label(node).startsWith(title))return[];return[{node,title}];
  });}
  discover(query){return this.exclusive(async()=>{const original=await this._inspect();this.assertUnattended(original);this.assertDraftEmpty(original);const originalTitle=this.sourceTitle(original);
    const titles=this.sidebarSources(original).filter(s=>s.title.toLowerCase().includes(String(query||'').trim().toLowerCase())).map(s=>s.title).slice(0,8),found=[];
    try{for(const title of titles){let view=await this._inspect();this.assertUnattended(view);this.assertDraftEmpty(view);
      const matches=this.sidebarSources(view).filter(s=>s.title===title);if(matches.length!==1)continue;
      await this.press(view,matches[0].node,[{nodeId:view.composer.id,expectedValue:view.composer.value||''}]);
      view=await this.waitFor(next=>/^https:\/\/claude.ai\/chat\//.test(next.url)&&this.sourceTitle(next)===title);
      if(!found.some(s=>s.url===view.url))found.push({id:new URL(view.url).pathname.split('/').pop(),url:view.url,title,preview:(view.messages[0]?.text||view.latest?.text||'Existing Claude conversation').slice(0,600)});
    }}finally{if(originalTitle&&/^https:\/\/claude.ai\/chat\//.test(original.url))await this._open({url:original.url,title:originalTitle});}
    return found;
  });}
  open(source){return this.exclusive(()=>this._open(source));}
  async _open(source){
    let view=await this._inspect();const expected=conversationUrl(source.url);
    if(view.url===expected)return view;
    this.assertUnattended(view);this.assertDraftEmpty(view);
    const recent=this.sidebarSources(view).filter(s=>s.title===source.title);
    if(recent.length===1){await this.press(view,recent[0].node,[{nodeId:view.composer.id,expectedValue:view.composer.value||''}]);return this.waitFor(next=>next.url===expected);}
    const search=unique(view.controls,n=>n.role==='AXButton'&&label(n)==='Search','search control');await this.press(view,search,[{nodeId:view.composer.id,expectedValue:view.composer.value||''}]);
    view=await this.waitFor(next=>next.nodes.some(n=>['AXTextArea','AXTextField','AXComboBox'].includes(n.role)&&/^search/i.test([label(n),n.placeholder].join(' '))));
    let input=unique(view.nodes,n=>['AXTextArea','AXTextField','AXComboBox'].includes(n.role)&&/^search/i.test([label(n),n.placeholder].join(' ')),'search input');
    if(input.value)throw error('draft_present','Claude search already contains a draft. It was preserved.');
    const query=source.title||new URL(expected).pathname.split('/').pop();
    await this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:input.id,operation:'setValue',value:query,expectedValue:''});
    const searchLinks=next=>{const byId=new Map(next.nodes.map(n=>[n.id,n]));return next.controls.filter(n=>{if(n.role!=='AXLink')return false;try{if(conversationUrl(n.url)!==expected)return false;}catch{return false;}let p=byId.get(n.parent);while(p){if(p.role==='AXGroup'&&label(p)==='Search')return true;p=byId.get(p.parent);}return false;});};
    try{view=await this.waitFor(next=>searchLinks(next).length===1);}
    catch(cause){const current=await this._inspect();const ownInput=current.nodes.find(n=>['AXTextArea','AXTextField','AXComboBox'].includes(n.role)&&/^search/i.test(label(n))&&n.value===query);const close=current.controls.filter(n=>n.role==='AXButton'&&label(n)==='Close');
      if(current.url===view.url&&ownInput&&close.length===1&&!current.snapshot.foreground)await this.press(current,close[0],[{nodeId:ownInput.id,expectedValue:query}]);
      throw error('navigation_unavailable','Claude did not expose an unambiguous source result. Open that conversation in Claude once, then retry. No message was sent.');}
    const match=unique(searchLinks(view),()=>true,'search result');
    this.assertUnattended(view);await this.press(view,match);
    view=await this.waitFor(next=>next.url===expected);
    this.assertTarget(view,expected);return view;
  }
  approve(source,signature,decision){return this.exclusive(async()=>{const view=await this._open(source);this.assertUnattended(view);
    if(!['accept','decline','cancel'].includes(decision))throw error('invalid_decision','Choose an explicit approval decision.');
    if(!view.approval||view.approval.signature!==signature)throw error('approval_changed','The Claude approval changed. No decision was sent.');
    if(view.approval.sourceOnly)throw error('source_approval_required','Handle this permission in Claude. Lounge cannot apply a persistent or ambiguous grant.');
    const choice=decision==='accept'?view.approval.allow:view.approval.deny;
    const guards=view.nodes.filter(n=>n.role==='AXStaticText'&&n.value).slice(-35).map(n=>({nodeId:n.id,expectedValue:n.value}));
    await this.press(view,choice,guards);return{accepted:true};
  });}
  modelItems(view){
    const byId=new Map(view.nodes.map(n=>[n.id,n]));
    return view.controls.filter(node=>{if(!['AXMenuItem','AXRadioButton','AXButton'].includes(node.role))return false;let parent=byId.get(node.parent);while(parent){if(parent.role==='AXGroup'&&/^(Model:|More models$|Effort(?:\s|$))/i.test(label(parent)))return true;parent=byId.get(parent.parent);}return false;});
  }
  modelChoices(view){return this.modelItems(view).filter(n=>/\b(opus|sonnet|haiku|fable)\b/i.test(label(n)));}
  effortChoices(view){return this.modelItems(view).filter(n=>/^(Low|Medium|High|Extra high|Max)(?:\b|$)/i.test(label(n)));}
  async modelMenu(source){let view=await this._open(source);this.assertUnattended(view);this.assertDraftEmpty(view);
    if(view.running||view.approval)throw error('busy','Finish the current Claude turn before choosing a model.');
    if(this.modelItems(view).length){await this.dismissModelMenu(source);view=await this._inspect();}
    const picker=unique(view.controls,n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n)),'model picker');await this.press(view,picker);
    return this.waitFor(next=>this.modelItems(next).length>0);
  }
  async dismissModelMenu(source){let view=await this._inspect();this.assertTarget(view,source.url);if(!this.modelItems(view).length)return view;this.assertUnattended(view);
    const menu=unique(view.nodes,n=>n.role==='AXGroup'&&/^Model:/i.test(label(n)),'model menu');
    if(menu.actions?.includes('AXCancel'))await this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:menu.id,operation:'cancel'});
    else{const picker=unique(view.controls,n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n)),'model picker');await this.press(view,picker);}
    return this.waitFor(next=>this.modelItems(next).length===0);
  }
  async modelSubmenu(view,node){const before=this.modelItems(view).map(label).join('\n');this.assertUnattended(view);
    if(node.actions?.includes('AXShowMenu'))await this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:node.id,operation:'showMenu'});
    else if(this.capabilities.has('expandModelMenu'))await this.native.call('act',{app:'claude',conversation:view.snapshot.conversation,nodeId:node.id,operation:'expandMenu'});
    else await this.press(view,node);
    return this.waitFor(next=>this.modelItems(next).length>0&&this.modelItems(next).map(label).join('\n')!==before);
  }
  modelOptions(source){return this.exclusive(async()=>{let models=[],efforts=[],current=null;
    try{let view=await this.modelMenu(source);current=label(view.controls.find(n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n))));models=this.modelChoices(view);const more=this.modelItems(view).find(n=>/^More models$/i.test(label(n)));
      if(more){view=await this.modelSubmenu(view,more);models=[...models,...this.modelChoices(view)];await this.dismissModelMenu(source);view=await this.modelMenu(source);}
      const effort=this.modelItems(view).find(n=>/^Effort(?:\s|$)/i.test(label(n)));
      if(effort){view=await this.modelSubmenu(view,effort);efforts=this.effortChoices(view);}
      const options=nodes=>[...new Map(nodes.map(node=>[label(node),{id:encodeURIComponent(label(node)),name:label(node)}])).values()];
      return{models:options(models),efforts:options(efforts),current};
    }finally{await this.dismissModelMenu(source);}
  });}
  setModel(source,{model,effort}){return this.exclusive(async()=>{try{let view=await this.modelMenu(source);
    let option=this.modelChoices(view).find(n=>encodeURIComponent(label(n))===model);
    if(!option){const more=unique(this.modelItems(view),n=>/^More models$/i.test(label(n)),'additional models');view=await this.modelSubmenu(view,more);option=unique(this.modelChoices(view),n=>encodeURIComponent(label(n))===model,'requested model');}
    const marker=label(option).match(/\b(?:Opus|Sonnet|Haiku|Fable)(?:\s+\d+(?:\.\d+)*)?/i)?.[0];
    if(!marker)throw error('selection_uncertain','The requested source model could not be identified.');
    await this.press(view,option);await this.waitFor(next=>next.controls.some(n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n))&&label(n).toLowerCase().includes(marker.toLowerCase())));
    let effortMarker=null;
    if(effort){view=await this.modelMenu(source);const picker=unique(this.modelItems(view),n=>/^Effort(?:\s|$)/i.test(label(n)),'effort menu');view=await this.modelSubmenu(view,picker);
      const choice=unique(this.effortChoices(view),n=>encodeURIComponent(label(n))===effort,'requested effort');effortMarker=label(choice).match(/^(Low|Medium|High|Extra high|Max)/i)?.[0];await this.press(view,choice);}
    const confirmed=await this.waitFor(next=>{const current=next.controls.find(n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n)));return current&&label(current).toLowerCase().includes(marker.toLowerCase())&&(!effortMarker||label(current).toLowerCase().includes(effortMarker.toLowerCase()));});
    const current=confirmed.controls.find(n=>n.role==='AXPopUpButton'&&/^Model:/i.test(label(n)));return{model,effort:effort||null,observedLabel:label(current)};
    }finally{await this.dismissModelMenu(source);}
  });}
  async waitFor(predicate,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){await pause(200);const view=await this._inspect();if(predicate(view))return view;}throw error('delivery_uncertain','Claude changed, but the result could not be verified. Reconcile the conversation before retrying.');}
}
