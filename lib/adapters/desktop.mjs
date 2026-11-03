import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {conversationUrl} from '../desktop/claude.mjs';
import {applicationFor,desktopSourceUrl} from '../../public/applications.js';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class DesktopAdapter extends EventEmitter {
  constructor(native,driver,{configured=native.host?.enabled===true,pollInterval=2500}={}){
    super();Object.assign(this,{native,driver,configured,pollInterval});this.id='desktop';this.name='Existing Claude conversations';this.roles=['worker'];this.newWork=false;this.billing='existing app';this.canObserve=true;this.ready=false;this.error=null;this.permission=false;this.sessions=new Map();this.pending=new Map();this.sources=new Map();
    native.on?.('disconnected',()=>{this.ready=false;this.error='The Lounge window disconnected.';this.emit('disconnected',new Error(this.error));});
  }
  state(){return{available:this.configured,permission:this.permission,ready:this.ready,error:this.error,applications:['claude-chat','claude-cowork'],newConversations:'agent-server'};}
  source(task){
    const application=applicationFor(task);
    if(!task.external||!['claude-chat','claude-cowork'].includes(application))throw new Error('The desktop bridge attaches only existing Claude chat/Cowork conversations.');
    const url=desktopSourceUrl(task);
    if(!url)throw new Error('Attach a specific existing Claude conversation before using the bridge.');
    return{application,url,id:new URL(url).pathname.split('/').pop(),title:task.sourceTitle||task.title,frontier:task.sourceTurnId||null};
  }
  canControl(task){if(!this.ready)return false;try{this.source(task);return true;}catch{return false;}}
  async check(){
    if(!this.configured)return this.state();
    const status=await this.native.status();this.permission=status.accessibility===true;if(!this.permission)this.ready=false;return this.state();
  }
  async requestPermission(){if(!this.configured)throw new Error('Open Lounge.app to enable its bundled bridge.');await this.native.call('requestPermission');return this.check();}
  async connect(){
    if(!this.configured)throw new Error('Open Lounge.app to use the bundled desktop bridge.');
    try{const status=await this.driver.status();this.permission=status.accessibility===true;
      if(!this.permission)throw new Error('Enable Lounge in macOS System Settings → Privacy & Security → Accessibility.');
      if(!status.ready)throw new Error('Open Chat and Cowork in Claude Desktop, then reconnect.');
      const enabled=await this.native.call('setEnabled',{enabled:true});if(!enabled.enabled)throw new Error('macOS has not enabled Lounge desktop control.');
      this.ready=true;this.error=null;this.emit('connected');return this.state();
    }catch(error){this.ready=false;this.error=error.message;throw error;}
  }
  async listModels(){return[];}
  async disconnect(){this.ready=false;for(const session of this.sessions.values())this.finish(session,'interrupted');await this.native.call('setEnabled',{enabled:false}).catch(()=>{});this.error=null;this.emit('disconnected',new Error('Desktop control was disabled. The source app retains its work.'));return this.state();}
  async openSession(options){
    if(!options.source)throw new Error('New conversations use the agent server or SDK. The bridge requires an existing source.');
    if(!this.ready)throw new Error('Connect the desktop bridge before continuing this existing chat.');
    const source=this.source(options.source);
    if([...this.sessions.values()].some(s=>s.active&&s.source.url===source.url))throw new Error('This source already has an active Lounge turn.');
    const id=randomUUID();this.sessions.set(id,{id,source,active:false});this.sources.set(source.id,source);return{id};
  }
  async startTurn({sessionId,text,observeOnly=false}){
    const session=this.sessions.get(sessionId);if(!session||session.active)throw new Error('The desktop source is unavailable or already active.');
    session.active=true;session.turnId=randomUUID();session.stopped=false;
    session.run=this.run(session,text,observeOnly).catch(error=>{
      if(['unsupported_view','window_unavailable','accessibility_required','app_closed'].includes(error.code)){this.ready=false;this.error='Claude’s desktop view is unavailable. Unlock the Mac or open Chat and Cowork, then reconnect and resume monitoring. Its agents keep their work.';for(const active of this.sessions.values())this.finish(active,'interrupted',this.error);this.emit('disconnected',new Error(this.error));}
      else this.finish(session,'failed',error.message);
    });return{id:session.turnId};
  }
  async run(session,text,observeOnly){
    let view=await this.driver.open(session.source);session.before=view.latest?.signature;
    if(!observeOnly){if(view.latest?.role==='agent'&&/\?\s*$/.test(view.latest.text)&&view.latest.signature!==session.source.frontier)throw new Error('A new question arrived in Claude. Resume monitoring to show it before sending a reply. No message was sent.');const delivered=await this.driver.send(text,{conversation:session.source.url,source:session.source});view=delivered.view;session.sent=true;}
    let stable=0,previous=null;
    while(!session.stopped){
      if(view.approval){
        const decision=await this.wait(session,{kind:'approval',sourceOnly:!!view.approval.sourceOnly,question:view.approval.sourceOnly?'Claude needs an approval in its app':'Claude needs your approval',context:view.approval.text,questions:[],fingerprint:view.approval.signature});
        if(decision.expired){view=decision.view;stable=0;previous=null;continue;}
        await this.driver.approve(session.source,view.approval.signature,decision.decision);stable=0;
      }else if(!view.running&&view.latest?.role==='agent'&&/\?\s*$/.test(view.latest.text)&&(observeOnly||view.latest.signature!==session.before)){
        const response=await this.wait(session,{kind:'question',question:view.latest.text,context:'Answer the question in this existing Claude conversation.',questions:[{id:'reply',question:view.latest.text}],fingerprint:view.latest.signature});
        if(response.expired){view=response.view;stable=0;previous=null;continue;}
        const answer=response.answers?.reply||response.text;if(!answer)throw new Error('The source question needs a complete answer.');
        session.before=view.latest.signature;
        const delivered=await this.driver.send(answer,{conversation:session.source.url,source:session.source,questionSignature:view.latest.signature});view=delivered.view;stable=0;
      }else if(!view.running&&view.latest?.role==='agent'&&(observeOnly||view.latest.signature!==session.before)){
        stable=view.latest.signature===previous?stable+1:0;
        if(stable>=1){this.emit('event',{providerId:this.id,sessionId:session.id,type:'message',phase:'final_answer',text:view.latest.text||'Claude returned a result. Open the source to review it.',artifacts:view.artifacts,sourceSignature:view.latest.signature});return this.finish(session,'completed');}
      }else stable=0;
      previous=view.latest?.signature;
      await delay(this.pollInterval);if(session.stopped)return;
      let observed=null;
      while(!session.stopped&&!observed){try{observed=await this.driver.open(session.source);}catch(error){
        if(!['source_in_use','draft_present'].includes(error.code))throw error;
        // The user owns the app while it is in use. Never act on the stale
        // snapshot or discard their draft to service another source.
        await delay(this.pollInterval);
      }}
      if(session.stopped)return;view=observed;
    }
  }
  wait(session,details){return new Promise((resolve,reject)=>{const id=`desktop:${randomUUID()}`;this.pending.set(id,{sessionId:session.id,resolve,reject});this.emit('request',{providerId:this.id,sessionId:session.id,id,blocking:true,...details});
    const watch=async()=>{while(this.pending.has(id)&&session.active){await delay(this.pollInterval);if(!this.pending.has(id)||!session.active)return;
      let view;try{view=await this.driver.open(session.source);}catch(error){if(['source_in_use','draft_present'].includes(error.code))continue;this.pending.delete(id);reject(error);return;}
      const current=details.kind==='approval'?view.approval?.signature:view.latest?.signature;
      if(current!==details.fingerprint){this.pending.delete(id);this.emit('event',{providerId:this.id,sessionId:session.id,type:'request.resolved',requestId:id});resolve({expired:true,view});return;}
    }};watch().catch(reject);
  });}
  respond(request,result){const item=this.pending.get(request.id);if(!item||item.sessionId!==request.sessionId)throw new Error('This source request expired.');this.pending.delete(request.id);item.resolve(result);}
  reject(request,message){this.respond(request,{decision:'decline',text:message,success:false});}
  finish(session,status,error=null){if(!session.active)return;session.active=false;session.stopped=true;
    for(const[id,p]of this.pending)if(p.sessionId===session.id){this.pending.delete(id);p.reject(new Error('The desktop turn stopped.'));}
    this.emit('event',{providerId:this.id,sessionId:session.id,type:'turn.ended',status,error});
  }
  async interrupt(sessionId,turnId){const session=this.sessions.get(sessionId);if(!session?.active||session.turnId!==turnId)throw new Error('No matching desktop turn to pause.');
    await this.driver.interrupt(session.source.url,{source:session.source,onlyIfRunning:true});this.finish(session,'interrupted');
  }
  async release(id){const session=this.sessions.get(id);if(session?.active)this.finish(session,'interrupted');this.sessions.delete(id);}
  close(){for(const session of this.sessions.values())this.finish(session,'interrupted');this.native.close();}
  async previewCurrent(application='claude-chat'){
    if(!this.ready)throw new Error('Connect the desktop bridge first.');
    const view=await this.driver.inspect();if(!/^https:\/\/claude.ai\/chat\//.test(view.url))throw new Error('Open the existing Claude conversation you want to bring into Lounge.');
    const title=view.controls.find(n=>/rename session/i.test(n.description||'')||/rename session/i.test(n.title||''));
    const source={id:new URL(view.url).pathname.split('/').pop(),url:view.url,application,title:(title?.title||title?.description||view.snapshot.windowTitle||'Claude conversation').replace(/,? rename session$/i,''),preview:(view.messages[0]?.text||view.latest?.text||'Existing Claude app conversation').slice(0,600),provider:'desktop',updatedAt:new Date().toISOString()};
    this.sources.set(source.id,source);return source;
  }
  async discover(cursor,query,{application='claude-chat'}={}){this.requireReady();if(cursor)throw new Error('Claude app discovery is limited to visible recents and pinned conversations. Refine the topic.');if(!['claude-chat','claude-cowork'].includes(application))throw new Error('Choose a Claude app conversation type.');
    const data=(await this.driver.discover(query)).map(source=>({...source,application,provider:'desktop',updatedAt:new Date().toISOString()}));for(const source of data)this.sources.set(source.id,source);return{data,nextCursor:null,scope:'visible-recents'};
  }
  async readSource(id,{source}={}){
    const known=source?this.source(source):this.sources.get(id);if(!known)throw new Error('Preview the exact Claude source before importing it.');
    const view=await this.driver.open(known);return{...known,preview:view.messages[0]?.text||known.preview||'',updatedAt:new Date().toISOString(),provider:'desktop'};
  }
  async sourceHistory(id,{source}={}){
    const known=source?this.source(source):this.sources.get(id);if(!known)throw new Error('This source has not been selected.');
    const view=await this.driver.open(known);
    return{entries:view.messages.slice(-8).map(m=>({role:m.role,text:m.text})),latest:{id:view.latest?.signature||null,status:view.approval?'waiting':view.running?'inProgress':'completed',summary:view.messages.findLast(m=>m.role==='agent')?.text||''},artifacts:view.artifacts,approval:view.approval?{signature:view.approval.signature,question:'Claude needs your approval'}:null};
  }
  requireReady(){if(!this.ready)throw new Error('Connect the desktop bridge before controlling this source.');}
  async revealSource(task){this.requireReady();return this.driver.reveal(this.source(task));}
  async sourceModels(task){this.requireReady();const result=await this.driver.modelOptions(this.source(task));return{models:result.models.map(({id,name})=>({id,name})),efforts:result.efforts.map(({id,name})=>({id,name})),current:result.current||null};}
  async setSourceModel(task,selection){this.requireReady();return this.driver.setModel(this.source(task),selection);}
}
