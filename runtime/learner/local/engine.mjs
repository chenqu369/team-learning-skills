import {createHash} from 'node:crypto';
import {graduate} from '../scripts/learning-cycle.mjs';
import {scalar,normaliseWechat} from '../scripts/learning-record-contract.mjs';
import {buildCourseOutputs} from '../../shared/course-info.mjs';
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v??'';
export const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export const systemFields=['名单标识','系统学习者标识','所学课程','群号','营期编号','微信昵称','来源打卡','有效Task列表','缺少必需Task','结营判定'];
export const protectedFields=['证书昵称','优秀学习者','优秀队长','评阅人','评阅依据','备注'];
const ids=r=>(r.来源打卡??[]).map(v=>typeof v==='string'?v:v.id);
export function planSync(input){
 const {course_info:info,learner:rules}=buildCourseOutputs(input.course_info),period=info.period.replace('-','');
 const existing=input.existing??[],current=existing.filter(r=>scalar(r.营期编号)===period),keys=new Set();
 for(const r of current){if(r.名单标识){if(keys.has(r.名单标识))throw Error('已有名单标识重复：'+r.名单标识);keys.add(r.名单标识);}}
 const previous=current.filter(r=>scalar(r.系统学习者标识)).map(r=>({period:info.period,course:scalar(r.所学课程),person_id:scalar(r.系统学习者标识),certificate_name:scalar(r.证书昵称),excellent_learner:!!r.优秀学习者,excellent_captain:!!r.优秀队长}));
 const result=graduate({course_info:input.course_info,records:input.records,existing_roster:previous,identity_registry:input.identity_registry,base_token:input.base_token,table_id:input.source_table,confirmed_aliases:input.confirmed_aliases??[],confirmed_cross_groups:input.confirmed_cross_groups??[]});
 const creates=[],updates=[],expected=[],pending=[...result.pending],used=new Set(),statusCounts={},approvalMatches=new Map();
 for(const a of input.approvals??[]){
  const hits=result.learners.filter(l=>l.course===a.course&&l.group===a.group&&[l.certificate_name,l.wechat].some(n=>normaliseWechat(n)===normaliseWechat(a.name)));
  if(hits.length!==1||!hits[0].person_id||hits[0].status==='待核对身份'){pending.push({course:a.course,name:a.name,reason:'人工名单未匹配唯一已确认身份'});continue;}
  approvalMatches.set(hits[0].person_id+'|'+a.course,a);
 }
 const known=new Set(info.courses.map(c=>c.checkin_name));
 for(const l of result.learners){
  if(!known.has(l.course))continue;
  const a=approvalMatches.get(l.person_id+'|'+l.course);
  const status=l.status==='待核对身份'?'待核对身份':a?'符合结营要求':l.status==='课程Task待确认'?'课程规则待确认':l.qualified?'符合结营要求':'未完成要求';
  const identity=l.person_id||'PENDING-'+hash([...l.source_record_ids].sort().join('|')).slice(0,20);
  const row={名单标识:JSON.stringify([period,l.course,identity]),系统学习者标识:l.person_id,所学课程:[l.course],群号:l.group.includes('、')?[]:[l.group],营期编号:period,微信昵称:l.wechat,来源打卡:l.source_record_ids.map(id=>({id})),有效Task列表:l.valid_task_ids.join('、'),缺少必需Task:l.missing_task_ids.join('、'),结营判定:[status]};
  let matches=current.filter(r=>r.名单标识===row.名单标识);
  if(!matches.length)matches=current.filter(r=>scalar(r.所学课程)===l.course&&(!scalar(r.系统学习者标识)||!l.person_id)&&ids(r).some(id=>l.source_record_ids.includes(id)));
  if(matches.length>1)throw Error('来源对应重复主记录，需核对：'+row.名单标识);
  const old=matches[0];
  if(old){
   if(used.has(old.record_id))throw Error('同一旧名单对应多个新身份，需人工核对');used.add(old.record_id);
   const fields=Object.fromEntries(Object.entries(row).filter(([k,v])=>!equal(v,old[k])));
   if(Object.keys(fields).length)updates.push({record_id:old.record_id,fields});
   expected.push({record_id:old.record_id,fields:row});
  }else{
   const fields={...row,证书昵称:a?.name||l.certificate_name||l.wechat,优秀学习者:!!a?.excellent_learner,优秀队长:!!a?.excellent_captain,备注:'本地工作流按当前课程JSON核验；人工字段后续保留',...(a?{评阅依据:a.basis}: {})};
   creates.push(fields);expected.push({fields});
  }
  statusCounts[status]=(statusCounts[status]??0)+1;
 }
 const coverage=input.records.map(r=>{
  const course=scalar(r.所学课程),manual=info.courses.find(c=>c.checkin_name===course)?.graduation_mode==='manual_roster';
  if(manual)return {record_id:r.record_id,status:'excluded',reason:'课程JSON明确为人工名单制证，不参加飞书结营判定'};
  const hits=result.learners.filter(l=>l.source_record_ids.includes(r.record_id));
  if(hits.length>1)throw Error('原始记录被重复统计：'+r.record_id);
  if(hits.length===1&&known.has(course))return {record_id:r.record_id,status:'planned'};
  if(!pending.some(p=>p.record_id===r.record_id))pending.push({record_id:r.record_id,course,reason:'未进入有效核验；课程或身份待确认'});
  return {record_id:r.record_id,status:'pending',reason:'必填项、课程或身份未满足核验要求'};
 });
 const orphans=current.filter(r=>!used.has(r.record_id));
 for(const r of orphans)pending.push({record_id:r.record_id,course:scalar(r.所学课程),reason:'已有名单未匹配本轮有效来源；保留人工行，不自动删除'});
 return {schema_version:1,period:info.period,creates,updates,expected,pending,coverage,registry:result.registry,certificate_courses:rules.course_parameters,skipped_courses:result.skipped_courses,summary:{source_records:input.records.length,creates:creates.length,updates:updates.length,unchanged:expected.length-creates.length-updates.length,pending_records:coverage.filter(r=>r.status==='pending').length,excluded_records:coverage.filter(r=>r.status==='excluded').length,unmatched_existing:orphans.length,statuses:statusCounts}};
}
