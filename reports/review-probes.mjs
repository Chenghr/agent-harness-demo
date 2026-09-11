// Review-only reproductions. Assertions confirm defects in the reviewed baseline;
// passing these probes does NOT mean those defects have been fixed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from '../server/harness.mjs';
import { ProcessManager, delay, deferred } from '../server/core.mjs';
const results=[];
async function waitFor(check){const until=Date.now()+3000;while(!check()){assert.ok(Date.now()<until,'probe timeout');await delay(5);}}
async function probe(name, fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-review-'));
 let h;
 try {const create=(options={})=>(h=new Harness({root,speed:0,...options}));results.push({name,...await fn(create,root)});}
 finally {await h?.close();fs.rmSync(root,{recursive:true,force:true});}
}
await probe('append message can remain unread when final model response arrives',async create=>{
 const gate=deferred();let calls=0;const h=create({modelAdapter:{async complete(){calls++;await gate.promise;return {text:'old answer',calls:[]};}}});
 const s=h.get(h.create().id);await waitFor(()=>calls===1);h.message(s.id,'补充：请解释折扣逻辑','append');gate.resolve();await waitFor(()=>h.controls.size===0);
 assert.equal(s.status,'completed');assert.equal(calls,1);assert.equal(s.agents.main.pendingMessages.length,1);
 return {confirmed:true,status:s.status,modelRequests:calls,unreadMessages:s.agents.main.pendingMessages.length};
});
await probe('medium sized file is clipped without a retrievable artifact',async create=>{
 const h=create(),s=h.get(h.create({autoStart:false}).id);const content='a'.repeat(5000)+'END_EVIDENCE';fs.writeFileSync(path.join(s.workspace,'long.mjs'),content);
 const result=await h.invoke(s,s.agents.main,'file_read',{path:'long.mjs'});
 assert.equal(result.truncated,true);assert.equal(result.artifactId,undefined);assert.equal(s.artifacts.length,0);assert.ok(!JSON.stringify(result).includes('END_EVIDENCE'));
 return {confirmed:true,fileCharacters:content.length,returnedCharacters:JSON.stringify(result).length,artifactCount:s.artifacts.length};
});
await probe('normal command exit can leave a same-group background descendant alive',async (_create,root)=>{
 const manager=new ProcessManager(()=>{});let result;
 try{
  result=await manager.run({sessionId:'review',agentId:'main',cwd:root,args:['-e',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});console.log(c.pid);process.exit(0);"],timeout:3000});
  const descendantPid=Number(result.output.trim());process.kill(descendantPid,0);
  assert.equal(manager.list().length,0);
  return {confirmed:true,parentExitCode:result.exitCode,trackedResources:manager.list().length,descendantStillAlive:true};
 }finally{if(result?.pid){try{process.kill(-result.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}}
});
await probe('handoff excludes older uncompressed evidence',async create=>{
 const h=create(),s=h.get(h.create({autoStart:false}).id),a=s.agents.main;
 h.context.add(s,a,[{role:'assistant',content:'Confirmed evidence: UNIQUE_OLD_FACT=42'}]);
 for(let i=0;i<6;i++)h.context.add(s,a,[{role:'assistant',content:'recent ordinary message '+i}]);
 assert.equal(a.summary,'');await h.requestSwitch(s.id,'demo-focused');
 const current=JSON.stringify(h.context.build(s,a,h.models.get(a.model)).messages);
 assert.ok(!current.includes('UNIQUE_OLD_FACT'));assert.ok(h.store.events(s.id).some(e=>JSON.stringify(e).includes('UNIQUE_OLD_FACT')));
 return {confirmed:true,originalEvidenceOnDisk:true,evidenceInHandoff:false};
});
await probe('an active oldest action prevents pruning completed action history',async create=>{
 const h=create(),s=h.get(h.create({autoStart:false}).id),a=s.agents.main;
 const child=h.agent(s,{agentId:'review-child',parentId:a.id,goal:'wait',model:a.model});child.status='running';
 const ctrl=new AbortController();const waiting=h.invoke(s,a,'agent_wait',{}, {signal:ctrl.signal});const caught=waiting.catch(()=>{});
 for(let i=0;i<220;i++)await h.invoke(s,a,'file_list',{});
 const count=s.actions.length;ctrl.abort();await caught;child.status='cancelled';assert.ok(count>200);
 return {confirmed:true,retainedActions:count,documentedHistoryTarget:200};
});
await probe('resource aliases bypass the agents directory write rule',async create=>{
 const h=create(),s=h.get(h.create({autoStart:false}).id),a=s.agents.main;a.loadedTools.push('file_write');
 const relative='./agents/review-child/cart.mjs';s.grants.push({id:'review-grant',tool:'file_write',path:relative});
 const result=await h.invoke(s,a,'file_write',{path:relative,content:'// review-only fixture'});
 assert.ok(fs.existsSync(path.join(s.workspace,'agents/review-child/cart.mjs')));
 return {confirmed:true,acceptedAlias:result.path};
});
await probe('failed child setup leaves an idle child with no controller',async create=>{
 const h=create(),s=h.get(h.create({autoStart:false}).id),a=s.agents.main;
 fs.unlinkSync(path.join(s.workspace,'README.md'));
 assert.throws(()=>h.spawnAgent(s,a,'inspect'),{code:'ENOENT'});
 const child=Object.values(s.agents).find(x=>x.parentId===a.id);
 assert.equal(child.status,'idle');assert.equal(h.controls.size,0);
 const ctrl=new AbortController();let settled=false;
 const waiting=h.waitChildren(s,a,ctrl.signal).finally(()=>{settled=true;}).catch(()=>{});
 await delay(70);const waitsWithoutController=!settled;ctrl.abort();await waiting;child.status='failed';
 assert.equal(waitsWithoutController,true);
 return {confirmed:true,childStatusBeforeCleanup:'idle',controllers:0,parentWaitsWithoutController:waitsWithoutController};
});
console.log(JSON.stringify({purpose:'defect reproduction, not acceptance tests',results},null,2));
