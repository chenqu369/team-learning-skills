// Shared by import, registration, merge, progress and personnel export.
import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const CONTRACT_VERSION='learning-record-v2';
export const REQUIRED_FIELDS=['微信昵称','所学课程','群号','任务名称','学习心得','课程评价','请填写你对本次课程内容的反馈'];
export const scalar=v=>Array.isArray(v)?v.length===1?scalar(v[0]):'':v==null?'':typeof v==='object'?v.id??v.open_id??'':String(v);
export const normaliseWechat=v=>scalar(v).normalize('NFKC').replace(/\p{Cf}/gu,'').trim().replace(/\s+/gu,' ').toLowerCase();
export function nicknameEvidence(left,right,{strong_identity=false,aliases=[],character_map={},traditional_map={},pinyin_of}={}){
 const a=normaliseWechat(left),b=normaliseWechat(right);
 if(!a||!b)return {matched:false,automatic:false,method:'缺昵称'};
 if(a===b)return {matched:true,automatic:true,method:'Unicode/空格/大小写规范化'};
 const translate=s=>[...s].map(c=>traditional_map[c]??c).join('');
 const plain=s=>translate(s).replace(/[\p{P}\p{S}\p{Extended_Pictographic}\uFE0F\u20E3]/gu,'').trim();
 const mapped=s=>[...plain(s)].map(c=>character_map[c]??c).join('');
 const suffix=s=>plain(s).replace(/(?:小号|测试|0?1)$/u,'');
 let method='';
 if(aliases.some(g=>g.map(normaliseWechat).includes(a)&&g.map(normaliseWechat).includes(b)))method='已确认历史别名';
 else if(plain(a)&&plain(a)===plain(b))method='简繁/装饰/标点';
 else if(mapped(a)&&mapped(a)===mapped(b))method='经配置的同音/形近字';
 else if(suffix(a)&&suffix(a)===suffix(b))method='常见昵称后缀';
 else if(pinyin_of&&pinyin_of(a)&&pinyin_of(a)===pinyin_of(b))method='拼音相同（仅候选）';
 return {matched:!!method,automatic:!!method&&strong_identity&&method!=='拼音相同（仅候选）',method:method||'不同昵称'};
}
export const taskId=v=>{const m=scalar(v).trim().match(/^task\s*(\d+)$/i);return m?`task${Number(m[1])}`:'';};
export const nameBad=v=>!scalar(v).trim()||/^(?:[-/\\.0-9]+|null|none|无|暂无|微信昵称|证书昵称)$/i.test(scalar(v).trim())||/[\r\n\t]/.test(scalar(v))||scalar(v).length>40;
export const order=(a,b)=>Date.parse(a.提交时间)-Date.parse(b.提交时间)||Number(scalar(a.自动编号).replace(/^NO\./,''))-Number(scalar(b.自动编号).replace(/^NO\./,''))||a.record_id.localeCompare(b.record_id);
export function validateSubmission(r){
 const reasons=[];
 if(scalar(r.学习者编号)&&scalar(r.人工学习者标识)&&scalar(r.学习者编号)!==scalar(r.人工学习者标识))reasons.push('新旧学习者编号冲突');
 for(const f of REQUIRED_FIELDS)if(!scalar(r[f]).trim())reasons.push(`必填项缺失：${f}`);
 if(scalar(r.微信昵称)&&nameBad(normaliseWechat(r.微信昵称)))reasons.push('微信昵称异常');
 if(!taskId(r.任务名称))reasons.push('任务名称缺失或异常');
 if(!Number.isFinite(Date.parse(r.提交时间)))reasons.push('提交时间异常');
 if(!/^NO\.\d+$/.test(scalar(r.自动编号)))reasons.push('自动编号异常');
 if(scalar(r.人工核对)==='无效'||scalar(r.核对表结果)==='无效')reasons.unshift('人工判定无效');
 return [...new Set(reasons)];
}
export function normaliseRule(rule){
 if(!rule||!scalar(rule.course).trim())throw Error('课程规则缺课程');
 if(rule.task_rule_status&&rule.task_rule_status!=='已确认')throw Error('Task规则尚未确认');
 const explicit=Object.hasOwn(rule,'tasks');
 if(!explicit&&!Array.isArray(rule.task_ids))throw Error('规则缺明确Task编号，不按count推断');
 const raw=explicit?rule.tasks:rule.task_ids;
 if(!Array.isArray(raw))throw Error('Task必须是明确编号数组');
 const convert=items=>{if(!Array.isArray(items)||items.some(x=>!taskId(x)))throw Error('Task编号无效');const v=items.map(taskId);if(new Set(v).size!==v.length)throw Error('Task编号重复');return v;};
 let tasks=convert(raw);
 if(!explicit)tasks=tasks.filter(t=>t!=='task0');
 const any_groups=(rule.any_groups??[]).map(g=>{const v=convert(g);if(!v.length)throw Error('任选Task组为空');return v;});
 if(!tasks.length&&!any_groups.length)throw Error('规则没有明确必需或任选Task，待确认');
 return {...rule,tasks,any_groups};
}
export function missingTasks(taskIds,rule){
 const r=normaliseRule(rule),have=new Set(taskIds);
 return [...r.tasks.filter(t=>!have.has(t)),...r.any_groups.filter(g=>!g.some(t=>have.has(t))).map(g=>`任选:${g.join('|')}`)];
}
export function identityKeys({period,course,person_id,task,role}){
 if(!period||!course||!person_id)throw Error('身份键缺营期、课程或固定人员标识');
 if(task&&!taskId(task))throw Error('Task编号无效');
 return {learner:JSON.stringify([period,course,person_id]),checkin:task?JSON.stringify([period,course,person_id,taskId(task)]):null,certificate:role?JSON.stringify([period,course,person_id,role]):null};
}
export function analyseIdentity(rows,rules=[],options={}){
 const ruleMap=new Map();for(const rule of rules){const r=normaliseRule(rule);if(ruleMap.has(r.course))throw Error('同课程重复规则');ruleMap.set(r.course,r);}
 const seen=new Set();for(const r of rows){if(!r.record_id||seen.has(r.record_id))throw Error('missing/duplicate record_id');seen.add(r.record_id);}
 const inputRegistry=options.registry??{version:CONTRACT_VERSION,records:{},aliases:{}};
 if(inputRegistry.version!==CONTRACT_VERSION)throw Error('身份登记版本不匹配，须先显式迁移');
 const registry=structuredClone(inputRegistry);registry.records??={};registry.aliases??={};registry.confirmed_alias_groups??={};registry.next_number??=1; const manualId=r=>scalar(r.学习者编号)||scalar(r.人工学习者标识); const reserved=new Set([...Object.values(registry.records),...Object.values(registry.aliases),...rows.map(manualId),...(options.confirmed_aliases??[]).map(e=>e.person_id)]); for(const id of reserved)if(/^L[0-9]+$/.test(id))registry.next_number=Math.max(registry.next_number,Number(id.slice(1))+1); const allocate=()=>{let id;do{id='L'+String(registry.next_number++).padStart(6,'0');}while(reserved.has(id));reserved.add(id);return id;};
 const scope=r=>JSON.stringify([options.base_token??'',options.table_id??'',scalar(r.营期)||options.period||'legacy',scalar(r.所学课程)]);
 const alias=(r,kind,value)=>JSON.stringify([scope(r),kind,value]);
 const recordKey=r=>alias(r,'record',r.record_id);
 const matchKey=r=>alias(r,'match',JSON.stringify([normaliseWechat(r.微信昵称),scalar(r.证书昵称),scalar(r.群号)]));
 registry.confirmed_matches??={};
 for(const entry of options.confirmed_aliases??[]){
  if(!entry.person_id||!entry.course||!entry.period||!Array.isArray(entry.aliases)||!entry.aliases.length)throw Error('已确认别名缺人员标识、课程、营期或别名');
  const r={所学课程:entry.course,营期:entry.period};const k=JSON.stringify([scope(r),entry.person_id]);registry.confirmed_alias_groups[k]=[...new Set([...(registry.confirmed_alias_groups[k]??[]),...entry.aliases])];
  for(const nick of entry.aliases){const k=alias(r,'wx',normaliseWechat(nick)),previous=registry.aliases[k];if(previous&&previous!==entry.person_id)throw Error('已确认别名对应不同稳定身份');registry.aliases[k]=entry.person_id;}
 }
 const pending=[],recordStates={},eligible=[];
 for(const r of rows){const reasons=validateSubmission(r);if(reasons.length){recordStates[r.record_id]={identity:'',reason:reasons.join('；'),valid:false};pending.push({record_id:r.record_id,identity:'',course:scalar(r.所学课程),reasons,original_certificate:scalar(r.证书昵称),original_wechat:scalar(r.微信昵称)});}else eligible.push(r);}
 // created_by is an operator, never an identity edge.
 const neighbours=eligible.map((r,i)=>new Set([i])),index=new Map();
 eligible.forEach((r,i)=>{
  const manual=manualId(r),keys=manual?[['manual',manual]]:[['cert',scalar(r.证书昵称)],['wx',normaliseWechat(r.微信昵称)]];
  const saved=new Set([registry.records[recordKey(r)],/^L\d+$/.test(manual)?manual:null,...(!manual?(registry.confirmed_matches[matchKey(r)]??[]):[]),...keys.map(([k,v])=>registry.aliases[alias(r,k,v)])].filter(Boolean));
  if(saved.size===1)keys.push(['stable',[...saved][0]]);
  for(const [kind,value] of keys){if(!value)continue;const key=alias(r,kind,value);if(!index.has(key))index.set(key,[]);index.get(key).push(i);}
 });
 for(const values of index.values())for(const i of values)for(const j of values)neighbours[i].add(j);
 let labels=eligible.map(r=>r.record_id),rounds=0;
 for(;rounds<eligible.length;rounds++){const next=neighbours.map(ns=>[...ns].map(i=>labels[i]).sort()[0]);if(next.every((v,i)=>v===labels[i]))break;labels=next;}
 const groups=new Map();labels.forEach((v,i)=>{const k=JSON.stringify([scope(eligible[i]),v]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(eligible[i]);});
 const learners=[],latest=[];
 for(const list of [...groups.values()].sort((a,b)=>scope(a[0]).localeCompare(scope(b[0]))||a.map(r=>r.record_id).sort()[0].localeCompare(b.map(r=>r.record_id).sort()[0]))){
  const course=scalar(list[0].所学课程),period=scalar(list[0].营期)||options.period||'legacy',reasons=[],groupset=new Set(list.map(r=>scalar(r.群号)));
  const reviewedGroup=registry.confirmed_group_reviews?.[JSON.stringify([scope(list[0]),manualId(list[0])])];
  const confirmedCrossGroup=!!manualId(list[0])&&!!reviewedGroup&&list.every(r=>manualId(r)===manualId(list[0]))&&[...groupset].every(g=>reviewedGroup.groups.includes(g));
  if(groupset.size!==1&&!confirmedCrossGroup)reasons.push('群号冲突');
  const wx=new Set(list.map(r=>normaliseWechat(r.微信昵称))),manual=list.every(r=>manualId(r));
  const anchors=new Set();
  for(const r of list){
   const existing=registry.records[recordKey(r)];if(existing)anchors.add(existing);
   if(!manualId(r))for(const id of registry.confirmed_matches[matchKey(r)]??[])anchors.add(id);
   const strong=manualId(r);if(/^L[0-9]+$/.test(strong))anchors.add(strong);
   for(const [kind,value] of strong?[['manual',strong]]:[['cert',scalar(r.证书昵称)],['wx',normaliseWechat(r.微信昵称)]]){const saved=registry.aliases[alias(r,kind,value)];if(saved)anchors.add(saved);}
  }
  if(anchors.size>1)reasons.push('已有不同稳定身份，禁止自动合并');
  if(wx.size>1&&!manual){const names=[...wx],strong=anchors.size===1&&list.every(r=>{
   const trusted=[registry.records[recordKey(r)],...(registry.confirmed_matches[matchKey(r)]??[]),registry.aliases[alias(r,'wx',normaliseWechat(r.微信昵称))],manualId(r)?registry.aliases[alias(r,'manual',manualId(r))]:null];
   return trusted.some(id=>anchors.has(id));
  });
   const compatible=names.slice(1).every(n=>nicknameEvidence(names[0],n,{...options.nickname_matching,strong_identity:strong,aliases:[...anchors].map(id=>registry.confirmed_alias_groups[JSON.stringify([scope(list[0]),id])]).filter(Boolean)}).automatic);
   if(!compatible)reasons.push('证书昵称对应多个微信昵称，待核对');
  }
  const valid=reasons.length===0;
  const identity=anchors.size===1?[...anchors][0]:valid?allocate():'';
  for(const r of list){recordStates[r.record_id]={identity,reason:reasons.join('；')||'可统计',valid};if(!valid)pending.push({record_id:r.record_id,identity,course,reasons:[...reasons],original_certificate:scalar(r.证书昵称),original_wechat:scalar(r.微信昵称)});}
  if(valid)for(const r of list){registry.records[recordKey(r)]=identity;const m=manualId(r);for(const [kind,v] of m?[['manual',m]]:[['cert',scalar(r.证书昵称)],['wx',normaliseWechat(r.微信昵称)]])if(v)registry.aliases[alias(r,kind,v)]=identity;}
  if(valid)for(const r of list){const k=matchKey(r),groupKey=JSON.stringify([scope(r),identity]);registry.confirmed_matches[k]=[...new Set([...(registry.confirmed_matches[k]??[]),identity])];registry.confirmed_alias_groups[groupKey]=[...new Set([...(registry.confirmed_alias_groups[groupKey]??[]),scalar(r.微信昵称)])];}
  const byTask=new Map();if(valid)for(const r of list){const t=taskId(r.任务名称);if(!byTask.has(t)||order(byTask.get(t),r)<0)byTask.set(t,r);}
  const ordered=[...list].sort(order),certs=ordered.filter(r=>scalar(r.证书昵称));
  const certificate_name=certs.length?scalar(certs.at(-1).证书昵称):'';
  const rule=ruleMap.get(course),missing=rule?missingTasks([...byTask.keys()],rule):[];
  latest.push(...[...byTask.values()].map(r=>({...r,identity,task_id:taskId(r.任务名称)})));
  learners.push({identity,course,period,certificate_name,wechat:scalar(ordered.at(-1).微信昵称),group:[...groupset].join('、'),record_ids:list.map(r=>r.record_id),source_record_id:ordered.at(-1).record_id,task_ids:[...byTask.keys()],missing,qualified:valid&&!!rule&&missing.length===0,has_pending:!valid,name_bad:nameBad(certificate_name)});
 }
 return {contract_version:CONTRACT_VERSION,rounds,learners,latest,pending,recordStates,registry,neighbours:neighbours.map(ns=>[...ns])};
}
export function verifySource(row,sourceRows){
 const id=scalar(row.来源记录ID)||row.来源打卡?.[0]?.id||'';
 const matches=sourceRows.filter(r=>r.record_id===id);
 if(matches.length!==1)throw Error('来源record_id缺失或不唯一');
 const source=matches[0],linked=row.来源打卡??[];
 if(linked.length>1||linked.some(v=>v.id!==id))throw Error('关联与来源record_id不一致');
 if(scalar(row.所学课程)!==scalar(source.所学课程))throw Error('来源课程不一致');
 if(!scalar(source.系统学习者标识)||scalar(row.系统学习者标识)!==scalar(source.系统学习者标识))throw Error('来源身份回读不一致');
 return source;
}
export function missingSubmissionFormula(prefix=''){
 return REQUIRED_FIELDS.map(f=>['课程评价','所学课程','群号','任务名称'].includes(f)?`ISBLANK(${prefix}[${f}])`:`ISBLANK(TRIM(IFBLANK(${prefix}[${f}],"")))`).join('||');
}
export function submissionIssueFormula(prefix=''){
 const field=name=>`${prefix}[${name}]`;
 const wx=field('微信昵称匹配值');
 return `IFERROR(IFS(${field('人工核对')}="无效"||${field('核对表结果')}="无效","人工判定无效",${missingSubmissionFormula(prefix)}||ISBLANK(${wx}),"必填项缺失",REGEXMATCH(${wx},"^([-/\\\\.0-9]+|null|none|无|暂无|微信昵称|证书昵称)$")||LEN(${wx})>40,"微信昵称异常",ISBLANK(${field('进度Task编号')}),"任务名称缺失或异常",ISBLANK(${field('提交时间')}),"提交时间异常",NOT(REGEXMATCH(${field('自动编号')},"^NO\\.\\d+$")),"自动编号异常",TRUE(),"可统计"),"公式异常待核对")`;
}
export function validatePersonnel(people,normalRole='结课证书',currentRules=[],manualApprovals=[],finalApprovals=[]){
 const issues=[],seen=new Set();
 for(const [index,p] of people.entries()){
  const label=`第${index+1}行`,stable=p.稳定人员标识||p.person_id;
  if(!stable){issues.push(label+'缺稳定身份，不能按昵称临时重建');continue;}
  const key=JSON.stringify([p.营期??'',p.所学课程,p.canonical_person_id||stable,p.角色]);
  if(seen.has(key))issues.push(label+'同固定身份同课程同营期同角色重复');seen.add(key);
  const evidence=p.资格核验;
  if(evidence?.source_kind==='final_roster'){
   const approved=finalApprovals.find(a=>a.record_id===p.最终名单记录ID&&a.base_token===evidence.base_token&&a.table_id===evidence.table_id&&a.course===p.所学课程&&a.group===p.群号&&a.role===p.角色&&a.name===p.证书昵称&&a.person_id===stable&&a.basis===p.制证依据);
   if(!approved||evidence.contract_version!==CONTRACT_VERSION||evidence.eligible!==true||evidence.person_id!==stable||evidence.course!==p.所学课程||evidence.original_name!==p.证书昵称||p.名单核准状态!=='已核准'||evidence.source_record_ids?.length!==1||evidence.source_record_ids[0]!==p.最终名单记录ID)issues.push(label+'缺当前终版Base制证依据');
   continue;
  }
  if(p.角色!==normalRole)continue;
  if(evidence?.source_kind==='manual_graduation'){
   const approved=manualApprovals.find(a=>a.course===p.所学课程&&a.group===p.群号&&a.names?.includes(p.证书昵称)&&a.basis&&evidence.source_record_ids?.length===1&&a.record_id===evidence.source_record_ids[0]);
   if(!approved||evidence.contract_version!==CONTRACT_VERSION||evidence.eligible!==true||evidence.person_id!==stable||evidence.course!==p.所学课程||evidence.original_name!==p.证书昵称||p.名单核准状态!=='已核准'||p.优秀申报记录ID!==approved.record_id||p.制证依据!==approved.basis)issues.push(label+'缺当前人工结营名单核准及来源依据');
   continue;
  }
  if(!evidence||evidence.contract_version!==CONTRACT_VERSION||evidence.eligible!==true||evidence.person_id!==stable||evidence.course!==p.所学课程||!Array.isArray(evidence.source_record_ids)||!evidence.source_record_ids.length){issues.push(label+'缺当前普通证书资格核验，请从最新打卡重新导出');continue;}
  try{const missing=missingTasks(evidence.task_ids??[],{...evidence.rule,course:evidence.course});if(missing.length)issues.push(label+'缺有效Task：'+missing.join('、'));}catch(error){issues.push(label+error.message);}
  const configured=currentRules.filter(r=>r.course===p.所学课程&&(r.role??normalRole)===p.角色);
  if(configured.length!==1){issues.push(label+'制证配置缺唯一当前Task规则，请刷新配置及导出');continue;}
  try{const missing=missingTasks(evidence.task_ids??[],configured[0]);if(missing.length)issues.push(label+'当前规则缺有效Task：'+missing.join('、'));}catch(error){issues.push(label+error.message);}
 }
 return issues;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv[2]!=='verify-personnel')throw Error('learning-record-contract.mjs verify-personnel < JSON stdin');
 const {people,normal_role,current_rules,manual_graduation_approvals,final_roster_approvals}=JSON.parse(fs.readFileSync(0,'utf8'));
 const issues=validatePersonnel(people,normal_role,current_rules,manual_graduation_approvals,final_roster_approvals);console.log(JSON.stringify({ok:issues.length===0,issues}));if(issues.length)process.exitCode=1;
}

