import fs from 'node:fs';import path from 'node:path';
export function measureUsage(events,turnId){
 const start=events.findIndex(e=>e.payload?.type==='task_started'&&e.payload.turn_id===turnId);
 const end=events.findIndex((e,i)=>i>start&&e.payload?.type==='task_complete'&&e.payload.turn_id===turnId);
 if(start<0||end<0)throw Error('回合未完成或找不到起止记录；不能计为完整成本');
 const before=events.slice(0,start).filter(e=>e.payload?.type==='token_count'&&e.payload.info).at(-1)?.payload.info.total_token_usage||{};
 const usage=events.slice(start,end).filter(e=>e.payload?.type==='token_count'&&e.payload.info);
 if(!usage.length)throw Error('缺少回合Token计量记录');
 const final=usage.at(-1).payload.info.total_token_usage,result={turn_id:turnId,start_utc:events[start].timestamp,end_utc:events[end].timestamp,duration_ms:events[end].payload.duration_ms};
 for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']){if(!Number.isFinite(final[key]??0))throw Error('Token记录异常');result[key]=(final[key]??0)-(before[key]??0);if(result[key]<0)throw Error('累计Token重置，需单独核对');}
 result.uncached_input_tokens=result.input_tokens-result.cached_input_tokens;
 if(result.uncached_input_tokens<0||result.total_tokens!==result.input_tokens+result.output_tokens)throw Error('Token分项不一致');
 result.script_direct_llm_requests=0;result.model_responses=usage.filter((e,i)=>i===0||e.payload.info.total_token_usage.total_tokens!==usage[i-1].payload.info.total_token_usage.total_tokens).length;
 return result;
}
export function usageReport(ctx,out){
 const settings=ctx.config.usage||{};
 if(!settings.session_log||!settings.turn_id)throw Error('成本记录需要usage.session_log和已完成回合turn_id');
 const events=fs.readFileSync(ctx.resolve(settings.session_log),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const result=measureUsage(events,settings.turn_id);
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'时间与Token.json'),JSON.stringify(result,null,2));
 const text=`## 执行成本：${result.turn_id}\n\n完整回合耗时${result.duration_ms/1000}秒；输入${result.input_tokens} Token（含缓存${result.cached_input_tokens}，非缓存${result.uncached_input_tokens}）；输出${result.output_tokens}；合计${result.total_tokens}。推理输出包含在输出内，不重复相加。脚本直接LLM请求0次。仅统计此已完成回合，不含后续核对和修订；浏览器duration_ms另记为底层操作时间。\n`;
 fs.writeFileSync(path.join(out,'复盘成本片段.md'),text);
 if(settings.retrospective_file){const file=ctx.resolve(settings.retrospective_file);const existing=fs.readFileSync(file,'utf8');if(!existing.includes(`## 执行成本：${result.turn_id}`))fs.appendFileSync(file,'\n'+text);}
 return result;
}
