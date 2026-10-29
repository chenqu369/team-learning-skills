export function toBeijing(value){
  if(typeof value!=='string') return value;
  const d=new Date(value); if(Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d)+'（已转换为北京时间）';
}
export function assertBeijingIso(value){
  if(typeof value!=='string'||!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(value)) throw Error('TIMEZONE_REQUIRED: deadline/end_time must be ISO with +08:00');
  return value;
}
