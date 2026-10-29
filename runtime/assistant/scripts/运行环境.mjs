import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const SKILL_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const load=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
export function run(program,args,{cwd=process.cwd(),input}={}){
  const result=spawnSync(program,args,{cwd,input,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,
    env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${path.basename(program)} 执行失败（${result.status}）：${(result.stderr||result.stdout).slice(0,1600)}`);
  return result.stdout;
}
export function python(config){
  const candidates=[config.python_path,process.env.ASSISTANT_PYTHON,
    'python3','python',
    path.join(process.env.USERPROFILE||'','.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe')].filter(Boolean);
  for(const candidate of [...new Set(candidates)]){
    try{const v=run(candidate,['-c','import sys,openpyxl;print(sys.version_info.major)']).trim();if(v==='3')return candidate;}catch{}
  }
  throw Error('未找到可用的 Python 3＋openpyxl。请在配置 python_path 或环境变量 ASSISTANT_PYTHON 中指定现有环境；不会自动安装。');
}
export function cli(config){
  return config.lark_cli_path||process.env.LARK_CLI_PATH||'lark-cli';
}
export function makeLark(config){
  return (domain,command,args=[],input)=>{
    const raw=run(cli(config),[domain,command,'--as','user',...args],{input});
    const result=JSON.parse(raw.replace(/^\uFEFF/,''));
    if(result.ok!==true)throw Error(`飞书 ${domain} ${command} 未返回 ok:true`);
    return result;
  };
}
export function readConfig(file){
  const location=path.resolve(file),config=load(location),base=path.dirname(location);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(config.period||''))throw Error('配置 period 必须为 YYYY-MM');
  return {config,resolve:value=>path.resolve(base,value),location};
}
