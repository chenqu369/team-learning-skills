import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const STATUSES = new Set(['已确认', '待确认', '有冲突']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

/** Validate a manually prepared current-period JSON; never infer unlisted source facts. */
export function normalizeCourseInfo(raw) {
  if (!object(raw) || raw.schema_version !== 1) throw Error('schema_version 必须为 1');
  const audit = [];
  function text(value, field, required = false) {
    if (value == null) {
      if (required) throw Error(`${field} 必须为非空字符串`);
      return null;
    }
    if (typeof value !== 'string') throw Error(`${field} 必须为字符串或 null`);
    const normalized = value.trim() || null;
    if (normalized !== value) audit.push({field, action: 'trim', before: value, after: normalized});
    if (required && !normalized) throw Error(`${field} 必须为非空字符串`);
    return normalized;
  }
  const period = text(raw.period, 'period', true);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw Error('period 必须为 YYYY-MM');
  if (!Number.isSafeInteger(raw.period_number) || raw.period_number < 1) throw Error('period_number 必须为正整数');
  if (!object(raw.source)) throw Error('source 必须为对象');
  const source = structuredClone(raw.source);
  source.document_id = text(source.document_id, 'source.document_id', true);
  if (!Number.isSafeInteger(source.revision_id) || source.revision_id < 1) throw Error('source.revision_id 必须为正整数');
  if (!Array.isArray(raw.courses) || !raw.courses.length) throw Error('courses 必须为非空数组');
  const pending = [], keys = new Set(), checkinNames = new Set();
  const courses = raw.courses.map((input, index) => {
    if (!object(input)) throw Error(`courses[${index}] 必须为对象`);
    const prefix = `courses[${index}]`;
    const course = {};
    for (const field of ['course_key', 'name', 'checkin_name']) course[field] = text(input[field], `${prefix}.${field}`, true);
    if (keys.has(course.course_key)) throw Error(`course_key 重复：${course.course_key}`);
    if (checkinNames.has(course.checkin_name)) throw Error(`checkin_name 映射重复：${course.checkin_name}`);
    keys.add(course.course_key); checkinNames.add(course.checkin_name);
    course.graduation_mode = input.graduation_mode ?? 'feishu_tasks';
    if (!['feishu_tasks', 'manual_roster'].includes(course.graduation_mode)) throw Error(`${prefix}.graduation_mode 无效`);
    const manual = course.graduation_mode === 'manual_roster';
    function wait(field, stage, reason, details = {}) {
      pending.push({course_key: course.course_key, course: course.name, field, stage, reason, ...details});
    }
    if (input.confirmation != null && !object(input.confirmation)) throw Error(`${prefix}.confirmation 必须为对象`);
    const confirmation = {};
    for (const field of ['group_count', 'tasks']) {
      const status = input.confirmation?.[field] ?? '待确认';
      if (!STATUSES.has(status)) throw Error(`${prefix}.confirmation.${field} 状态无效`);
      confirmation[field] = status;
    }
    const groups = input.group_count ?? null;
    if (groups !== null && (!Number.isSafeInteger(groups) || groups < 1)) throw Error(`${prefix}.group_count 必须为正整数或 null`);
    course.group_count = groups;
    if (groups === null && confirmation.group_count === '已确认') confirmation.group_count = '待确认';
    if (groups === null || confirmation.group_count !== '已确认') wait('group_count', '招募', groups === null ? '群数缺失；不能生成助教名额' : `群数${confirmation.group_count}；不能生成助教名额`);

    const givenIds = input.task_ids ?? [];
    if (!Array.isArray(givenIds) || givenIds.some(id => typeof id !== 'string')) throw Error(`${prefix}.task_ids 必须为字符串数组或 null`);
    const known = new Set(), unknown = [], ids = [];
    for (let offset = 0; offset < givenIds.length; offset++) {
      const original = givenIds[offset], value = original.trim();
      const match = /^task\s*(\d+)$/i.exec(value);
      const number = match ? Number(match[1]) : NaN;
      const id = Number.isSafeInteger(number) && number >= 0 ? `task${number}` : value;
      if (original !== id) audit.push({field: `${prefix}.task_ids[${offset}]`, action: 'normalize_task_id', before: original, after: id});
      if (Number.isSafeInteger(number) && number >= 0) known.add(number);
      else if (!unknown.includes(id)) unknown.push(id);
    }
    ids.push(...[...known].sort((a, b) => a - b).map(number => `task${number}`), ...unknown);
    course.task_ids = ids;
    const numbered = [...known].filter(number => number > 0).sort((a, b) => a - b);
    course.task_count = unknown.length || !numbered.length ? null : numbered.length;
    const maximum = numbered.at(-1) ?? 0;
    course.required_task_ids = Array.from({length: maximum}, (_, position) => `task${position + 1}`);
    if (Object.hasOwn(input, 'required_task_ids')) {
      if (!Array.isArray(input.required_task_ids) || (!manual && !input.required_task_ids.length) || input.required_task_ids.some(id => !/^task[1-9]\d*$/.test(id) || !ids.includes(id)) || new Set(input.required_task_ids).size !== input.required_task_ids.length) throw Error(`${prefix}.required_task_ids 必须为已列出的明确必需Task`);
      course.required_task_ids = [...input.required_task_ids];
    }
    if (manual) course.required_task_ids = [];
    const missing = course.required_task_ids.filter(id => !known.has(Number(id.slice(4))));
    if (!numbered.length) wait('task_ids', '制证', input.task_count != null ? '仅提供任务次数，没有明确编号；不能由次数推断 Task' : '未列出 Task1 起的明确编号；Task0 不计入必做任务');
    if (missing.length) wait('task_ids', '制证', `编号不连续，缺少 ${missing.join('、')}；不能补造任务后放行`, {missing_task_ids: missing});
    if (unknown.length) wait('task_ids', '制证', '存在无法识别的 Task 编号；保留原值，等待核对', {unknown_task_ids: unknown});
    if (input.task_count != null) audit.push({field: `${prefix}.task_count`, action: 'derive_from_task_ids', before: input.task_count, after: course.task_count});
    if ((!numbered.length || missing.length || unknown.length) && confirmation.tasks !== '有冲突') confirmation.tasks = '待确认';
    if (confirmation.tasks !== '已确认' && numbered.length && !missing.length && !unknown.length) wait('task_ids', '制证', `Task 编号规则${confirmation.tasks}；不能输出资格规则`);

    for (const field of ['description', 'audience', 'content_url', 'start_time', 'end_time', 'last_task_deadline', 'course_code', 'start_date', 'end_date', 'certificate_date']) course[field] = text(input[field], `${prefix}.${field}`);
    for (const field of ['start_date','end_date','certificate_date']) if (course[field] !== null && !validDate(course[field])) throw Error(`${prefix}.${field} 日期无效`);
    if (course.start_date && course.end_date && course.start_date > course.end_date) throw Error(`${prefix} 起止日期倒置`);
    for (const field of ['description', 'audience', 'content_url', 'start_time', 'end_time']) {
      if (course[field] === null) wait(field, '招募', '当期规划未提供，待确认');
    }
    for (const field of ['end_time', 'last_task_deadline', 'course_code']) {
      if (course[field] === null) wait(field, '制证', '正式制证所需当期信息缺失，待确认');
    }
    for (const field of ['start_time', 'end_time']) {
      if (course[field] !== null && !validTime(course[field])) {
        wait(field, '招募', '时间无效；须提供完整日期、时间和时区');
        if (field === 'end_time') wait(field, '制证', '结束时间无效；不能据此确定正式证书日期');
      }
    }
    if (course.last_task_deadline !== null && !validDate(course.last_task_deadline)) wait('last_task_deadline', '制证', '截止日期无效；须为真实的 YYYY-MM-DD 日期');
    if (course.content_url !== null) {
      try {
        const url = new URL(course.content_url);
        if (!['https:', 'http:'].includes(url.protocol)) throw Error();
      } catch { wait('content_url', '招募', '课程内容地址无效；须核对原始链接'); }
    }
    if (input.evidence != null && !object(input.evidence)) throw Error(`${prefix}.evidence 必须为对象`);
    course.evidence = structuredClone(input.evidence ?? {});
    if (!Object.keys(course.evidence).length) {
      wait('evidence', '招募', '未记录课程字段的来源位置，待补证据');
      wait('evidence', '制证', '未记录任务和日期的来源位置，待补证据');
    }
    course.confirmation = confirmation;
    if (input.optional_requirements != null) course.optional_requirements = structuredClone(input.optional_requirements);
    // Preserve the calendar projection in canonical course output; it does not add required tasks.
    if (input.calendar_short_name != null) course.calendar_short_name = text(input.calendar_short_name, `${prefix}.calendar_short_name`);
    if (input.calendar_nodes != null) {
      if (!Array.isArray(input.calendar_nodes) || input.calendar_nodes.some(node => !object(node))) throw Error(`${prefix}.calendar_nodes 必须为对象数组`);
      course.calendar_nodes = structuredClone(input.calendar_nodes);
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]; if (p.course_key !== course.course_key) continue;
      if ((manual && ['task_ids','last_task_deadline'].includes(p.field)) ||
          (p.field === 'start_time' && course.start_date) || (p.field === 'end_time' && course.end_date) ||
          (p.field === 'last_task_deadline' && course.certificate_date)) pending.splice(i, 1);
    }
    if (manual && !course.certificate_date) wait('certificate_date', '制证', '人工名单课程的证书日期待确认；不得借用其他课程日期');
    return course;
  });
  return {schema_version: 1, period, period_number: raw.period_number, source, courses, pending, audit};
}

