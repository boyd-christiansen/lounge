import {openSync,writeFileSync,readFileSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export function acquireInstance(path){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const nonce=randomUUID();
  for(let attempt=0;attempt<2;attempt++)try{
    const descriptor=openSync(path,'wx',0o600);try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,nonce}));}finally{closeSync(descriptor);}
    return()=>{try{if(JSON.parse(readFileSync(path,'utf8')).nonce===nonce)unlinkSync(path);}catch{}};
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    let previous;try{previous=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('The Lounge instance lock needs recovery. Close other Lounge processes before inspecting it.');}
    if(!Number.isInteger(previous.pid)||previous.pid<=1)throw new Error('The Lounge instance lock is invalid.');
    try{process.kill(previous.pid,0);}catch(probe){if(probe.code==='ESRCH'){unlinkSync(path);continue;}throw probe;}
    throw new Error('Another Lounge process already owns this queue. Close it before opening this app.');
  }
  throw new Error('The Lounge queue could not be reserved.');
}
