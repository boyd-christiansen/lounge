import {randomUUID,createHash} from 'node:crypto';
import {parseModel} from './providers.mjs';
import {projectGroups} from '../public/rotation.js';
const conflict=message=>Object.assign(new Error(message),{status:409});
const text=(value,limit)=>String(value||'').trim().slice(0,limit);
function place(existing,entries){const moved=new Set(entries.map(e=>e.id)),result=existing.filter(id=>!moved.has(id));let last=-1;for(const e of [...entries].sort((a,b)=>a.position-b.position)){const index=Math.min(result.length,Math.max(last+1,e.position-1));result.splice(index,0,e.id);last=index;}return result;}
export class TaskPlans {
  constructor(engine){this.engine=engine;this.store=engine.store;}
  baseline(state){return createHash('sha256').update(JSON.stringify([state.orderRevision,state.projectOrderRevision,state.sortMode,state.projectOrder,state.tasks.filter(t=>!t.isConductor&&t.status!=='done').map(t=>[t.id,t.projectKey,t.status==='snoozed',t.isPersonal]).sort((a,b)=>a[0].localeCompare(b[0]))])).digest('hex');}
  preview(input,sourceRun){
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>12)throw new Error('Propose between one and twelve tasks');
    const state=this.engine.state(),groups=projectGroups(state.tasks,{mode:'all',projectOrder:state.projectOrder,projects:state.projects,sortMode:state.sortMode});
    const items=input.items.map((item,index)=>{
      const name=text(item.projectName,100)||'Inbox';let project=state.projects.find(p=>p.id===item.projectId&&p.id!=='lounge');
      if(item.projectId&&!project)throw new Error('Choose a registered project or leave its workspace unassigned');
      if(!project)project=state.projects.find(p=>p.name.toLowerCase()===name.toLowerCase()&&!['inbox','lounge'].includes(p.id));
      const matches=groups.filter(g=>g.name.toLowerCase()===name.toLowerCase());if(matches.length>1&&!project)throw new Error('That project name is ambiguous. Ask which project the user means.');const group=matches[0];
      const key=project&&project.id!=='inbox'?`project:${project.id}`:group?.key||`named-project:${name.toLowerCase()}`;
      const title=text(item.title,220),brief=text(item.brief,4000),priority=item.priority;
      if(!title||!['critical','high','normal','low'].includes(priority))throw new Error('Each task needs a title and suggested priority');
      for(const field of ['projectPosition','position'])if(!Number.isInteger(item[field])||item[field]<1||item[field]>1000)throw new Error('Each task needs a proposed project and chat position');
      if(item.personal!==undefined&&typeof item.personal!=='boolean')throw new Error('Personal classification must be explicit');
      const defaultProvider=parseModel(state.inference.workers.model).providerId;const application=item.application||(['codex','claude-code'].includes(defaultProvider)?defaultProvider:'codex');if(!['codex','claude-code'].includes(application))throw new Error('Choose Codex or Claude Code for new work');
      return{id:`proposal-${index+1}`,title,brief,priority,application,projectId:project?.id||'inbox',projectKey:key,projectName:project&&project.id!=='inbox'?project.name:group?.name||name,workspaceUnassigned:!project,projectPosition:item.projectPosition,position:item.position,...(item.personal!==undefined?{personal:item.personal}:{})};
    });
    if(items.some(item=>state.tasks.some(t=>!t.isConductor&&t.status!=='done'&&t.projectKey===item.projectKey&&t.title.toLowerCase()===item.title.toLowerCase())))throw new Error('One of these tasks is already queued. Reuse it or propose a distinct task.');
    if(new Set(items.map(i=>i.projectKey+'\n'+i.title.toLowerCase())).size!==items.length)throw new Error('This plan contains duplicate tasks');
    const plannedGroups=new Map();for(const item of items){const previous=plannedGroups.get(item.projectKey);if(previous&&previous.position!==item.projectPosition)throw new Error('Use the same project position for tasks in one project');plannedGroups.set(item.projectKey,{id:item.projectKey,position:item.projectPosition});}
    const byId=new Map(state.tasks.map(t=>[t.id,t])),orderedTasks=this.store.snapshot().map(t=>byId.get(t.id)),validKeys=new Set(state.tasks.filter(t=>!t.isConductor&&t.status!=='done').map(t=>t.projectKey));
    const existingKeys=[...new Set([...state.projectOrder.filter(key=>validKeys.has(key)),...groups.map(g=>g.key),...validKeys])];
    const projectOrder=place(existingKeys,[...plannedGroups.values()]),chatOrders={};
    for(const key of plannedGroups.keys())chatOrders[key]=place(orderedTasks.filter(t=>!t.isConductor&&t.status!=='done'&&t.projectKey===key).map(t=>t.id),items.filter(i=>i.projectKey===key).map(i=>({id:i.id,position:i.position})));
    return{id:randomUUID(),status:'proposed',summary:text(input.summary,2000),sourceRun,baseline:this.baseline(state),items,projectOrder,chatOrders,projects:projectOrder.map((key,index)=>({key,name:items.find(i=>i.projectKey===key)?.projectName||state.tasks.find(t=>t.projectKey===key)?.projectName||key,position:index+1,newCount:items.filter(i=>i.projectKey===key).length})),createdAt:new Date().toISOString()};
  }
  current(planId){const owner=this.store.all().find(t=>t.isConductor&&t.taskPlan?.id===planId);if(!owner)throw conflict('This plan was replaced. Review the current proposal.');return{owner,plan:owner.taskPlan};}
  confirm(planId,{runId=null,direct=false}={}){
    const {owner,plan}=this.current(planId);if(plan.status==='added')return plan;
    if(plan.status!=='proposed')throw conflict('This plan is no longer awaiting approval');
    if(!direct&&(!runId||runId===plan.sourceRun))throw new Error('Show the proposal and wait for a later user confirmation before adding tasks');
    if(direct&&['running','waiting'].includes(owner.status))throw conflict('Finish the current exchange before approving this plan');
    if(this.baseline(this.engine.state())!==plan.baseline)throw conflict('The queue changed since this proposal. Ask Lounge to refresh the plan before approving.');
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      const ids=new Map();for(const item of plan.items){const task=this.store.create({title:item.title,brief:item.brief,projectId:item.projectId,application:item.application,priority:item.priority,...('personal'in item?{personal:item.personal}:{})});
        this.store.update(task.id,{portableSession:true,queueProject:{key:item.projectKey,name:item.projectName},workspaceUnassigned:item.workspaceUnassigned});ids.set(item.id,task.id);}
      const oldOrder=this.store.getMeta('queueOrder',[]),members=new Set(Object.values(plan.chatOrders).flat());
      this.store.setMeta('queueOrder',[...Object.values(plan.chatOrders).flat().map(id=>ids.get(id)||id),...oldOrder.filter(id=>!members.has(id))]);
      this.store.setMeta('orderRevision',this.store.getMeta('orderRevision',0)+1);this.store.setMeta('projectOrder',plan.projectOrder);this.store.setMeta('projectOrderRevision',this.store.getMeta('projectOrderRevision',0)+1);
      const added={...plan,status:'added',createdIds:[...ids.values()],addedAt:new Date().toISOString()};this.store.update(owner.id,{taskPlan:added});this.store.event(owner.id,'task_plan_added',{planId,count:ids.size});this.store.db.exec('COMMIT');this.engine.changed();return added;
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  discard(planId){const {owner,plan}=this.current(planId);if(plan.status==='added')throw new Error('This plan was already added; remove individual tasks from the queue instead');this.store.update(owner.id,{taskPlan:{...plan,status:'discarded'}});this.engine.changed();return{status:'discarded'};}
}
