// Submission identities exist before provider admission. A stop received while
// the provider is opening a session prevents the turn from being started.
export class ConductorControl {
  constructor(engine){this.engine=engine;this.runs=new Map();}
  record(id){
    if(typeof id!=='string'||! /^[a-zA-Z0-9-]{8,100}$/.test(id))throw new Error('Invalid submission identity');
    let run=this.runs.get(id);
    if(!run){
      for(const [key,value] of this.runs)if(this.runs.size>=64&&(!value.started||value.admitted))this.runs.delete(key);
      let release;run={id,cancelled:false,started:false,admitted:false,ready:new Promise(resolve=>{release=resolve;}),release};this.runs.set(id,run);
    }
    return run;
  }
  begin(id){const run=this.record(id);if(run.cancelled)throw Object.assign(new Error('This thought was stopped before it started'),{status:409});if(run.started)throw new Error('This submission is already running');run.started=true;return run;}
  admitted(run){run.admitted=true;run.release();}
  async cancel(id){
    const run=this.record(id);run.cancelled=true;
    if(!run.started)return{status:'cancelled',taskId:null};
    let task=run.taskId?this.engine.store.get(run.taskId):null;
    if(task?.conductorSubmissionId===run.id){this.engine.store.update(task.id,{stopRequested:true});this.engine.changed();}
    await run.ready;
    task=run.taskId?this.engine.store.get(run.taskId):null;
    if(task?.conductorSubmissionId===run.id&&['running','waiting'].includes(task.status)&&(!run.turnId||task.turnId===run.turnId))await this.engine.interrupt(task.id);
    return{status:task?this.engine.store.get(task.id).status:'cancelled',taskId:task?.id||null};
  }
  stopped(task){return !!task.stopRequested||!!this.runs.get(task.conductorSubmissionId)?.cancelled;}
}
