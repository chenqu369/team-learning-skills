import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {call,load,save} from './lark.mjs';

export const statusDefaults={'分发方式':'助教手动分发','制作状态':'待制作','分发状态':'待手动分发'};
const col=n=>{let s='';for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,20);

export function planStatus(table,manifest=null){
 for(const c of ['证书昵称','所学课程','角色',...Object.keys(statusDefaults)])if(!table.columns.includes(c))throw Error('人员名单缺字段 '+c);
 if(manifest&&(manifest.status!=='complete'||manifest.test_mode!==false))throw Error('只有正式制作完成的结果允许回写');
 const rows=table.data.map(r=>Object.fromEntries(table.columns.map((c,i)=>[c,r[i]??'']))),writes=[],pending=[];
 const write=(i,c,v)=>writes.push({...(table.sheet_id?{sheet_id:table.sheet_id}:{sheet_name:table.name||'人员名单'}),range:col(table.columns.indexOf(c))+(i+2),cells:[[{value:v}]]});
 if(!manifest){
  rows.forEach((r,i)=>{if(!r.证书昵称||!r.所学课程||!r.角色)return;
   for(const [c,v] of Object.entries(statusDefaults))if(r[c]==='')write(i,c,v);
  });
 }else{
  const used=new Set();
  for(const cert of manifest.certificates){
   const hits=rows.map((r,i)=>({r,i})).filter(({r})=>r.证书昵称===cert.name&&r.所学课程===cert.course&&r.角色===cert.role&&String(r.群号??'')===String(cert.group));
   if(hits.length!==1){pending.push({name:cert.name,course:cert.course,reason:'名单匹配不唯一或制作后资料已修改'});continue;}
   const {r,i}=hits[0],marker=String(r.备注??'').match(/^自动名单:([a-f0-9]{20})(?:；|$)/)?.[1];
   if(r.名单核准状态!=='已核准'||(marker&&(!cert.stable_id||hash(cert.stable_id)!==marker))||used.has(i)){
    pending.push({row:i+2,reason:'核准或稳定身份不匹配，或制作结果重复'});continue;
   }
   used.add(i);if(r.制作状态!=='已完成')write(i,'制作状态','已完成');
  }
  // A conflicting batch is not partially marked complete.
  if(pending.length)writes.length=0;
 }
 return {writes,pending};
}

export function syncStatus(token,manifest=null,apply=false){
 const info=call(['sheets','+workbook-info','--spreadsheet-token',token,'--as','user']).data;
 const candidates=info.sheets.filter(s=>['证书人员名单','人员名单'].includes(s.sheet_name));
 if(candidates.length!==1)throw Error('证书人员名单定位不唯一');
 const sheetId=candidates[0].sheet_id;
 const read=()=>{
  const result=call(['sheets','+table-get','--spreadsheet-token',token,'--sheet-id',sheetId,'--as','user']).data;
  if(result.truncated||result.sheets?.some(s=>s.truncated))throw Error('状态同步读取被截断');
  const table=result.sheets?.[0];if(!table||result.sheets.length!==1)throw Error('人员名单不存在');return {...table,sheet_id:sheetId};
 };
 if(manifest){
  if(manifest.status!=='complete'||manifest.test_mode!==false)throw Error('禁止回写测试或未完成结果');
  for(const artifact of manifest.certificates.map(c=>c.path))if(!artifact||!existsSync(artifact))throw Error('制证成品缺失，不能标记完成');
 }
 const table=read(),plan=planStatus(table,manifest);
 save('workflow/output/certificate-status-plan.json',plan);
 if(plan.pending.length)throw Error(JSON.stringify(plan.pending));
 if(apply&&plan.writes.length){
  // Re-read just before writing; changed rows must be replanned instead of overwritten.
  if(JSON.stringify(read())!==JSON.stringify(table))throw Error('人员名单已变化，请重新运行');
  for(let i=0;i<plan.writes.length;i+=100){
   const path=`workflow/output/certificate-status-write-${i}.json`;save(path,plan.writes.slice(i,i+100));
   call(['sheets','+cells-set','--spreadsheet-token',token,'--writes','@'+path,'--as','user']);
  }
  const fresh=read();save('workflow/output/certificate-status-readback.json',fresh);
  for(const w of plan.writes){
   const match=w.range.match(/^([A-Z]+)(\d+)$/);let index=0;for(const ch of match[1])index=index*26+ch.charCodeAt(0)-64;
   if(fresh.data[Number(match[2])-2]?.[index-1]!==w.cells[0][0].value)throw Error('状态回读不一致: '+w.range);
  }
 }
 return {ok:true,mode:apply?'apply':'plan',writes:plan.writes.length,pending:plan.pending.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [mode,token,file]=process.argv.slice(2);
  if(!['initialize','complete'].includes(mode)||!token||(mode==='complete'&&!file))throw Error('certificate-status.mjs initialize TOKEN [--apply] | complete TOKEN manifest.json [--apply]');
  console.log(JSON.stringify(syncStatus(token,mode==='complete'?load(file):null,process.argv.includes('--apply'))));
 }catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
