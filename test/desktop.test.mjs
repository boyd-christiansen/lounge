import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeView,ClaudeDesktopDriver,conversationUrl} from '../lib/desktop/claude.mjs';

const source='https://claude.ai/chat/synthetic-source';
function snapshot({url=source,draft='',messages=[],extra=[]}={}){
  const nodes=[{id:'root',role:'AXWebArea',url,title:'Primary pane'},
    {id:'input',parent:'root',role:'AXTextArea',description:'Write your prompt to Claude',value:draft,settable:true},
    {id:'send',parent:'root',role:'AXButton',title:'Send message',enabled:true},
    {id:'new',parent:'root',role:'AXButton',title:'New',enabled:true},
    {id:'mode',parent:'root',role:'AXRadioButton',title:'Chat and Cowork',value:'1'}];
  messages.forEach((message,i)=>{const id=`message-${i}`;nodes.push({id,parent:'root',role:'AXGroup',description:`Message ${i+1} of ${messages.length}`},
    {id:id+'-heading',parent:id,role:'AXHeading',title:(message.role==='user'?'You said: ':'Claude responded: ')+message.text},
    {id:id+'-heading-text',parent:id+'-heading',role:'AXStaticText',value:'A duplicate accessible heading'},
    {id:id+'-body',parent:id,role:'AXStaticText',value:message.text});});
  return{app:'claude',bundleId:'com.anthropic.claudefordesktop',conversation:url,nodes:[...nodes,...extra],clipped:false};
}
function fixture(options={}){
  const state={url:source,draft:'',messages:[],extra:[],...options},actions=[];
  const native={status:async()=>({available:true,accessibility:true}),async call(method,params){
    if(method==='inspect')return snapshot(state);
    actions.push(params);
    if(params.operation==='setValue'){assert.equal(state.draft,params.expectedValue);state.draft=params.value;}
    else if(params.nodeId==='send'){assert.equal(params.guards[0].expectedValue,state.draft);state.messages.push({role:'user',text:state.draft});state.draft='';}
    return{accepted:true};
  }};
  return{driver:new ClaudeDesktopDriver(native),native,state,actions};
}
test('desktop projection recognizes unified Claude and excludes duplicate heading text',()=>{
  const view=claudeView(snapshot({messages:[{role:'agent',text:'Which format should I use?'}]}));
  assert.equal(view.mode,'unified');assert.equal(view.latest.text,'Which format should I use?');assert.equal(view.latest.role,'agent');assert.equal(view.latest.ordinal,1);
});
test('identical source messages in different turns have distinct identities',()=>{
  const view=claudeView(snapshot({messages:[{role:'agent',text:'Done.'},{role:'user',text:'Again.'},{role:'agent',text:'Done.'}]}));assert.notEqual(view.messages[0].signature,view.messages[2].signature);
});
test('desktop control rejects another app, incomplete views and authentication URLs',()=>{
  assert.throws(()=>claudeView({...snapshot(),bundleId:'other.app'}),/another application/);
  assert.throws(()=>claudeView({...snapshot(),clipped:true}),/incomplete/);
  for(const value of ['https://claude.ai/login','https://claude.ai/oauth/authorize','https://other.example/chat/a','https://user:secret@claude.ai/chat/a'])assert.throws(()=>conversationUrl(value),/supported Claude/);
});
test('a source change or existing Claude draft prevents sending and preserves the draft',async()=>{
  const {driver,state,actions}=fixture({draft:'An unfinished user thought'});
  await assert.rejects(driver.send('New request',{conversation:source}),/already contains a draft/);
  assert.equal(state.draft,'An unfinished user thought');assert.equal(actions.length,0);
  await assert.rejects(driver.send('New request',{conversation:'https://claude.ai/chat/another'}),/conversation changed/);assert.equal(actions.length,0);
});
test('a complete bulk thought is inserted and submitted exactly once with an atomic draft guard',async()=>{
  const {driver,state,actions}=fixture();const text='My complete thought.\n'.repeat(500);
  const result=await driver.send(text,{conversation:source});
  assert.equal(result.delivery,'observed');assert.equal(state.messages[0].text,text);assert.equal(actions.filter(a=>a.operation==='press').length,1);
  assert.deepEqual(actions[1].guards,[{nodeId:'input',expectedValue:text}]);
});
test('Claude’s empty composer newline is guarded exactly without treating it as a user draft',async()=>{
  const {driver,state,actions}=fixture({draft:'\n'});await driver.send('A complete thought',{conversation:source});
  assert.equal(actions[0].expectedValue,'\n');assert.equal(state.messages[0].text,'A complete thought');
});
test('an embedded artifact cannot impersonate the composer or send button',async()=>{
  const {driver,state}=fixture({extra:[{id:'artifact',parent:'root',role:'AXWebArea',url:'https://example.org/artifact'},
    {id:'fake-send',parent:'artifact',role:'AXButton',title:'Send message'},
    {id:'fake-input',parent:'artifact',role:'AXTextArea',description:'Write your prompt to Claude',value:'Untrusted artifact'}]});
  await driver.send('Only the real composer',{conversation:source});assert.equal(state.messages[0].text,'Only the real composer');
});
test('a question changing after insertion keeps the full answer as an unsent draft',async()=>{
  const {driver,native,state,actions}=fixture({messages:[{role:'agent',text:'Which format?'}]});
  const signature=(await driver.inspect()).latest.signature,call=native.call.bind(native);
  native.call=async(method,params)=>{const result=await call(method,params);if(params?.operation==='setValue')state.messages.push({role:'agent',text:'A different question'});return result;};
  await assert.rejects(driver.send('My entire answer',{conversation:source,questionSignature:signature}),/question changed after insertion/);
  assert.equal(state.draft,'My entire answer');assert.equal(actions.filter(a=>a.operation==='press').length,0);
});
test('ambiguous send controls cannot submit the inserted thought',async()=>{
  const {driver,state,actions}=fixture({extra:[{id:'other-send',parent:'root',role:'AXButton',title:'Send message',enabled:true}]});
  await assert.rejects(driver.send('Hold this thought',{conversation:source}),/ambiguous/);
  assert.equal(state.draft,'Hold this thought');assert.equal(actions.filter(a=>a.operation==='press').length,0);
});
test('an old identical user message is not evidence of a newly delivered turn and is never replayed',async()=>{
  const {driver,native,state,actions}=fixture({messages:[{role:'user',text:'Continue'}]});
  const call=native.call.bind(native);native.call=async(method,params)=>{if(params?.operation==='press'){actions.push(params);state.draft='';return{accepted:true};}return call(method,params);};
  driver.waitFor=async predicate=>{assert.equal(predicate(claudeView(snapshot(state))),false);throw new Error('delivery uncertain');};
  await assert.rejects(driver.send('Continue',{conversation:source}),/delivery uncertain/);
  assert.equal(actions.filter(a=>a.operation==='press').length,1);assert.equal(state.messages.length,1);
});
test('desktop driver operations serialize and an ungranted permission never inspects app content',async()=>{
  const {driver,state}=fixture();await Promise.all([driver.send('First',{conversation:source}),driver.send('Second',{conversation:source})]);
  assert.deepEqual(state.messages.map(m=>m.text),['First','Second']);
  let reads=0;const blocked=new ClaudeDesktopDriver({status:async()=>({available:true,accessibility:false}),call:async()=>{reads++;}});
  assert.equal((await blocked.status()).ready,false);assert.equal(reads,0);
});
test('a known sidebar source is opened in the background and its actual URL is verified',async()=>{
  const target='https://claude.ai/chat/selected-source';
  const f=fixture({extra:[{id:'sidebar',parent:'root',role:'AXGroup',description:'Sidebar'},{id:'source-link',parent:'sidebar',role:'AXButton',title:'Selected source'},{id:'source-options',parent:'sidebar',role:'AXPopUpButton',title:'More options for Selected source'}]});
  const call=f.native.call.bind(f.native);f.native.call=async(method,params)=>{if(params?.operation==='press'&&params.nodeId==='source-link'){f.actions.push(params);f.state.url=target;return{accepted:true};}return call(method,params);};
  const view=await f.driver.open({url:target,title:'Selected source'});assert.equal(view.url,target);assert.equal(f.state.messages.length,0);assert.equal(f.actions.length,1);assert.deepEqual(f.actions[0].guards,[{nodeId:'input',expectedValue:''}]);
});
test('model discovery expands native submenus and selections verify the displayed model and effort',async()=>{
  let phase='closed',model='Opus 5.5',effort='Medium';const actions=[];
  const models=['Opus 5.5 For complex work and everyday tasks','Sonnet 5.1 For everyday coding','Haiku 4.5 Fast'];
  const native={status:async()=>({accessibility:true,capabilities:['expandModelMenu']}),async call(method,params){
    if(method==='inspect'){
      const extra=[{id:'picker',parent:'root',role:'AXPopUpButton',description:`Model: ${model} ${effort}`}];
      if(phase!=='closed'){extra.push({id:'model-menu',parent:'root',role:'AXGroup',title:`Model: ${model} ${effort}`,actions:['AXCancel']});
        const items=phase==='root'?[models.find(m=>m.startsWith(model)),`Effort ${effort}`,'More models']:phase==='more'?models:['Low','Medium','High'];
        for(const [i,title]of items.entries())extra.push({id:`option-${i}`,parent:'model-menu',role:'AXMenuItem',title});}
      return snapshot({extra});
    }
    actions.push(params);if(params.operation==='cancel'){phase='closed';return{accepted:true};}
    if(params.nodeId==='picker'){phase=phase==='closed'?'root':'closed';return{accepted:true};}
    const title=(await native.call('inspect')).nodes.find(n=>n.id===params.nodeId)?.title;
    if(title==='More models')phase='more';else if(/^Effort /.test(title))phase='effort';
    else if(models.includes(title)){model=title.match(/^(?:Opus|Sonnet|Haiku) [\d.]+/)[0];phase='closed';}
    else if(['Low','Medium','High'].includes(title)){effort=title;phase='closed';}else throw new Error('Unexpected native selection');return{accepted:true};
  }};
  const driver=new ClaudeDesktopDriver(native),sourceRef={url:source,title:'Selected source'};
  await driver.status();
  const options=await driver.modelOptions(sourceRef);assert.equal(options.models.length,3);assert.deepEqual(options.efforts.map(n=>n.name),['Low','Medium','High']);assert.equal(phase,'closed');
  const sonnet=options.models.find(m=>m.name.startsWith('Sonnet')),high=options.efforts.find(e=>e.name==='High');
  const result=await driver.setModel(sourceRef,{model:sonnet.id,effort:high.id});assert.equal(result.observedLabel,'Model: Sonnet 5.1 High');assert.equal(phase,'closed');assert.equal(actions.some(a=>a.nodeId==='send'),false);assert.equal(actions.some(a=>a.operation==='expandMenu'),true);
});
test('an app permission without an unambiguous one-time choice is a source-only approval',async()=>{
  const f=fixture({extra:[{id:'allow',parent:'root',role:'AXButton',title:'Always allow'},{id:'allow-session',parent:'root',role:'AXButton',title:'Allow for this session'},{id:'deny',parent:'root',role:'AXButton',title:'Deny'}]});
  const view=await f.driver.inspect();assert.equal(view.approval.sourceOnly,true);await assert.rejects(f.driver.approve({url:source},view.approval.signature,'accept'),/Handle this permission/);assert.equal(f.actions.length,0);
});
test('recent-source discovery excludes navigation commands and does not create or message a chat',async()=>{
  const f=fixture({extra:[{id:'sidebar',parent:'root',role:'AXGroup',description:'Sidebar'},{id:'card',parent:'sidebar',role:'AXGroup'},
    {id:'existing',parent:'card',role:'AXButton',title:'Selected research'},{id:'existing-options',parent:'card',role:'AXPopUpButton',description:'More options for Selected research'},
    {id:'rename',parent:'root',role:'AXButton',title:'Selected research, rename session'},{id:'search',parent:'sidebar',role:'AXButton',title:'Search'}],messages:[{role:'agent',text:'Research result.'}]});
  const result=await f.driver.discover('Selected');assert.equal(result.length,1);assert.equal(result[0].url,source);assert.equal(result[0].title,'Selected research');assert.equal(f.actions.length,1);assert.equal(f.actions[0].nodeId,'existing');assert.equal(f.state.messages.length,1);
});
test('parallel sends open and submit each source within the same UI lease',async()=>{
  const second='https://claude.ai/chat/second-source',records=new Map([[source,{draft:'',messages:[]}],[second,{draft:'',messages:[]}]]);let active=source;
  const refs=[{url:source,title:'First source'},{url:second,title:'Second source'}];
  const native={async call(method,params){if(method==='inspect')return snapshot({url:active,...records.get(active),extra:[{id:'sidebar',parent:'root',role:'AXGroup',description:'Sidebar'},...refs.flatMap((r,i)=>[{id:`card-${i}`,parent:'sidebar',role:'AXGroup'},{id:`nav-${i}`,parent:`card-${i}`,role:'AXButton',title:r.title},{id:`more-${i}`,parent:`card-${i}`,role:'AXPopUpButton',title:`More options for ${r.title}`}])]});
    const record=records.get(active);if(params.operation==='setValue'){assert.equal(record.draft,params.expectedValue);record.draft=params.value;}
    else if(params.nodeId==='send'){record.messages.push({role:'user',text:record.draft});record.draft='';}
    else if(params.nodeId.startsWith('nav-'))active=refs[Number(params.nodeId.slice(4))].url;return{accepted:true};}};
  const driver=new ClaudeDesktopDriver(native);await Promise.all(refs.map((r,i)=>driver.send(`Thought ${i+1}`,{source:r,conversation:r.url})));
  assert.equal(records.get(source).messages[0].text,'Thought 1');assert.equal(records.get(second).messages[0].text,'Thought 2');
});
