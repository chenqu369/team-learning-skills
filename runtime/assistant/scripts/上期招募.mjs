import assert from 'node:assert/strict';
export function inheritRecruitment(overrides,previous){
 const result={...overrides};if(!previous)return result;
 assert.ok(previous.project?.id&&Array.isArray(previous.tasks),'上期快照结构不完整');
 if(overrides.previous_project_id!=null)assert.equal(previous.project.id,overrides.previous_project_id,'上期项目ID不一致');
 assert.notEqual(previous.project.id,overrides.target_project_id,'上期不能是本期');
 for(const key of ['certificate_scene','certificate_template_ids'])if(!Object.hasOwn(result,key)){assert.ok(Object.hasOwn(previous.project,key),'上期缺少证书配置');result[key]=previous.project[key];}
 if(!Object.hasOwn(result,'post_submit_content')){
  result.post_submit_content_by_role={...result.post_submit_content_by_role};
  for(const role of ['运营助教','专业助教']){
   if(Object.hasOwn(result.post_submit_content_by_role,role))continue;
   const hits=previous.tasks.filter(t=>t.assistant_identity===role);assert.ok(hits.length&&hits.every(t=>Object.hasOwn(t,'post_submit_content')),'上期缺少岗位提示语：'+role);
   const texts=[...new Set(hits.map(t=>t.post_submit_content))];assert.equal(texts.length,1,'上期岗位提示语冲突：'+role);result.post_submit_content_by_role[role]=texts[0];
  }
 }
 return result;
}
export async function collectPrevious(request,id){
 if(!Number.isInteger(id)||id<=0)throw Error('必须明确上一期项目ID');
 const project=await request('GET',`/api/v1/admin/projects/${id}`);if(project.id!==id)throw Error('上期ID不一致');
 const tasks=[],seen=new Set();let total=null;
 for(let page=1;page<=1000;page++){
  const data=await request('GET',`/api/v1/admin/projects/${id}/tasks?page=${page}&page_size=100`);
  if(!Array.isArray(data.items)||!Number.isInteger(data.total)||data.total<0||(total!==null&&total!==data.total))throw Error('上期分页结构变化');total=data.total;
  for(const t of data.items){if(seen.has(t.id))throw Error('上期分页重复');seen.add(t.id);tasks.push(t);}
  if(tasks.length===total)return {project,tasks,captured_at:new Date().toISOString()};
  if(tasks.length>total||!data.items.length)throw Error('上期未完整读取');
 }
 throw Error('上期分页未结束');
}
