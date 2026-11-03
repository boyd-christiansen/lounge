import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';

// Private parent/child pipes inside Lounge.app, never a renderer or network API.
export class DesktopHost extends EventEmitter {
  constructor({input=process.stdin,output=process.stdout,enabled=process.env.LOUNGE_DESKTOP_HOST==='1',timeout=45000}={}){
    super();Object.assign(this,{input,output,enabled,timeout});this.sequence=0;this.pending=new Map();
    if(enabled){this.reader=createInterface({input});this.reader.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(message.kind!=='desktop.response')return;
      const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);
      message.error?request.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):request.resolve(message.result);
    });this.reader.on('close',()=>this.fail());}
  }
  call(method,params={}){
    if(!this.enabled)return Promise.reject(new Error('Open Lounge.app to use the bundled desktop bridge.'));
    if(!['status','requestPermission','inspect','act','reveal','setEnabled'].includes(method))return Promise.reject(new Error('Unsupported desktop-host operation.'));
    const id=`desktop-${++this.sequence}`;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Desktop response timed out. No action was retried.'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});this.output.write(JSON.stringify({kind:'desktop.request',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('Desktop host disconnected. No action was retried.'));}});
    });
  }
  fail(){this.enabled=false;for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('The Lounge window closed. Desktop control stopped.'));}this.pending.clear();this.emit('disconnected');}
  close(){this.reader?.close();this.fail();}
}
