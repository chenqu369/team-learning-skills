import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {transferFile,downloadVerified} from '../runtime/assistant/scripts/上传传输.mjs';

const file={file:'甲结课证书.png',expected_sha256:'a'.repeat(64),size:12};
const attachment={name:file.file,size:12,file_token:'token1'};
function setup(initial){let current=initial,uploads=0;const events=[];return {events,get uploads(){return uploads;},set(v){current=v;},options:{record_id:'r1',file,read:()=>current,upload:()=>{uploads++;current=attachment;},verify:()=>({sha256:file.expected_sha256}),record:e=>events.push(e)}};}
test('already uploaded file is verified and reused without another upload',()=>{
 const f=setup(attachment);const result=transferFile(f.options);
 assert.equal(f.uploads,0);assert.equal(result.status,'reused');assert.equal(result.file_token,'token1');
 assert.ok(f.events.every(e=>Number.isFinite(e.elapsed_ms)));assert.equal(f.events.at(-1).status,'reused');
});
test('lost upload response recovers from live attachment, never retries the write',()=>{
 const f=setup(null);let writes=0;f.options.upload=()=>{writes++;f.set(attachment);throw Error('timeout');};
 const result=transferFile(f.options);assert.equal(result.status,'recovered');
 assert.equal(writes,1);
 assert.ok(f.events.some(e=>e.phase==='upload'&&e.status==='outcome_unknown'));
});
test('healthy upload needs one pre-write read and defers final batch readback to its caller',()=>{
 const f=setup(null);let reads=0;f.options.read=()=>{reads++;return null;};f.options.verify=()=>{throw Error('新上传无需逐张再下载');};
 const result=transferFile(f.options);assert.equal(result.status,'uploaded');assert.equal(f.uploads,1);assert.equal(reads,1);assert.equal(result.verification,'awaiting_final_readback');
});
test('failed write with no live attachment stops with persisted pending state',()=>{
 const f=setup(null);let writes=0;f.options.upload=()=>{writes++;throw Error('EOF');};
 assert.throws(()=>transferFile(f.options),/未确认|未找到|重新/);assert.equal(writes,1);
 assert.equal(f.events.at(-1).status,'pending');
});
test('conflicting existing file and failed digest verification never cause another upload',()=>{
 const f=setup({...attachment,name:'其他.png'});assert.throws(()=>transferFile(f.options),/附件/);assert.equal(f.uploads,0);
 const g=setup(attachment);g.options.verify=()=>{throw Error('哈希不符');};assert.throws(()=>transferFile(g.options),/哈希/);assert.equal(g.uploads,0);
 const h=setup(attachment);h.options.verify=()=>({sha256:'b'.repeat(64)});assert.throws(()=>transferFile(h.options),/哈希/);
});
test('download uses bounded authorized URL transfer and validates actual bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'certificate-download-'));try{
  const bytes=Buffer.from('formal-certificate'),digest=crypto.createHash('sha256').update(bytes).digest('hex'),commands=[];
  const execute=(program,args)=>{commands.push({program,args});if(program==='lark')return JSON.stringify({ok:true,data:{tmp_download_urls:[{tmp_download_url:'https://example.invalid/signed-secret'}]}});fs.writeFileSync(args[args.indexOf('--output')+1],bytes);return '';};
  const result=downloadVerified({attachment,expected_sha256:digest,directory:dir,cli:'lark',execute});
  assert.equal(result.sha256,digest);assert.ok(commands[1].args.includes('--max-time'));assert.ok(commands[1].args.includes('--connect-timeout'));assert.ok(!JSON.stringify(result).includes('signed-secret'));assert.equal(fs.readdirSync(dir).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('download errors do not disclose signed URLs and leave no temporary files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'certificate-download-'));try{
  const execute=(program,args)=>{if(program==='lark')return JSON.stringify({ok:true,data:{tmp_download_urls:[{tmp_download_url:'https://example.invalid/signed-secret'}]}});fs.writeFileSync(args[args.indexOf('--output')+1],'partial');throw Error('curl failed https://example.invalid/signed-secret');};
  assert.throws(()=>downloadVerified({attachment,expected_sha256:file.expected_sha256,directory:dir,cli:'lark',execute}),e=>!e.message.includes('signed-secret')&&/下载/.test(e.message));assert.equal(fs.readdirSync(dir).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
