import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const moduleUrl = new URL('../runtime/shared/course-info.mjs', import.meta.url);
const modulePath = fileURLToPath(moduleUrl);
async function api() {
  try { return await import(moduleUrl.href); }
  catch (error) { assert.fail(`课程信息接口尚未实现：${error.message}`); }
}
const fixture = () => ({
  schema_version: 1, period: '2099-01', period_number: 1,
  source: {document_id: 'SAMPLE-DOC', revision_id: 1, sample_only: true},
  courses: [{
    course_key: 'course-a', name: '课程A', checkin_name: '课程A', group_count: 1,
    task_ids: ['task0', 'task1', 'task2'], description: '模拟课程说明', audience: '模拟学习者',
    content_url: 'https://example.com/course-a', start_time: '2099-01-01T09:00:00+08:00',
    end_time: '2099-01-10T20:00:00+08:00', last_task_deadline: '2099-01-10', course_code: 'A',
    confirmation: {group_count: '已确认', tasks: '已确认'},
    evidence: {tasks: '课程规划标准.md：课程A任务表', group_count: '课程规划标准.md：汇总表第1行'}
  }]
});

test('负责人明确只需task3时不补造task1和task2', async () => {
  const raw = fixture(); Object.assign(raw.courses[0], {task_ids:['task3'], required_task_ids:['task3']});
  const out = (await api()).buildCourseOutputs(raw);
  assert.deepEqual(out.learner.rules[0]?.task_ids, ['task3']);
  assert.equal(out.course_info.courses[0].confirmation.tasks, '已确认');
});

test('人工名单课程跳过打卡规则但保留制证参数和结营日期', async () => {
  const raw = fixture(); Object.assign(raw.courses[0], {graduation_mode:'manual_roster', task_ids:[], certificate_date:'2099-01-30', last_task_deadline:null});
  const out = (await api()).buildCourseOutputs(raw);
  assert.equal(out.learner.rules.length, 0);
  assert.equal(out.learner.course_parameters[0].graduation_mode, 'manual_roster');
  assert.equal(out.learner.course_parameters[0].certificate_date, '2099-01-30');
  assert.ok(!out.learner.pending.some(p=>p.field==='task_ids'||p.field==='last_task_deadline'));
});

// Catches publishing qualification for a numbered Task gap.
test('Task1和Task3的缺口进入待确认，不能生成资格规则', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].task_ids = ['task1', 'task3'];
  const out = buildCourseOutputs(raw);
  assert.deepEqual(out.course_info.courses[0].task_ids, ['task1', 'task3']);
  assert.deepEqual(out.course_info.courses[0].required_task_ids, ['task1', 'task2', 'task3']);
  assert.equal(out.course_info.courses[0].task_count, 2);
  assert.equal(out.course_info.courses[0].confirmation.tasks, '待确认');
  assert.deepEqual(out.learner.rules, []);
  assert.ok(out.learner.pending.some(item => item.field === 'task_ids' && item.missing_task_ids?.includes('task2')));
});

// Catches guessing task1/task2 from a count-only statement.
test('只有任务次数2时保留待确认，不推断编号', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); delete raw.courses[0].task_ids; raw.courses[0].task_count = 2;
  const out = buildCourseOutputs(raw);
  assert.deepEqual(out.course_info.courses[0].task_ids, []);
  assert.equal(out.course_info.courses[0].task_count, null);
  assert.deepEqual(out.learner.rules, []);
  assert.ok(out.learner.pending.some(item => item.field === 'task_ids' && item.reason.includes('次数')));
});

// Catches silently discarding unknown identifiers before approving tasks.
test('未知Task编号保留并阻止资格出口', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].task_ids = ['Task1', 'taskX'];
  const out = buildCourseOutputs(raw);
  assert.deepEqual(out.course_info.courses[0].task_ids, ['task1', 'taskX']);
  assert.equal(out.course_info.courses[0].task_count, null);
  assert.deepEqual(out.learner.rules, []);
  assert.ok(out.learner.pending.some(item => item.unknown_task_ids?.includes('taskX')));
});

// Catches coupling certificate dates to independently confirmed Task eligibility.
test('缺结束时间和截止日只增加阶段待补，已确认Task仍可判资格', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].end_time = null; delete raw.courses[0].last_task_deadline;
  const out = buildCourseOutputs(raw);
  assert.deepEqual(out.learner.rules, [{course: '课程A', task_ids: ['task1', 'task2'], eligibility: 'all_required_tasks', role: '结课证书'}]);
  assert.equal(out.course_info.courses[0].confirmation.tasks, '已确认');
  assert.ok(out.learner.pending.some(item => item.field === 'end_time' && item.stage === '招募'));
  assert.ok(out.learner.pending.some(item => item.field === 'end_time' && item.stage === '制证'));
  assert.ok(out.learner.pending.some(item => item.field === 'last_task_deadline' && item.stage === '制证'));
  assert.equal(out.learner.course_parameters[0].end_time, null);
});