/** Build the recruitment and learner consumers from the same normalized facts. */
export function buildCourseOutputs(raw) {
  const courseInfo = normalizeCourseInfo(raw);
  const assistant = {source: {
    period: String(courseInfo.period_number), document_id: courseInfo.source.document_id, revision_id: courseInfo.source.revision_id
  }, courses: []};
  const learner = {
    period: courseInfo.period, period_number: courseInfo.period_number, rules: [], course_parameters: [],
    pending: structuredClone(courseInfo.pending), source: structuredClone(courseInfo.source)
  };
  for (const course of courseInfo.courses) {
    if (course.confirmation.group_count === '已确认') assistant.courses.push({
      course_key: course.course_key, name: course.name, group_count: course.group_count,
      description: course.description, audience: course.audience, source_url: course.content_url,
      start_time: course.start_time, end_time: course.end_time,
      task_count: course.task_count, task_count_status: course.confirmation.tasks,
      source_revision_id: courseInfo.source.revision_id
    });
    learner.course_parameters.push({
      course_key: course.course_key, course: course.checkin_name, planning_name: course.name,
      tasks: [...course.task_ids], required_task_ids: [...course.required_task_ids], task_count: course.task_count,
      task_count_status: course.confirmation.tasks, group_count: course.group_count,
      start_time: course.start_time, end_time: course.end_time,
      last_task_deadline: course.last_task_deadline, course_code: course.course_code,
      graduation_mode: course.graduation_mode, certificate_date: course.certificate_date,
      start_date: course.start_date, end_date: course.end_date,
      source_revision_id: courseInfo.source.revision_id, evidence: structuredClone(course.evidence)
    });
    if (course.graduation_mode === 'feishu_tasks' && course.confirmation.tasks === '已确认') learner.rules.push({
      course: course.checkin_name, task_ids: [...course.required_task_ids], eligibility: 'all_required_tasks', role: '结课证书'
    });
  }
  return {course_info: courseInfo, assistant, learner};
}

