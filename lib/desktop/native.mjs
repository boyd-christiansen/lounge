import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DesktopHost} from './host.mjs';

export class NativeDesktop extends EventEmitter {
  constructor(root,{binary=join(root,'data/native/Command Lounge Bridge.app/Contents/MacOS/CommandLoungeBridge'),launch=spawn,platform=process.platform,host=new DesktopHost()}={}){
    super();Object.assign(this,{binary,launch,platform,host});this.pending=new Map();this.sequence=0;
    host.on('disconnected',()=>this.emit('disconnected'));
  }
  get available(){return this.platform==='darwin'&&(this.host.enabled||existsSync(this.binary));}
  start(){
    if(this.process)return;
    if(!this.available)throw new Error('Build the Mac desktop helper with npm run build:desktop.');
    const child=this.launch(this.binary,[],{stdio:['pipe','pipe','ignore']});this.process=child;
    const input=createInterface({input:child.stdout});
    input.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
      const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);
      message.error?pending.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):pending.resolve(message.result);
    });
    const failed=()=>{if(this.process!==child)return;this.process=null;input.close();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Desktop helper disconnected. No operation was retried.'));}this.pending.clear();this.emit('disconnected');};
    child.on('error',failed);child.on('exit',failed);
  }
  call(method,params={}){
    if(this.host.enabled)return this.host.call(method,params);
    this.start();const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Desktop response timed out. Reconcile the app before sending again.'));this.process?.kill();},15000);
      this.pending.set(id,{resolve,reject,timer});this.process.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(!error)return;clearTimeout(timer);this.pending.delete(id);reject(new Error('Desktop command could not be delivered. Nothing was retried.'));});
    });
  }
  async status(){if(!this.available)return{available:false,accessibility:false,apps:[]};return{available:true,...await this.call('status')};}
  close(){this.process?.kill();this.host.close();}
}
