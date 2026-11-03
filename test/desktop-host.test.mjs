import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {DesktopHost} from '../lib/desktop/host.mjs';

test('native host correlates responses and ignores unsolicited or duplicate replies',async()=>{
  const input=new PassThrough(),output=new PassThrough(),host=new DesktopHost({input,output,enabled:true});
  const sent=[];output.on('data',bytes=>sent.push(JSON.parse(bytes)));
  const a=host.call('status'),b=host.call('inspect',{app:'claude'});
  input.write(JSON.stringify({kind:'desktop.response',id:'unrelated',result:{}})+'\n');
  input.write(JSON.stringify({kind:'desktop.response',id:sent[1].id,result:{conversation:'selected'}})+'\n');
  input.write(JSON.stringify({kind:'desktop.response',id:sent[0].id,result:{accessibility:true}})+'\n');
  assert.deepEqual(await a,{accessibility:true});assert.deepEqual(await b,{conversation:'selected'});assert.equal(host.pending.size,0);
  host.close();
});
test('a timed-out native action is never replayed and disconnect rejects pending work',async()=>{
  const input=new PassThrough(),output=new PassThrough(),host=new DesktopHost({input,output,enabled:true,timeout:10});let writes=0;output.on('data',()=>writes++);
  await assert.rejects(host.call('act',{app:'claude'}),/No action was retried/);assert.equal(writes,1);
  const pending=host.call('status');host.fail();await assert.rejects(pending,/closed/);assert.equal(host.pending.size,0);
  await assert.rejects(host.call('act'),/Open Lounge.app/);host.close();
});
