import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {readTable,acquireLock,makeCaller} from '../runtime/learner/local/platform.mjs';
const fixture=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-local-'));return {root,base:'base',table:'table',directory:root,label:'source'};};
test('完整读取两页，合并manifest且不漏最后一页',()=>{
 const opt=fixture();let calls=0;
 try{const r=readTable({...opt,call:args=>{const i=calls++;fs.writeFileSync(path.resolve(opt.root,args[args.indexOf('--output')+1]),JSON.stringify({record_id:'r'+i})+'\n');return {manifest_version:'v1',base_token:'base',table_id:'table',rev:1,records_count:1,has_more:i===0,next_offset:1,query_context:{record_scope:'all_records'}};}});assert.equal(calls,2);assert.equal(r.rows.length,2);assert.equal(r.manifest.has_more,false);}finally{fs.rmSync(opt.root,{recursive:true,force:true});}
});
test('不同版本的分页不能合并成全量快照',()=>{
 const opt=fixture();let calls=0;
 try{assert.throws(()=>readTable({...opt,call:args=>{const i=calls++;fs.writeFileSync(path.resolve(opt.root,args[args.indexOf('--output')+1]),JSON.stringify({record_id:'r'+i}));return {manifest_version:'v1',base_token:'base',table_id:'table',rev:i,records_count:1,has_more:i===0,next_offset:1,query_context:{record_scope:'all_records'}};}}),/版本/);}finally{fs.rmSync(opt.root,{recursive:true,force:true});}
});
test('同时启动第二次运行会被锁阻止，结束后可运行',()=>{
 const opt=fixture(),file=path.join(opt.root,'sync.lock');try{const release=acquireLock(file);assert.throws(()=>acquireLock(file),/正在运行/);release();acquireLock(file)();}finally{fs.rmSync(opt.root,{recursive:true,force:true});}
});
test('读取遇到瞬时网络错误可重试；写入结果不明绝不自动重试',()=>{
 let attempts=0;const execute=()=>++attempts===1?{status:1,stderr:JSON.stringify({error:{type:'network',message:'EOF'}})}:{status:0,stdout:JSON.stringify({ok:true,data:{}})};
 assert.equal(makeCaller('.', 'fake',execute)(['base','+record-list']).ok,true);assert.equal(attempts,2);
 attempts=0;assert.throws(()=>makeCaller('.','fake',execute)(['base','+record-batch-create']),/network/);assert.equal(attempts,1);
});
