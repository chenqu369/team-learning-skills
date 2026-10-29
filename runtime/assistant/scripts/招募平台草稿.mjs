import fs from 'node:fs';
import path from 'node:path';
import {enforceDraftOnly} from './草稿边界.mjs';
import {assertBeijingIso} from './北京时间.mjs';
import {load,save} from './运行环境.mjs';
import {prepareProgressBrowserScript} from './招募进度.mjs';
// 请求函数由已登录浏览器提供；函数不接收、输出或保存凭据。
export async function runDrafts(request,manifest,{apply=false}={}){
  const started=Date.now();
  const id=manifest.project_id;
  if(!Number.isInteger(id)||id<=0)throw Error('必须指定明确的目标项目ID');
  enforceDraftOnly('PUT',`/api/v1/admin/projects/${id}`,manifest.project);
  for(const t of manifest.tasks)enforceDraftOnly('POST',`/api/v1/admin/projects/${id}/tasks`,t.config);
  const project=await request('GET',`/api/v1/admin/projects/${id}`);
  if(project.id!==id||project.status!=='draft')throw Error('目标项目不是指定草稿；停止执行');
  for(const [key,label] of [['name','名称'],['assistant_period','期数'],['assistant_category','类别']])
    if(manifest.project[key]!=null&&String(project[key]??'')!==String(manifest.project[key]))throw Error(`目标项目${label}不一致；停止执行`);
  if(manifest.tasks_only)for(const key of ['certificate_scene','certificate_template_ids'])if(Object.hasOwn(manifest.project,key)&&JSON.stringify(project[key]??null)!==JSON.stringify(manifest.project[key]??null))throw Error('已有项目证书配置不符；仅任务模式不能修改项目：'+key);
  async function readTasks(){
   const all=[],seen=new Set();let total=null;
   for(let page=1;page<=1000;page++){
    const data=await request('GET',`/api/v1/admin/projects/${id}/tasks?page=${page}&page_size=100`);
    if(!Array.isArray(data.items))throw Error('任务列表接口结构变化');
    for(const task of data.items){if(seen.has(task.id))throw Error('分页返回重复任务，不能认为已读完整');seen.add(task.id);all.push(task);}
    if(Number.isInteger(data.total)){
      if(data.total<0||(total!==null&&data.total!==total))throw Error('任务列表总数变化，请重新预检');
      total=data.total;
      if(all.length>total)throw Error('任务列表总数不一致');
      if(all.length===total)break;
      if(!data.items.length)throw Error('任务列表未读完整，禁止写入');
    }else if(typeof data.has_more==='boolean'){
      if(!data.has_more)break;
      if(!data.items.length)throw Error('分页没有前进，禁止写入');
    }else throw Error('任务列表没有明确的分页完整性信息，先确认接口结构');
    if(page===1000)throw Error('任务列表分页未结束');
   }
   return all;
  }
  const all=await readTasks();
  if(apply&&!manifest.tasks_only&&manifest.project.contact_qr_image_url!=null&&(!manifest.tasks.length||manifest.tasks.some(t=>t.config.contact_qr_image_url!==manifest.project.contact_qr_image_url)))throw Error('项目二维码须与本批任务一致，以专用接口核验；停止项目写入');
  const results=[];
  async function equal(actual,expected){
    for(const [key,value] of Object.entries(expected)){
      if(key==='form_fields'){
        const shape=xs=>xs?.map(x=>({label:x.label,field_type:x.field_type,is_required:x.is_required,sort_order:x.sort_order,options:x.options}));
        if(JSON.stringify(shape(actual[key]))!==JSON.stringify(shape(value)))throw Error('表单字段回读不一致');
      }else if(key==='deadline'){
        if(value==null?actual[key]!=null:Date.parse(actual[key])!==Date.parse(value))throw Error('截止时间回读不一致');
      }else if(key==='contact_qr_image_url'&&value!=null){
        const qr=await request('GET',`/api/v1/admin/tasks/${actual.id}/contact-qr`);
        const canonical=s=>typeof s==='string'?s.replace(/^\/api\/v1\/files\/download\//,'/uploads/'):s;
        if(canonical(qr.image_url)!==canonical(value))throw Error('负责人二维码回读不一致');
      }else if(JSON.stringify(actual[key]??null)!==JSON.stringify(value??null))throw Error('任务字段回读不一致：'+key);
    }
  }
  // 先检查所有同名任务，发现旧正文差异或重复项时，在写入前停止。
  for(const entry of manifest.tasks){
    const hits=all.filter(t=>t.title===entry.config.title);
    if(hits.length>1)throw Error('目标项目有重复任务标题：'+entry.config.title);
    if(hits.length){if(hits[0].status!=='draft')throw Error('同名任务不是草稿');await equal(hits[0],entry.config);}
  }
  if(apply&&!manifest.tasks_only){
    const result=await request('PUT',`/api/v1/admin/projects/${id}`,manifest.project);
    if(result.status!=='draft')throw Error('项目写入返回非草稿，停止后续动作');
    const again=await request('GET',`/api/v1/admin/projects/${id}`);
    for(const [key,value] of Object.entries(manifest.project))if(key!=='contact_qr_image_url'&&JSON.stringify(again[key]??null)!==JSON.stringify(value??null))throw Error('项目字段回读不一致：'+key);
  }
  for(const entry of manifest.tasks){
    let task=all.find(t=>t.title===entry.config.title);
    if(!task&&apply){
      task=await request('POST',`/api/v1/admin/projects/${id}/tasks`,entry.config);
      if(!task?.id||task.status!=='draft')throw Error('创建结果不明确或不是草稿；先回读，不重发');
      const check=await readTasks();
      const hits=check.filter(t=>t.id===task.id);
      if(hits.length!==1)throw Error('新增任务未在回读列表中找到；停止，不重发');
      await equal(hits[0],entry.config);
    }
    results.push({business_key:entry.business_key,id:task?.id??null,status:task?'draft':'待创建',verified:!!task});
  }
  if(apply){const final=await readTasks();for(const entry of manifest.tasks){const found=final.filter(t=>t.title===entry.config.title);if(found.length!==1||found[0].status!=='draft')throw Error('最终整批草稿状态异常');await equal(found[0],entry.config);}const p=await request('GET',`/api/v1/admin/projects/${id}`);if(p.status!=='draft')throw Error('最终项目状态异常');}
  return {project_id:id,apply,task_count:results.length,tasks:results,description_and_requirement_checked:true,tasks_only:!!manifest.tasks_only,pending:manifest.pending||[],duration_ms:Date.now()-started};
}
export async function runRecruitExport(fetcher,target){
  const id=target.project_id;
  if(!Number.isInteger(id)||id<1)throw Error('报名导出需要明确的项目 ID');
  if(!/^[^/\\]+\.xlsx$/i.test(target.filename)||!target.filename.includes(`project-${id}`))throw Error('报名导出文件名须包含项目 ID 且为 XLSX');
  const projectResponse=await fetcher(`/api/v1/admin/projects/${id}`);
  if(!projectResponse.ok)throw Error(`项目定向读取失败：${projectResponse.status}`);
  const project=await projectResponse.json();
  if(project.id!==id)throw Error('目标项目 ID 不一致，禁止导出');
  for(const [key,value] of [['name',target.name],['assistant_period',target.period],['assistant_category',target.category]])
    if(value==null||String(project[key]??'')!==String(value))throw Error(`目标项目${key}不一致，禁止导出`);
  const response=await fetcher(`/api/v1/admin/projects/${id}/tasks/export`);
  if(!response.ok)throw Error(`项目报名导出接口失败：${response.status}`);
  const type=response.headers.get('content-type')||'';
  if(!/application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)/i.test(type))throw Error('报名导出不是 XLSX 响应');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==0x03||bytes[3]!==0x04)throw Error('报名导出不是有效 XLSX 文件头');
  return {project_id:id,filename:target.filename,bytes};
}
export function prepareBrowserScript(directory,projectId,period,courses,progressFieldMap){
  const config=load(path.join(directory,'task_configs.json'));
  const manifest={project_id:projectId,project:load(path.join(directory,'project_config.json')),tasks:config.tasks};
  const options=path.join(directory,'草稿执行选项.json');if(fs.existsSync(options))Object.assign(manifest,load(options));
  for(const t of manifest.tasks)enforceDraftOnly('POST',`/api/v1/admin/projects/${projectId}/tasks`,t.config);
  save(path.join(directory,'平台草稿载荷.json'),manifest);
  const text=`// 在 contributor.datawhale.cn 已登录页面内运行。先预检，再根据本轮用户授权调用 true。\n(async()=>{\n${assertBeijingIso.toString()}\n${enforceDraftOnly.toString()}\n${runDrafts.toString()}\nconst manifest=${JSON.stringify(manifest).replace(/</g,'\\u003c')};\nif(location.origin!=='https://contributor.datawhale.cn')throw Error('请打开贡献者平台页面');\nconst request=async(method,route,body)=>{const token=localStorage.getItem('access_token');if(!token)throw Error('请先登录');const response=await fetch(route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('平台请求失败 '+response.status+'；停止并先回读');return response.json();};\nwindow.assistantDraftRun=async(apply=false)=>{const result=await runDrafts(request,manifest,{apply});window.assistantDraftResult=result;return result;};\nreturn window.assistantDraftRun(false);\n})();\n`;
  fs.writeFileSync(path.join(directory,'浏览器草稿执行稿.js'),text);
  if(period){
    const project=manifest.project;
    const target={project_id:projectId,name:project.name,period:String(project.assistant_period),category:project.assistant_category,
      filename:`${period}_project-${projectId}_assignments.xlsx`};
    const exportScript=`// 在 contributor.datawhale.cn 已登录页面执行，按项目 ID 读取并下载报名 XLSX。\n(async()=>{\n${runRecruitExport.toString()}\nconst target=${JSON.stringify(target)};\nif(location.origin!=='https://contributor.datawhale.cn')throw Error('请打开贡献者平台页面');\nconst fetcher=async route=>{const token=localStorage.getItem('access_token');if(!token)throw Error('请先登录');return fetch(route,{headers:{Authorization:'Bearer '+token}})};\nwindow.assistantRecruitExport=async()=>{const result=await runRecruitExport(fetcher,target);const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));try{const a=document.createElement('a');a.href=url;a.download=result.filename;document.body.appendChild(a);a.click();a.remove();return {project_id:result.project_id,filename:result.filename,bytes:result.bytes.length,download_started:true,local_file_verified:false};}finally{setTimeout(()=>URL.revokeObjectURL(url),60000)}};\nreturn {project_id:target.project_id,route:'/api/v1/admin/projects/'+target.project_id+'/tasks/export',ready:true,download_started:false};\n})();\n`;
    fs.writeFileSync(path.join(directory,'浏览器报名导出稿.js'),exportScript);
    if(courses){
      const progressScript=prepareProgressBrowserScript(courses,{id:projectId,name:project.name,assistant_period:project.assistant_period,assistant_category:project.assistant_category},progressFieldMap);
      fs.writeFileSync(path.join(directory,'浏览器报名导出稿.js'),progressScript);
      fs.writeFileSync(path.join(directory,'浏览器进度与满额导出.js'),progressScript);
    }
  }
}
