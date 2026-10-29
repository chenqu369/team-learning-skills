import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {columns,validFilename} from './证书制作表.mjs';
const scalar=v=>Array.isArray(v)?v.length===1?scalar(v[0]):'':v==null?'':String(v);
export function buildFinalRoster(records,config,registry,ledger,contract){
 const source=config.final_roster_source;
 if(!source?.base_token||!source?.table_id)throw Error('缺最终制证Base和稳定table_id');
 if(ledger.test_mode===true)throw Error('不得使用测试编号账本');
 const people=[],approvals=[],excluded=[],courses={};
 const basis='当前终版证书制作名单已确认';
 for(const row of records){
  const data=Object.fromEntries(columns.map(f=>[f,scalar(row[f])]));
  if(!data.证书昵称)data.证书昵称=data.微信昵称;
  if(config.deferred_courses?.includes(data.所学课程)){excluded.push({record_id:row.record_id,原因:'用户明确暂缓发证'});continue;}
  if(!row.record_id||!validFilename(data.证书昵称))throw Error('终版记录缺record_id或证书昵称异常：'+row.record_id);
  const role=data.证书类型;
  if(![config.normal_role,'优秀学习者证书','优秀队长证书'].includes(role)||!config.role_codes?.[role])throw Error('终版证书类型或编码异常：'+row.record_id);
  for(const f of ['所学课程','群号','课程编号','营期编号','营期名','结营日期'])if(!data[f])throw Error('终版缺必要参数 '+f+'：'+row.record_id);
  const metadata=Object.fromEntries(['课程编号','营期编号','营期名','结营日期'].map(f=>[f,data[f]]));
  if(courses[data.所学课程]&&JSON.stringify(courses[data.所学课程])!==JSON.stringify(metadata))throw Error('同课程制证参数不一致：'+data.所学课程);
  courses[data.所学课程]=metadata;
  let stable=registry[row.record_id]?.stable_id;
  if(!stable&&data.证书编号){
   const matches=Object.entries(ledger.entries??{}).filter(([,entry])=>entry.number===data.证书编号);
   if(matches.length!==1)throw Error('证书编号未匹配唯一正式账本条目：'+row.record_id);
   const [course,period,ledgerRole,identity]=JSON.parse(matches[0][0]);
   if(course!==data.所学课程||period!==data.营期编号||ledgerRole!==role)throw Error('证书编号与课程、营期、类型不一致：'+row.record_id);
   stable=identity;
  }
  stable??='FINAL-'+crypto.createHash('sha256').update(JSON.stringify([source.base_token,source.table_id,row.record_id])).digest('hex').slice(0,20);
  const key=JSON.stringify([data.所学课程,data.营期编号,role,stable]);
  const actual=ledger.entries?.[key]?.number??'';
  if(data.证书编号&&data.证书编号!==actual)throw Error('证书编号与正式账本不一致：'+row.record_id);
  const evidence={source_kind:'final_roster',contract_version:contract.CONTRACT_VERSION,eligible:true,person_id:stable,course:data.所学课程,source_record_ids:[row.record_id],base_token:source.base_token,table_id:source.table_id,original_name:data.证书昵称};
  people.push({...data,角色:role,证书编号:actual,稳定人员标识:stable,营期:data.营期编号,名单核准状态:'已核准',制证依据:basis,最终名单记录ID:row.record_id,资格核验:evidence});
  approvals.push({record_id:row.record_id,base_token:source.base_token,table_id:source.table_id,course:data.所学课程,group:data.群号,role,name:data.证书昵称,person_id:stable,basis});
 }
 const issues=contract.validatePersonnel(people,config.normal_role,[],[],approvals);
 if(issues.length)throw Error(issues.join('；'));
 const rendered={...config,courses,rules:[],final_roster_approvals:approvals,approved_statuses:['已核准']};
 for(const key of ['inputs','approved_awards','manual_graduation_approvals','certificate_sheet_token','identity_registry_path','contract_path'])delete rendered[key];
 return {people,config:rendered,excluded};
}
export async function main(configFile,out){
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),root=path.dirname(path.resolve(configFile));
 const source=config.final_roster_source;
 if(!source?.base_token||!source?.table_id)throw Error('缺最终制证表配置');
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('输出目录非空，请使用新目录');
 fs.mkdirSync(out,{recursive:true});
 const records=[];let offset=0,rev;
 for(let page=1;;page++){
  const file=path.resolve(out,`当前终版-${page}.ndjson`);
  const relative=path.relative(process.cwd(),file).split(path.sep).join('/');
  if(relative.startsWith('../')||path.isAbsolute(relative))throw Error('输出目录必须位于当前工作目录内');
  const output=execFileSync(config.lark_cli??'lark-cli',['base','+record-list','--base-token',source.base_token,'--table-id',source.table_id,'--format','ndjson','--output','./'+relative,'--offset',String(offset),'--as','user'],{encoding:'utf8',maxBuffer:4*1024*1024});
  const manifest=JSON.parse(output),part=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if(manifest.base_token!==source.base_token||manifest.table_id!==source.table_id||manifest.query_context?.record_scope!=='all_records'||manifest.records_count!==part.length||typeof manifest.has_more!=='boolean')throw Error('当前终版完整导出核验失败');
  if(rev!==undefined&&rev!==manifest.rev)throw Error('读取期间终版发生变更');rev=manifest.rev;records.push(...part);
  if(!manifest.has_more)break;
  if(!Number.isInteger(manifest.next_offset)||manifest.next_offset<=offset)throw Error('分页未前进');offset=manifest.next_offset;
 }
 const capturedAt=new Date().toISOString(),snapshotFile=path.resolve(out,'当前终版全量.ndjson');
 fs.writeFileSync(snapshotFile,records.map(r=>JSON.stringify(r)).join('\n')+(records.length?'\n':''),{flag:'wx'});
 const snapshot={...source,rev,captured_at:capturedAt,records_count:records.length,has_more:false,query_context:{record_scope:'all_records'},
  record_file:snapshotFile,sha256:crypto.createHash('sha256').update(fs.readFileSync(snapshotFile)).digest('hex')};
 fs.writeFileSync(path.join(out,'当前终版全量.manifest.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
 const contract=await import(pathToFileURL(path.resolve(root,config.contract_path)).href);
 const registry=JSON.parse(fs.readFileSync(path.resolve(root,config.identity_registry_path),'utf8'));
 config.certificate_ledger_path=path.resolve(root,config.certificate_ledger_path);
 const ledger=JSON.parse(fs.readFileSync(config.certificate_ledger_path,'utf8'));
 const result=buildFinalRoster(records,config,registry,ledger,contract);
 result.config.final_roster_snapshot=snapshot;
 const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n');
 write('制证人员.json',result.people);write('制证配置.json',result.config);write('排除记录.json',result.excluded);
 fs.writeFileSync(path.join(out,'飞书终版证书制作单维表.csv'),'\uFEFF'+[columns,...result.people.map(p=>columns.map(c=>p[c]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n');
 write('最终来源验收.json',{...snapshot,records:records.length,people:result.people.length,excluded:result.excluded.length,numbered:result.people.filter(p=>p.证书编号).length,source_authority:'current_final_base'});
 console.log(JSON.stringify({ok:true,...source,rev,people:result.people.length,numbered:result.people.filter(p=>p.证书编号).length}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main(process.argv[2],process.argv[3]);