// Catches divergent source, period, count, or course mappings between consumers.
test('助教与学习者出口使用同一份已核对课程事实，Task0排除', async () => {
  const {buildCourseOutputs} = await api();
  const out = buildCourseOutputs(fixture());
  assert.deepEqual(out.assistant.source, {period: '1', document_id: 'SAMPLE-DOC', revision_id: 1});
  assert.deepEqual(out.assistant.courses, [{
    course_key: 'course-a', name: '课程A', group_count: 1, description: '模拟课程说明',
    audience: '模拟学习者', source_url: 'https://example.com/course-a',
    start_time: '2099-01-01T09:00:00+08:00', end_time: '2099-01-10T20:00:00+08:00',
    task_count: 2, task_count_status: '已确认', source_revision_id: 1
  }]);
  assert.equal(out.learner.period, '2099-01');
  assert.equal(out.learner.period_number, 1);
  assert.deepEqual(out.learner.source, {document_id: 'SAMPLE-DOC', revision_id: 1, sample_only: true});
  assert.deepEqual(out.learner.rules[0].task_ids, ['task1', 'task2']);
  assert.equal(out.learner.course_parameters[0].course, '课程A');
  assert.equal(out.learner.course_parameters[0].planning_name, '课程A');
  assert.equal(out.learner.course_parameters[0].source_revision_id, 1);
  assert.deepEqual(out.learner.pending, []);
});

// Catches alias guessing or losing the original name after trim normalization.
test('名称只trim，审计保留原值并且不修改输入', async () => {
  const {normalizeCourseInfo} = await api();
  const raw = fixture(); raw.courses[0].name = ' 课程 A '; raw.courses[0].checkin_name = ' 课程A（群） ';
  const copy = structuredClone(raw);
  const out = normalizeCourseInfo(raw);
  assert.equal(out.courses[0].name, '课程 A');
  assert.equal(out.courses[0].checkin_name, '课程A（群）');
  assert.ok(out.audit.some(item => item.field === 'courses[0].name' && item.before === ' 课程 A ' && item.after === '课程 A'));
  assert.deepEqual(raw, copy);
});

// Catches publishing duplicate stable keys or many-to-one check-in mappings.
test('重复课程稳定键和打卡映射均拒绝', async () => {
  const {normalizeCourseInfo} = await api();
  const first = fixture(); first.courses.push({...structuredClone(first.courses[0]), name: '课程B', checkin_name: '课程B'});
  assert.throws(() => normalizeCourseInfo(first), /course_key.*重复/);
  const second = fixture(); second.courses.push({...structuredClone(second.courses[0]), course_key: 'course-b', name: '课程B'});
  assert.throws(() => normalizeCourseInfo(second), /checkin_name.*重复/);
});

// Catches recruitment capacity generation from unconfirmed group counts.
test('群数未确认时助教出口为空，任务资格仍可单独使用', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].confirmation.group_count = '待确认';
  const out = buildCourseOutputs(raw);
  assert.deepEqual(out.assistant.courses, []);
  assert.equal(out.learner.rules.length, 1);
  assert.ok(out.learner.pending.some(item => item.field === 'group_count' && item.stage === '招募'));
});

// Catches replacing source conflicts with a weaker status.
test('明确冲突的Task状态保留有冲突', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].confirmation.tasks = '有冲突';
  const out = buildCourseOutputs(raw);
  assert.equal(out.course_info.courses[0].confirmation.tasks, '有冲突');
  assert.deepEqual(out.learner.rules, []);
});

// Catches allowing malformed top-level identity and source contracts.
test('统一schema、营期、期数、来源版本与课程身份需有效', async () => {
  const {normalizeCourseInfo} = await api();
  for (const mutate of [
    raw => {raw.schema_version = 2;}, raw => {raw.period = '2099-13';},
    raw => {raw.period_number = 0;}, raw => {raw.source.revision_id = 0;},
    raw => {raw.source.document_id = ' ';}, raw => {raw.courses = [];},
    raw => {raw.courses[0].checkin_name = '';}, raw => {raw.courses[0].group_count = 1.5;}
  ]) {
    const raw = fixture(); mutate(raw); assert.throws(() => normalizeCourseInfo(raw));
  }
});

// Catches accepting impossible dates as confirmed scheduling facts.
test('日期格式或日期值错误进入待补但不阻断已确认任务', async () => {
  const {buildCourseOutputs} = await api();
  const raw = fixture(); raw.courses[0].last_task_deadline = '2099-02-30';
  raw.courses[0].start_time = '2099-01-01';
  const out = buildCourseOutputs(raw);
  assert.equal(out.learner.rules.length, 1);
  assert.ok(out.learner.pending.some(item => item.field === 'last_task_deadline' && item.reason.includes('无效')));
  assert.ok(out.learner.pending.some(item => item.field === 'start_time' && item.reason.includes('时区')));
});

// Catches CLI stubs, missing output files, or overwriting a previous snapshot.
test('CLI产四份JSON并拒绝覆盖旧目录', async () => {
  const {buildCourseOutputs} = await api();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'course-info-test-'));
  try {
    const input = path.join(sandbox, 'input.json'); const output = path.join(sandbox, 'output');
    fs.writeFileSync(input, JSON.stringify(fixture()));
    const first = spawnSync(process.execPath, [modulePath, input, output], {encoding: 'utf8'});
    assert.equal(first.status, 0, first.stderr);
    const files = fs.readdirSync(output).sort();
    assert.deepEqual(files, ['助教课程事实.json', '学习者证书规则.json', '待补清单.json', '课程信息.json'].sort());
    const ruleFile = path.join(output, '学习者证书规则.json');
    const before = fs.readFileSync(ruleFile, 'utf8');
    assert.deepEqual(JSON.parse(before), buildCourseOutputs(fixture()).learner);
    const second = spawnSync(process.execPath, [modulePath, input, output], {encoding: 'utf8'});
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /输出目录已存在/);
    assert.equal(fs.readFileSync(ruleFile, 'utf8'), before);
  } finally { fs.rmSync(sandbox, {recursive: true, force: true}); }
});