/** Recruitment accepts the previous step's canonical JSON; its projection is internal. */
export function recruitmentCourseInput(raw) {
  if (!object(raw)) throw Error('课程输入必须为 JSON 对象');
  // Keep compatibility with existing internal snapshots, without requiring a new handoff file.
  if (!['schema_version', 'period', 'period_number'].some(key => Object.hasOwn(raw, key))) return structuredClone(raw);
  const outputs = buildCourseOutputs(raw);
  const blocked = outputs.course_info.courses.filter(course => course.confirmation.group_count !== '已确认');
  if (blocked.length) throw Error(`${blocked.map(course => course.name).join('、')}：群数未确认或有冲突；在课程信息.json 中补齐。不能省略这些课程生成招募名额`);
  const result = outputs.assistant;
  if (raw.sample_only || outputs.course_info.source.sample_only) result.sample_only = true;
  return result;
}

function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw Error('用法：node runtime/shared/course-info.mjs <inputJSON> <新outputDirectory>');
  if (Number(process.versions.node.split('.')[0]) < 20) throw Error('需要 Node.js >= 20');
  const directory = path.resolve(output);
  if (fs.existsSync(directory)) throw Error('输出目录已存在，换新目录以保留旧快照');
  const result = buildCourseOutputs(JSON.parse(fs.readFileSync(path.resolve(input), 'utf8').replace(/^\uFEFF/, '')));
  fs.mkdirSync(path.dirname(directory), {recursive: true});
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('输出目录已存在，换新目录以保留旧快照');
    throw error;
  }
  const files = {
    '课程信息.json': result.course_info,
    '助教课程事实.json': result.assistant,
    '学习者证书规则.json': result.learner,
    '待补清单.json': result.course_info.pending
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  console.log(JSON.stringify({output: directory, assistant_courses: result.assistant.courses.length, learner_rules: result.learner.rules.length, pending: result.course_info.pending.length}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
