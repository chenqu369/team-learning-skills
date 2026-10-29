import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as api from '../runtime/assistant/scripts/证书附件上传.mjs';

function fixture(){
 const person=(id,name)=>({最终名单记录ID:id,稳定人员标识:id,证书昵称:name,微信昵称:name,所学课程:'课程A',群号:'1群',角色:'结课证书',证书类型:'结课证书',证书编号:'010012026080000'+id.slice(1),课程编号:'001',营期编号:'202608',营期名:'第83期',结营日期:'2026年9月13日'});
 const people=[person('r1','甲'),person('r2','乙')];
 const current=people.map(p=>({...p,record_id:p.最终名单记录ID,证书附件:[],备注:'保留人工值'}));
 const manifest={status:'complete',test_mode:false,certificates:people.map(p=>({course:p.所学课程,stable_id:p.稳定人员标识,role:p.角色,name:p.证书昵称,date:p.结营日期,group:p.群号,number:p.证书编号,path:p.证书昵称+'结课证书.png',sha256:'a'.repeat(64)}))};
 const config={final_roster_source:{table_id:'tbl1'},attachment_fields:{certificate:'fld1'}};
 return {people,current,manifest,config};
}
function verify(...args){assert.equal(typeof api.verifySourceSnapshot,'function','must compare the full source invariant');return api.verifySourceSnapshot(...args);}

test('an upload manifest missing one planned person must not report batch success',()=>{
 const f=fixture();f.manifest.certificates.pop();
 assert.throws(()=>api.planUploads(f.people,f.manifest,f.current,f.config),/缺|全部|对应|范围/);
});
test('a complete manifest maps each planned certificate exactly once',()=>{
 const f=fixture();assert.equal(api.planUploads(f.people,f.manifest,f.current,f.config).length,2);
 f.people.push({...f.people[0]});assert.throws(()=>api.planUploads(f.people,f.manifest,f.current,f.config),/重复|唯一|对应|范围/);
});
test('an upload run detects added, removed and same-count replaced source records',()=>{
 for(const mutate of [a=>a.push({...a[0],record_id:'late'}),a=>a.pop(),a=>a[1].record_id='replacement']){
  const f=fixture(),plan=api.planUploads(f.people,f.manifest,f.current,f.config),after=structuredClone(f.current);mutate(after);
  assert.throws(()=>verify(f.current,after,plan),/全集|新增|移除|源表|范围/);
 }
});
test('only the batch attachment append is allowed; every other source field is immutable',()=>{
 const f=fixture(),plan=api.planUploads(f.people,f.manifest,f.current,f.config),after=structuredClone(f.current);
 after[0].证书附件=[{file_token:'token',name:'甲结课证书.png',size:12}];
 assert.equal(verify(f.current,after,plan),true);
 assert.equal(verify(f.current,[...after].reverse(),plan),true);
 for(const [field,value]of [['备注','被覆盖'],['群号','2群'],['证书编号','different']]){
  const changed=structuredClone(after);changed[1][field]=value;
  assert.throws(()=>verify(f.current,changed,plan),/字段|源表|变化/);
 }
});
test('foreign or duplicate target attachments and changes outside the batch are rejected',()=>{
 const f=fixture(),plan=api.planUploads(f.people,f.manifest,f.current,f.config);
 const cases=[
  a=>a[0].证书附件=[{file_token:'bad',name:'错误证书.png'}],
  a=>a[0].证书附件=[{file_token:'one',name:'甲结课证书.png'},{file_token:'two',name:'甲结课证书.png'}],
  a=>a[1].领取用证书附件=[{file_token:'unrelated'}],
 ];
 for(const mutate of cases){const after=structuredClone(f.current);mutate(after);assert.throws(()=>verify(f.current,after,plan),/附件|源表|变化/);}
 const partial=plan.slice(0,1),after=structuredClone(f.current);after[1].证书附件=[{file_token:'bad',name:'乙结课证书.png'}];
 assert.throws(()=>verify(f.current,after,partial),/源表|变化|附件/);
});
test('formal manifests require a SHA256 that is bound to each upload file',()=>{
 const f=fixture(),plan=api.planUploads(f.people,f.manifest,f.current,f.config);
 assert.equal(plan[0].files[0].expected_sha256,f.manifest.certificates[0].sha256);
 delete f.manifest.certificates[0].sha256;
 assert.throws(()=>api.planUploads(f.people,f.manifest,f.current,f.config),/哈希|sha256|SHA256/);
});
test('actual file bytes must match the formal manifest digest',()=>{
 assert.equal(typeof api.verifyManifestFile,'function');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upload-digest-'));
 try{
  const file=path.join(root,'certificate.png');fs.writeFileSync(file,'formal-image');
  const digest=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(api.verifyManifestFile({file,expected_sha256:digest}).sha256,digest);
  fs.writeFileSync(file,'changed-image');
  assert.throws(()=>api.verifyManifestFile({file,expected_sha256:digest}),/哈希|sha256|SHA256/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('the first live source must match the audited Base snapshot and revision',()=>{
 assert.equal(typeof api.verifyAuditedSource,'function');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upload-source-'));
 try{
  const f=fixture(),file=path.join(root,'source.ndjson');fs.writeFileSync(file,f.current.map(row=>JSON.stringify(row)).join('\n'));
  const source={base_token:'base',table_id:'tbl1'},snapshot={kind:'base',...source,path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),rev:5};
  const audit={source_snapshots:[snapshot]};
  assert.equal(api.verifyAuditedSource(audit,source,f.current,5,{required:true}),true);
  assert.throws(()=>api.verifyAuditedSource({source_snapshots:[]},source,f.current,5,{required:true}),/Base|来源|审计/);
  assert.throws(()=>api.verifyAuditedSource(audit,source,f.current,6,{required:true}),/版本|rev|变化/);
  const late=[...f.current,{...f.current[0],record_id:'late'}];
  assert.throws(()=>api.verifyAuditedSource(audit,source,late,5,{required:true}),/全集|源表|变化/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
