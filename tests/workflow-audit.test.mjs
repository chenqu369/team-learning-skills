import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
let api={};try{api=await import('../runtime/shared/workflow-audit.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const check=(...args)=>{assert.equal(typeof api.auditWorkflow,'function','must implement workflow coverage/freshness audit');return api.auditWorkflow(...args);};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'learning-audit-'));
 const write=(name,data)=>{fs.writeFileSync(path.join(root,name),JSON.stringify(data));return name;};
 const digest=name=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
 write('used.json',[{record_id:'r1',course:'A'}]);write('current.json',[{record_id:'r1',course:'A'}]);
 write('plan.json',[{id:'r1'}]);write('readback.json',{verified:true});
 const spec={schema_version:1,workflow:'certificates',phase:'preflight',run_started_at:new Date(Date.now()-60000).toISOString(),sources:[{id:'roster',kind:'manual',stage:'final-roster',used:{path:'used.json',sha256:digest('used.json')},current:{path:'current.json',captured_at:new Date().toISOString()}}],coverage:{expected:{path:'current.json',key_fields:['record_id']},actual:[{path:'plan.json',key_fields:['id'],status:'planned'}]}};
 return {root,write,digest,spec,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('DiyLLM already in same-version snapshot but absent from plan is blocked',()=>{
 const f=fixture();try{f.write('used.json',[{record_id:'r1'},{record_id:'diyllm'}]);f.write('current.json',[{record_id:'r1'},{record_id:'diyllm'}]);f.spec.sources[0].used.sha256=f.digest('used.json');const r=check(f.spec,f.root);assert.equal(r.ready,false);assert.deepEqual(r.missing,[JSON.stringify(['diyllm'])]);}finally{f.close();}
});
test('late additions invalidate downstream steps instead of keeping old completion',()=>{
 const f=fixture();try{f.write('current.json',[{record_id:'r1'},{record_id:'r2'}]);const r=check(f.spec,f.root);assert.equal(r.ready,false);assert.ok(r.changed_sources.includes('roster'));assert.ok(r.invalidated_stages.includes('receipt'));}finally{f.close();}
});
test('same count identity replacement still invalidates current input',()=>{
 const f=fixture();try{f.write('current.json',[{record_id:'r2'}]);assert.equal(check(f.spec,f.root).ready,false);}finally{f.close();}
});
test('completed status needs readback evidence and planned rows cannot claim complete',()=>{
 const f=fixture();try{f.spec.phase='complete';assert.equal(check(f.spec,f.root).ready,false);f.spec.coverage.actual[0].status='completed';assert.equal(check(f.spec,f.root).ready,false);f.spec.coverage.actual[0].evidence_file='readback.json';assert.equal(check(f.spec,f.root).ready,true);}finally{f.close();}
});
test('explicit excluded items need a reason; unknown and duplicate assignments block',()=>{
 const f=fixture();try{f.spec.coverage.actual[0].status='excluded';assert.equal(check(f.spec,f.root).ready,false);f.spec.coverage.actual[0].reason='负责人明确排除本角色';assert.equal(check(f.spec,f.root).ready,true);f.write('plan.json',[{id:'r1'},{id:'r1'}]);assert.equal(check(f.spec,f.root).ready,false);f.write('plan.json',[{id:'r1'},{id:'foreign'}]);assert.equal(check(f.spec,f.root).ready,false);}finally{f.close();}
});
test('resuming with an external snapshot predating this run is blocked',()=>{
 const f=fixture();try{f.spec.run_started_at='2099-01-02T00:00:00Z';assert.equal(check(f.spec,f.root).ready,false);}finally{f.close();}
});
test('an old signed audit cannot be replayed with its old run start time',()=>{
 const f=fixture();try{const old=new Date(Date.now()-86400000).toISOString();f.spec.run_started_at=old;f.spec.sources[0].current.captured_at=old;assert.equal(check(f.spec,f.root).ready,false);}finally{f.close();}
});
test('Base snapshots require stable source identity, full pagination and matching revision',()=>{
 const f=fixture();try{const s=f.spec.sources[0];s.kind='base';s.used.manifest='used.manifest.json';s.current.manifest='current.manifest.json';const m={base_token:'base',table_id:'tbl',rev:1,records_count:1,has_more:false,query_context:{record_scope:'all_records'}};f.write(s.used.manifest,m);f.write(s.current.manifest,{...m,has_more:true});assert.equal(check(f.spec,f.root).ready,false);f.write(s.current.manifest,{...m,rev:2});assert.equal(check(f.spec,f.root).ready,false);f.write(s.current.manifest,m);assert.equal(check(f.spec,f.root).ready,true);}finally{f.close();}
});
test('multi-role source rows expand without silently dropping a certificate type',()=>{
 const f=fixture();try{const rows=[{record_id:'r1',roles:['normal','excellent']}];f.write('used.json',rows);f.write('current.json',rows);f.spec.sources[0].used.sha256=f.digest('used.json');f.spec.coverage.expected.key_fields=['record_id','roles'];f.write('plan.json',[{id:'r1',role:'normal'}]);f.spec.coverage.actual[0].key_fields=['id','role'];assert.equal(check(f.spec,f.root).ready,false);f.write('plan.json',[{id:'r1',role:'normal'},{id:'r1',role:'excellent'}]);assert.equal(check(f.spec,f.root).ready,true);}finally{f.close();}
});
test('execution cannot use an unaudited personnel file or audit from another workflow',()=>{
 const f=fixture();try{f.write('spec.json',f.spec);assert.equal(typeof api.assertWorkflowAudit,'function');assert.throws(()=>api.assertWorkflowAudit(path.join(f.root,'spec.json'),'checkin',[]),/workflow|流程/);assert.throws(()=>api.assertWorkflowAudit(path.join(f.root,'spec.json'),'certificates',[path.join(f.root,'foreign.json')]),/文件|输入/);}finally{f.close();}
});
test('a receipt sidecar cannot masquerade as an audited executable input',()=>{
 const f=fixture();try{f.spec.coverage.actual[0].status='completed';f.spec.coverage.actual[0].evidence_file='readback.json';f.write('spec.json',f.spec);assert.throws(()=>api.assertWorkflowAudit(path.join(f.root,'spec.json'),'certificates',[path.join(f.root,'readback.json')]),/输入文件|文件未/);}finally{f.close();}
});
test('personnel dependencies alone cannot replace coverage of the executing personnel file',()=>{
 const f=fixture();try{f.spec.sources.push({id:'config',kind:'file',used:{path:'readback.json',sha256:f.digest('readback.json')},current:{path:'readback.json'}});f.write('spec.json',f.spec);assert.throws(()=>api.assertWorkflowAudit(path.join(f.root,'spec.json'),'certificates',[path.join(f.root,'readback.json')],[path.join(f.root,'readback.json')]),/范围|覆盖/);}finally{f.close();}
});
