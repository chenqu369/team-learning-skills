import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {enforceDraftOnly} from './草稿边界.mjs';
import {inheritRecruitment} from './上期招募.mjs';
import {assertBeijingIso} from './北京时间.mjs';
import {recruitmentCourseInput} from '../../shared/course-info.mjs';

const readJson = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (dir, name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));

function argsOf(argv) {
  const out = {command: argv[2]};
  for (let i = 3; i < argv.length; i += 2) {
    assert.match(argv[i] || '', /^--[a-z-]+$/, `未知参数：${argv[i]}`);
    assert.ok(argv[i + 1], `参数 ${argv[i]} 缺少值`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export function normalizeText(value = '') {
  return String(value).replace(/&#x20;/gi, ' ').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function applyOverrides(cache, overrides) {
  assert.equal(String(cache.source.period), String(overrides.period), '期数不一致，禁止跨期复用用户修正');
  const allowed = new Set(cache.courses.map(course => course.course_key));
  for (const key of Object.keys(overrides.course_overrides || {})) assert.ok(allowed.has(key), `用户修正包含未知课程：${key}`);
  return cache.courses.map(course => ({...course, ...(overrides.course_overrides?.[course.course_key] || {})}));
}

function section(title, value) {
  const text = normalizeText(value);
  return text ? `【${title}】\n${text}` : '';
}

function scheduleOf(course) {
  const parts = [];
  if (course.start_time) parts.push(`课程开始时间：${course.start_time.replace('T', ' ').replace('+08:00', '')}（北京时间）`);
  if (course.end_time) parts.push(`课程结束时间：${course.end_time.replace('T', ' ').replace('+08:00', '')}（北京时间）`);
  if (course.task_count_status === '已确认') {
    assert.ok(Number.isInteger(course.task_count) && course.task_count > 0, `已确认 Task 数无效：${course.name}`);
    parts.push(`Task 数：${course.task_count}`);
  }
  if (course.duration) parts.push(`学习周期：${course.duration}`);
  return [...new Set(parts)].join('；');
}

export function buildRequirement(course, role, roleTemplates, limit = 600) {
  const parts = [section('任务要求', roleTemplates.common.requirement),
    section(`${role}规范要求`, roleTemplates.roles[role]?.requirement),
    section('课程说明', course.description), section('面向人群', course.audience),
    section('本期学习规划', scheduleOf(course)), section('课程内容地址', course.source_url)].filter(Boolean);
  let result = parts.join('\n\n');
  if (course.schedule_summary && result.length + course.schedule_summary.length + 2 <= limit)
    result += `\n\n${normalizeText(course.schedule_summary)}`;
  assert.ok(result.length <= limit, `课程要求超过 ${limit} 字，请核对源文案：${course.name}`);
  return result;
}

function postSubmitContent(overrides,role) {
  if(Object.hasOwn(overrides.post_submit_content_by_role||{},role))return postSubmitContent({...overrides,post_submit_content:overrides.post_submit_content_by_role[role],post_submit_content_by_role:{}},role);
  if (Object.hasOwn(overrides, 'post_submit_content')) {
    assert.ok(overrides.post_submit_content === null || typeof overrides.post_submit_content === 'string', '报名成功提示语必须为原文字符串或空值');
    return overrides.post_submit_content;
  }
  if(overrides.allow_incomplete && !normalizeText(overrides.owner_wechat??''))return null;
  assert.ok(typeof overrides.owner_wechat === 'string' && normalizeText(overrides.owner_wechat), '缺少本轮用户提供的负责人微信');
  return `感谢报名助教！请添加项目负责人微信：${overrides.owner_wechat}，备注报名课程和助教岗位，便于加入助教群。`;
}

export function buildConfigs({roleTemplates, cache, overrides,previous}) {
  overrides=inheritRecruitment(overrides,previous);
  assert.equal(overrides.source, 'user', '负责人微信和用户修正必须来自 user');
  assert.equal(overrides.publication_mode, 'draft_only', '只允许 draft_only');
  if(overrides.link_released_at==null){
    assert.equal(overrides.deadline??null,null,'未提供招募链接首次发布时间，不能手填截止时间');
    assert.equal(overrides.allow_incomplete,true,'招募链接未发布；只允许显式不完整草稿');
    overrides.deadline=null;
  }else{
    assertBeijingIso(overrides.link_released_at);
    const released=Date.parse(overrides.link_released_at);
    assert.ok(Number.isFinite(released),'招募链接首次发布时间无效');
    const deadline=new Date(released+168*60*60*1000+8*60*60*1000).toISOString().slice(0,19)+'+08:00';
    assert.ok(overrides.deadline==null||overrides.deadline===deadline,'截止时间必须为招募链接首次发布时间后 168 小时');
    overrides.deadline=deadline;
  }
  const courses = applyOverrides(cache, overrides);
  const common = roleTemplates.common;
  const tasks = [];
  for (const course of courses) {
    assert.ok(Number.isInteger(course.group_count) && course.group_count > 0, `群数必须为正整数：${course.name}`);
    for (const role of ['运营助教', '专业助教']) {
      const template = roleTemplates.roles[role];
      assert.ok(template, `缺少角色模板：${role}`);
      const body = {
        title: `${course.name} - ${role}`,
        subtitle: course.name,
        description: normalizeText(template.description),
        requirement: buildRequirement(course,role,roleTemplates),
        assistant_identity: role,
        task_type: common.task_type,
        difficulty: common.difficulty,
        base_points: template.base_points,
        capacity: course.group_count * template.capacity_multiplier,
        claim_mode: common.claim_mode,
        deadline: overrides.deadline,
        submit_types: null,
        post_submit_content: postSubmitContent(overrides,role),
        post_submit_image_url: null,
        domain: common.domain,
        work_type: common.work_type,
        preview_image_url: null,
        contact_qr_image_url: overrides.qr_image,
        form_fields: common.form_fields.map(field => ({...field})),
        status: 'draft'
      };
      enforceDraftOnly('POST', `/api/v1/admin/projects/${overrides.target_project_id}/tasks`, body);
      tasks.push({
        business_key: `${overrides.target_project_id}:${course.course_key}:${template.template_id}`,
        course_key: course.course_key,
        role,
        role_template_id: template.template_id,
        source_document_id: cache.source.document_id,
        source_revision_id: course.source_revision_id ?? cache.source.revision_id,
        config: body
      });
    }
  }
  const project = enforceDraftOnly('PUT', `/api/v1/admin/projects/${overrides.target_project_id}`, {
    name: overrides.project_name,
    assistant_period: String(overrides.period),
    assistant_category: 'team_learning',
    certificate_scene: overrides.certificate_scene,
    certificate_template_ids: overrides.certificate_template_ids,
    contact_qr_image_url: overrides.qr_image,
    status: 'draft'
  });
  const pending=[];if(overrides.deadline==null)pending.push('招募截止时间');
  for(const role of ['运营助教','专业助教'])if(postSubmitContent(overrides,role)==null)pending.push(role+'报名成功提示语');
  for(const c of courses){
    for(const key of ['description','audience','source_url','start_time','end_time'])if(!normalizeText(c[key]??''))pending.push(`${c.name}：${key}`);
    if(c.task_count_status!=='已确认')pending.push(`${c.name}：Task数量状态`);
  }
  return {project,courses,tasks,overrides,pending,tasks_only:overrides.tasks_only!==false};
}

export function audit(configs, roleTemplates, overrides) {
  overrides=configs.overrides||overrides;
  const {courses, tasks} = configs;
  const groups = courses.reduce((sum, course) => sum + course.group_count, 0);
  const titles = tasks.map(task => task.config.title);
  const keys = tasks.map(task => task.business_key);
  const round1Errors = [];
  if (tasks.length !== courses.length * 2) round1Errors.push('任务数不等于课程数×2');
  if (new Set(titles).size !== tasks.length) round1Errors.push('任务标题不唯一');
  if (new Set(keys).size !== tasks.length) round1Errors.push('业务键不唯一');
  const capacity = role => tasks.filter(task => task.role === role).reduce((sum, task) => sum + task.config.capacity, 0);
  if (capacity('运营助教') !== groups) round1Errors.push('运营助教总名额错误');
  if (capacity('专业助教') !== groups * 2) round1Errors.push('专业助教总名额错误');
  for (const task of tasks) {
    const c = task.config;
    if (c.status !== 'draft') round1Errors.push(`${c.title} 不是草稿`);
    if (c.requirement.length > 600) round1Errors.push(`${c.title} 课程要求超过600字`);
    if (!overrides.allow_incomplete && ['【任务要求】','规范要求】','【课程说明】','【本期学习规划】','【课程内容地址】'].some(label=>!c.requirement.includes(label))) round1Errors.push(`${c.title} 缺少课程或岗位要求`);
    if (c.form_fields.length !== 4 || c.form_fields.some(field => !field.is_required)) round1Errors.push(`${c.title} 表单异常`);
  }

  const round2Errors = [];
  for (const task of tasks) {
    const c = task.config;
    const expected = normalizeText(roleTemplates.roles[task.role].description);
    if (c.description !== expected) round2Errors.push(`${c.title} 角色模板被改写`);
    if (task.role === '运营助教' && c.description.includes('评选优秀笔记和优秀学习者')) round2Errors.push(`${c.title} 混入专业助教职责`);
    if (task.role === '专业助教' && c.description.includes('规划好每天要做什么')) round2Errors.push(`${c.title} 混入运营助教职责`);
    try { enforceDraftOnly('POST', `/api/v1/admin/projects/${overrides.target_project_id}/tasks`, c); }
    catch (error) { round2Errors.push(`${c.title} 草稿字段不合规：${error.message}`); }
    if (c.post_submit_image_url !== null || c.contact_qr_image_url !== overrides.qr_image) round2Errors.push(`${c.title} 图片配置异常`);
    if (c.post_submit_content !== postSubmitContent(overrides,task.role)) round2Errors.push(`${c.title} 报名成功提示语错误`);
    if (!task.source_document_id || !Number.isInteger(task.source_revision_id)) round2Errors.push(`${c.title} 缺少课程来源`);
  }
  return {
    round1: {passed: round1Errors.length === 0, errors: round1Errors},
    round2: {passed: round2Errors.length === 0, errors: round2Errors},
    summary: {
      course_count: courses.length,
      group_count: groups,
      task_count: tasks.length,
      operations_capacity: capacity('运营助教'),
      professional_capacity: capacity('专业助教'),
      total_capacity: capacity('运营助教') + capacity('专业助教'),
      status: 'draft',pending:configs.pending||[],tasks_only:configs.tasks_only
    }
  };
}

function previewMarkdown(configs, result) {
  const rows = configs.courses.map(course => `| ${course.name} | ${course.group_count} | ${course.group_count} | ${course.group_count * 2} |`).join('\n');
  const s = result.summary;
  return `# V5.1 草稿配置预览\n\n| 课程 | 群数 | 运营名额 | 专业名额 |\n|---|---:|---:|---:|\n${rows}\n| **合计** | **${s.group_count}** | **${s.operations_capacity}** | **${s.professional_capacity}** |\n\n- 任务数：${s.task_count}\n- 总名额：${s.total_capacity}\n- 状态：draft\n- 发布：未执行\n- 第一轮审查：${result.round1.passed ? '通过' : '失败'}\n- 第二轮审查：${result.round2.passed ? '通过' : '失败'}\n`;
}

export function runBuild(options) {
  for (const key of ['roles', 'courses', 'overrides', 'out']) assert.ok(options[key], `缺少 --${key}`);
  const out = path.resolve(options.out);
  assert.ok(!fs.existsSync(out), `输出目录已存在，拒绝覆盖：${out}`);
  const roleTemplates = readJson(options.roles);
  const cache = recruitmentCourseInput(readJson(options.courses));
  const overrides = readJson(options.overrides);
  const previous=options.previous?readJson(options.previous):undefined;
  const configs = buildConfigs({roleTemplates, cache, overrides,previous});
  const result = audit(configs, roleTemplates, overrides);
  assert.ok(result.round1.passed && result.round2.passed, JSON.stringify(result));
  fs.mkdirSync(out, {recursive: true});
  writeJson(out, '助教课程事实.json', cache);
  writeJson(out, 'project_config.json', configs.project);
  writeJson(out, 'task_configs.json', {source: cache.source, tasks: configs.tasks});
  writeJson(out, 'audit_round1.json', result.round1);
  writeJson(out, 'audit_round2.json', result.round2);
  writeJson(out, 'summary.json', result.summary);
  writeJson(out,'草稿执行选项.json',{tasks_only:configs.tasks_only,pending:configs.pending,previous_project_id:previous?.project.id??null});
  writeJson(out,'已解析招募配置.json',configs.overrides);
  if(previous)writeJson(out,'上期来源.json',previous);
  fs.writeFileSync(path.join(out, 'preview.md'), previewMarkdown(configs, result)+`\n- 执行模式：${configs.tasks_only?'仅创建任务':'更新项目并创建任务'}\n- 待补：${configs.pending.join('；')||'无'}\n`);
  return result.summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = argsOf(process.argv);
  assert.equal(options.command, 'build', '用法：node scripts/workflow_v5_1.mjs build --roles <json> --courses <json> --overrides <json> --out <new-dir>');
  console.log(JSON.stringify(runBuild(options)));
}

