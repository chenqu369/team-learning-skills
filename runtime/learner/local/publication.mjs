import {scalar} from '../scripts/learning-record-contract.mjs';
import {equal} from './engine.mjs';
const period=info=>info.period.replace('-','');
const finalKey=r=>JSON.stringify([scalar(r.营期编号),scalar(r.所学课程),scalar(r.系统学习者标识),scalar(r.证书类型)]);
export function awardPlan({roster,names,excellent,course,group,period,captains,basis}){
 if(!Array.isArray(captains)||!basis)throw Error("需明确优秀队长名单（无人时传空数组）及人工依据");
 const updates=[];
 for(const name of names){const hits=roster.filter(r=>scalar(r.营期编号)===period&&scalar(r.所学课程)===course&&scalar(r.群号)===group&&scalar(r.证书昵称)===name);if(hits.length!==1||!scalar(hits[0].系统学习者标识))throw Error('人工名单未对应唯一身份：'+name);updates.push({record_id:hits[0].record_id,fields:{优秀学习者:excellent.includes(name),优秀队长:captains.includes(name),评阅依据:basis}});}
 return {updates};
}
export function finalPlan({course_info,roster,existing,course,group}){
 const creates=[],pending=[],seen=new Set();
 for(const r of roster){
  if(scalar(r.营期编号)!==period(course_info)||course&&scalar(r.所学课程)!==course||group&&scalar(r.群号)!==group||scalar(r.结营判定)!=='符合结营要求')continue;
  const c=course_info.courses.find(c=>c.checkin_name===scalar(r.所学课程));
  if(!c||c.graduation_mode==='manual_roster')continue;
  if(!r.系统学习者标识||!scalar(r.证书昵称)||!c.course_code||!c.certificate_date){pending.push({record_id:r.record_id,reason:'身份、制证名或课程参数待补'});continue;}
  const roles=['结课证书',...(r.优秀学习者?['优秀学习者证书']:[]),...(r.优秀队长?['优秀队长证书']:[])];
  for(const role of roles){
   if(role!=='结课证书'&&!scalar(r.评阅依据)){pending.push({record_id:r.record_id,role,reason:'优秀评阅依据待补'});continue;}
   const row={微信昵称:r.微信昵称,群号:r.群号,制证确认:['已确认'],课程编号:c.course_code,系统学习者标识:r.系统学习者标识,结营日期:c.certificate_date.replace(/^(\d{4})-(\d{2})-(\d{2})$/,'$1年$2月$3日'),证书类型:[role],制作状态:['待制作'],证书编号:'',营期编号:period(course_info),结营与评优记录:[{id:r.record_id}],所学课程:r.所学课程,营期名:`第${course_info.period_number}期组队学习`,证书昵称:r.证书昵称};
   const key=finalKey(row);if(seen.has(key))throw Error('源名单身份重复：'+key);seen.add(key);
   const matches=existing.filter(x=>finalKey(x)===key);if(matches.length>1)throw Error('终版同身份同角色重复');
   if(matches.length){if(matches[0].证书昵称!==row.证书昵称||!equal(matches[0].群号,row.群号))pending.push({record_id:matches[0].record_id,reason:'终版人工昵称或群号不同，保留人工值'});continue;}
   const anonymous=existing.filter(x=>!scalar(x.系统学习者标识)&&scalar(x.营期编号)===period(course_info)&&scalar(x.所学课程)===scalar(r.所学课程)&&scalar(x.证书类型)===role&&x.证书昵称===r.证书昵称);
   if(anonymous.length){pending.push({record_id:r.record_id,reason:'同名既有终版缺身份，不重复新增'});continue;}
   creates.push(row);
  }
 }
 return {creates,pending};
}
export function receiptPlan({course_info,finals,existing,course,group}){
 const groups=new Map(),creates=[],updates=[],pending=[];
 for(const r of finals){
  if(scalar(r.营期编号)!==period(course_info)||scalar(r.制证确认)!=='已确认'||course&&scalar(r.所学课程)!==course||group&&scalar(r.群号)!==group)continue;
  if(!r.系统学习者标识){pending.push({record_id:r.record_id,reason:'终版缺稳定身份'});continue;}
  const key=JSON.stringify([period(course_info),scalar(r.所学课程),r.系统学习者标识]);
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
 }
 for(const [key,rows]of groups){
  if(new Set(rows.map(r=>r.证书昵称)).size!==1||new Set(rows.map(r=>scalar(r.群号))).size!==1){pending.push({key,reason:'同人不同证书昵称或群号冲突'});continue;}
  const r=rows[0],row={营期编号:period(course_info),所学课程:r.所学课程,群号:r.群号,归并标识:key,制证明细:rows.map(r=>({id:r.record_id})),证书昵称:r.证书昵称};
  const matches=existing.filter(x=>x.归并标识===key);if(matches.length>1)throw Error('领取主记录重复');
  if(!matches.length){if(existing.some(x=>!x.归并标识&&x.证书昵称===r.证书昵称&&scalar(x.所学课程)===scalar(r.所学课程))){pending.push({key,reason:'旧同名领取行缺身份，待核对'});continue;}creates.push(row);}
  else{const old=matches[0];if(old.证书昵称!==row.证书昵称||!equal(old.群号,row.群号)){pending.push({key,reason:'领取人工值冲突，保留'});continue;}const links=[...new Set([...(old.制证明细??[]).map(x=>x.id),...row.制证明细.map(x=>x.id)])].map(id=>({id}));if(!equal(links,old.制证明细))updates.push({record_id:old.record_id,fields:{制证明细:links}});}
 }
 return {creates,updates,pending};
}
