import test from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../lib/speech.mjs';
import { workerEnvironment } from '../lib/codex.mjs';

function fixture() {
  const calls=[];
  const client={voices:{search:async(params,options)=>{calls.push({type:'voices',params,options});return {voices:[{voiceId:'voice-1',name:'Natural voice'}]};}},textToSpeech:{convert:async(id,params,options)=>{calls.push({type:'speech',id,params,options});return new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.close();}});}}};
  const factoryKeys=[];
  const speech=new Speech({key:'',clientFactory:key=>{factoryKeys.push(key);return client;}});
  return {speech,calls,client,factoryKeys};
}
test('voice credentials stay out of state and speech uses the selected voice through the API client', async () => {
  const {speech,calls}=fixture();
  await assert.rejects(speech.generate({text:'Hello'}),/Connect ElevenLabs/);
  await speech.connect('private-session-key');assert.equal(speech.state().ready,true);assert.doesNotMatch(JSON.stringify(speech.state()),/private-session-key/);
  assert.deepEqual(speech.state().voices,[{id:'voice-1',name:'Natural voice'}]);assert.equal(calls.filter(c=>c.type==='speech').length,0);
  const abort=new AbortController();
  const audio=await speech.generate({text:'A complete briefing.',voiceId:'voice-1',rate:1},abort.signal);assert.equal(audio.length,3);
  const request=calls.at(-1);
  assert.equal(request.id,'voice-1');assert.equal(request.params.modelId,'eleven_multilingual_v2');assert.equal(request.params.text,'A complete briefing.');assert.equal(request.params.voiceSettings.speed,1);
  assert.equal(request.options.maxRetries,0);assert.equal(request.options.abortSignal,abort.signal);
  speech.disconnect();assert.equal(speech.state().ready,false);assert.equal(speech.state().configured,false);
});
test('voice validation and provider failures cannot leak keys or launch malformed requests', async () => {
  const {speech,calls,client}=fixture();await speech.connect('secret');
  await assert.rejects(speech.generate({text:'Hello',voiceId:'../../bad'}),/valid voice/);
  await assert.rejects(speech.generate({text:'Hello',rate:99}),/speaking pace/);assert.equal(calls.filter(c=>c.type==='speech').length,0);
  client.textToSpeech.convert=async()=>{throw {statusCode:401,message:'Private diagnostic body'};};
  await assert.rejects(speech.generate({text:'Hello'}),/Reconnect your ElevenLabs voice key/);
  client.voices.search=async()=>{throw {statusCode:401,message:'private'};};
  await assert.rejects(speech.connect('new-key'),/did not accept/);assert.equal(speech.key,'secret');
});
test('configured credentials initialize voice selection without generating audio or exposing a key', async () => {
  const {speech,calls,factoryKeys}=fixture();speech.key='configured-secret';
  assert.equal(speech.state().configured,true);assert.equal(speech.state().ready,false);
  await speech.initialize();assert.equal(speech.state().ready,true);assert.deepEqual(factoryKeys,['configured-secret']);
  assert.equal(calls.length,1);assert.equal(calls[0].type,'voices');assert.doesNotMatch(JSON.stringify(speech.state()),/configured-secret/);
  assert.equal(speech.state().voices[0].id,'voice-1');
});
test('failed configured connections retain a retry path without claiming they are connected', async () => {
  const speech=new Speech({key:'configured-secret',clientFactory:()=>({voices:{search:async()=>{throw new Error('Private provider diagnostic');}}})});
  await assert.rejects(speech.initialize(),/could not list voices/);assert.equal(speech.state().configured,true);assert.equal(speech.state().ready,false);
  assert.doesNotMatch(JSON.stringify(speech.state()),/configured-secret|Private provider/);
});
test('the speech API credential is not forwarded into agent subprocesses', () => {
  const original={PATH:'/usr/bin',CODEX_BIN:'/app/codex',ELEVENLABS_API_KEY:'private-speech-key'};
  assert.deepEqual(workerEnvironment(original),{PATH:'/usr/bin',CODEX_BIN:'/app/codex'});
  assert.equal(original.ELEVENLABS_API_KEY,'private-speech-key');
});

test('audio prefetch and playback share one paid generation and failures can be retried explicitly',async()=>{
  const {speech,client,calls}=fixture();await speech.connect('secret');let finish;client.textToSpeech.convert=async()=>{calls.push({type:'paid'});await new Promise(resolve=>{finish=resolve;});return new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}});};
  const first=speech.cachedGenerate({text:'Next task.'}),second=speech.cachedGenerate({text:'Next task.'});assert.equal(first,second);finish();await first;await speech.cachedGenerate({text:'Next task.'});assert.equal(calls.filter(c=>c.type==='paid').length,1);
  speech.disconnect();await assert.rejects(speech.cachedGenerate({text:'Next task.'}),/Connect ElevenLabs/);
});

test('payment failures stop automatic prefetch retries until an explicit Listen request',async()=>{
  const {speech,client}=fixture();await speech.connect('secret');let calls=0;client.textToSpeech.convert=async()=>{calls++;throw {statusCode:402};};
  await assert.rejects(speech.cachedGenerate({text:'First task'}),/requires payment/);await assert.rejects(speech.cachedGenerate({text:'Another task'}),/requires payment/);assert.equal(calls,1);
  await assert.rejects(speech.cachedGenerate({text:'First task',retry:true}),/requires payment/);assert.equal(calls,2);
});

test('voice library access is distinguished from exhausted credits without echoing provider diagnostics',async()=>{
  const {speech,client}=fixture();await speech.connect('secret');client.textToSpeech.convert=async()=>{throw {statusCode:402,body:{detail:{status:'payment_required',message:'Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.'}}};};
  await assert.rejects(speech.generate({text:'Hello'}),/free plan includes API access.*Voice Library voice requires a paid plan/);
  client.textToSpeech.convert=async()=>{throw {statusCode:402,body:{detail:{status:'quota_exceeded',message:'private account details secret'}}};};
  await assert.rejects(speech.generate({text:'Hello'}),error=>/credits are exhausted/.test(error.message)&&!error.message.includes('secret'));
});
test('voice choices indicate shared professional voices without exposing sharing identities',async()=>{
  const {speech,client}=fixture();client.voices.search=async()=>({voices:[{voiceId:'library',name:'Brad',category:'professional',sharing:{publicOwnerId:'private-owner'},isOwner:false},{voiceId:'default',name:'George',category:'premade'}]});await speech.connect('secret');
  assert.deepEqual(speech.state().voices.map(v=>[v.name,v.libraryVoice]),[['Brad',true],['George',false]]);assert.doesNotMatch(JSON.stringify(speech.state()),/private-owner/);
});

test('brighter delivery and a faster pace reach the API and use a distinct audio cache',async()=>{
 const {speech,calls}=fixture();await speech.connect('secret');await speech.cachedGenerate({text:'The options are ready.',rate:1.15,tone:'upbeat'});const request=calls.findLast(c=>c.type==='speech');assert.equal(request.params.voiceSettings.speed,1.15);assert.equal(request.params.voiceSettings.stability,.32);assert.equal(request.params.voiceSettings.style,.25);await speech.cachedGenerate({text:'The options are ready.',rate:1.15,tone:'natural'});assert.equal(calls.filter(c=>c.type==='speech').length,2);
});
