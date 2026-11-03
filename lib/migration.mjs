import { createHash, randomUUID } from 'node:crypto';
import { applicationFor } from '../public/applications.js';
import { sourceUrl } from '../public/flow.js';
import { now } from './store.mjs';

export function migrationVersion(t) {
  return createHash('sha256').update(JSON.stringify([t.threadId,t.application,t.external,t.status,t.brief,t.summary,t.sourceHistory,t.messages,t.pending,t.sourceTurnId,t.sourceTurnStatus,t.sourceUpdatedAt])).digest('hex');
}
function idle(t) {
  if(t.isConductor || ['running','waiting','done'].includes(t.status) || t.pending?.length || t.sourceTurnStatus==='inProgress' || t.sourceControlReserved || t.observationReserved || t.migrationReserved) throw new Error('Pause this task and resolve its outstanding requests before moving it.');
}
export class Migration {
  constructor(engine) { this.engine=engine; this.store=engine.store; }
  async preview({taskId,application,projectId,proposedInRun=null}) {
    if(!['codex','claude-code'].includes(application))throw new Error('Choose Codex or Claude Code for the continuation.');
    let task=this.store.get(taskId); idle(task);
    if(!task.external)throw new Error('This conversation is already managed by Lounge.');
    this.engine.project(projectId || task.projectId);
    // Explicit single-source refresh; no background/bulk migration or inference.
    await this.engine.refreshSource(taskId);
    task=this.store.get(taskId); idle(task);
    const entries=(task.sourceHistory || []).slice(-8).map(m=>({role:m.role,text:String(m.text || '').slice(0,3500)}));
    const preview={id:randomUUID(),taskId,application,projectId:projectId || task.projectId,proposedInRun,at:now(),version:migrationVersion(task),title:task.title,
      source:{application:applicationFor(task),threadId:task.threadId,url:sourceUrl(task),title:task.sourceTitle || task.title,cwd:task.sourceCwd || null,project:task.sourceProjectName || null,observedAt:task.sourceObservedAt},
      context:{goal:task.brief.slice(0,5000),overview:task.overview || '',latestResult:task.summary.slice(0,12000),entries},
      coverage:'Saved goal, latest result, and up to eight bounded recent messages. This is a new linked conversation, not the full original transcript.',
      gaps:['Finish or pause work in the original app before confirming this import.','Attachments, generated files, browser state, and consumer-app tools are not copied.','Project instructions and permissions come from the selected local workspace.','The original conversation stays intact. Later edits there require another explicit import.'],status:'preview'};
    this.store.setMeta('migration:'+taskId,preview);this.engine.changed();return preview;
  }
  confirm({taskId,previewId,runId=null}) {
    const preview=this.store.getMeta('migration:'+taskId);
    if(!preview || preview.id!==previewId)throw new Error('Preview this conversation before importing it.');
    if(preview.status==='confirmed')return this.store.get(taskId);
    if(runId && runId===preview.proposedInRun)throw new Error('Wait for Boyd’s confirmation in a later exchange.');
    if(Date.now()-Date.parse(preview.at)>15*60*1000)throw new Error('The import preview expired. Prepare a fresh preview.');
    const t=this.store.get(taskId);idle(t);
    if(migrationVersion(t)!==preview.version)throw new Error('The source changed after preview. Review a fresh preview before importing.');
    this.engine.project(preview.projectId);
    const origin={...preview.source,importedAt:now(),coverage:preview.coverage,context:preview.context};
    // One synchronous commit: no provider turn is started by confirmation.
    const out=this.store.once('migration:'+preview.id,()=>{
      const moved=this.store.update(taskId,{application:preview.application,provider:preview.application,projectId:preview.projectId,external:false,threadId:null,turnId:null,runtimeProvider:null,runtimeSessionId:null,sourceUrl:null,sourceCwd:null,sourceTitle:null,sourceProjectName:null,sourceHistory:[],sourceTurnId:null,sourceTurnStatus:null,sourceUpdatedAt:null,sourceObservedAt:null,desktopMonitoringPaused:true,inference:null,pending:[],messages:[],status:'queued',personal:typeof t.personal==='boolean'?t.personal:!!this.engine.state().tasks.find(x=>x.id===taskId)?.isPersonal,lastError:null,summary:'Context imported. Ready for your next instruction.',origins:[...(t.origins || []),origin],continuationContext:preview.context,continuationNeedsPrompt:true,portableSession:true,cachedBrief:null,overviewKey:null,statusText:'Ready for your next instruction.',handoff:null});
      this.store.setMeta('migration:'+taskId,{...preview,status:'confirmed'});this.store.event(taskId,'continuation_imported',{application:preview.application});return moved;
    });
    this.engine.changed();return out;
  }
  async handoff(taskId) {
    const t=this.store.get(taskId);idle(t);
    if(t.external || !t.threadId || !t.portableSession)throw new Error('Only a persisted Lounge continuation with native tools can be handed off.');
    const adapter=this.engine.providers.adapter(t.runtimeProvider || t.provider);
    if(!adapter.handoff)throw new Error('This runtime has no verified release mechanism.');
    this.store.update(taskId,{migrationReserved:true});this.engine.changed();
    try {
      await adapter.handoff(t.threadId,{cwd:this.engine.project(t.projectId).path});
      const handoff={at:now(),sessionId:t.threadId,application:applicationFor(t),instructions:applicationFor(t)==='claude-code'?`In Claude’s Code tab, use /resume and select session ${t.threadId}. Or run: claude --resume ${t.threadId}`:'Open this saved conversation in Codex. To return, preview and import its latest context into a fresh Lounge continuation.'};
      this.store.update(taskId,{external:true,sourceCwd:this.engine.project(t.projectId).path,sourceTitle:t.title,sourceUrl:sourceUrl(t),handoff,sourceTurnStatus:null,status:'review'});
      this.store.event(taskId,'native_handoff',{application:applicationFor(t)});this.engine.changed();
      let nativeOpened=false;
      if(adapter.openDesktop)try{nativeOpened=await adapter.openDesktop(t.threadId,{cwd:this.engine.project(t.projectId).path});}catch{}
      const out=this.store.update(taskId,{migrationReserved:false,handoff:{...handoff,nativeOpened,...(nativeOpened?{instructions:'The saved session was opened in Claude’s Code tab. Return to Lounge by importing its latest context into a fresh linked continuation.'}:{})}});
      this.engine.changed();return out;
    } catch(error) {this.store.update(taskId,{migrationReserved:false});this.engine.changed();throw error;}
  }
}
