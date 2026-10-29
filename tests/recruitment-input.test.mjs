import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runBuild} from '../runtime/assistant/scripts/招募草稿.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function setup(t, mutate = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-learning-input-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const input = read(path.join(root, 'skills/team-learning-recruitment/Sample/课程信息.json'));
  mutate(input);
  const courses = path.join(directory, '课程信息.json');
  write(courses, input);
  const overrides = path.join(directory, '招募配置.json');
  const settings = read(path.join(root, 'skills/team-learning-recruitment/Sample/贡献者招募项目.json'));
  settings.period = String(input.period_number);
  write(overrides, settings);
  return {directory, input, options: {roles: path.join(root, 'runtime/assistant/assets/岗位模板.json'), courses, overrides, out: path.join(directory, 'draft')}};
}

test('招募草稿直接读取上一步的课程信息JSON并保留来源与名额', t => {
  const {options} = setup(t);
  const result = runBuild(options);
  assert.equal(result.course_count, 1);
  assert.equal(result.operations_capacity, 1);
  assert.equal(result.professional_capacity, 2);
  const tasks = read(path.join(options.out, 'task_configs.json'));
  assert.equal(tasks.source.period, '1');
  assert.equal(tasks.source.document_id, 'SAMPLE-DOC');
  assert.equal(tasks.source.revision_id, 1);
  assert.equal(tasks.tasks.length, 2);
  assert.match(tasks.tasks[0].config.requirement, /https:\/\/example.com\/course-a/);
  assert.match(tasks.tasks[0].config.requirement, /Task 数：2/);
});

test('有课程群数待确认时列明课程，不静默删课生成剩余草稿', t => {
  const {options} = setup(t, raw => {
    const second = {...structuredClone(raw.courses[0]), course_key: 'course-b', name: '课程B', checkin_name: '课程B'};
    second.confirmation.group_count = '待确认';
    raw.courses.push(second);
  });
  assert.throws(() => runBuild(options), /课程B.*群数.*未确认/);
  assert.equal(fs.existsSync(options.out), false);
});

test('部分字段待补仍可直接生成允许的不完整草稿，不把全部核准作为输入前提', t => {
  const {options} = setup(t, raw => {
    raw.courses[0].description = null;
    raw.courses[0].task_ids = [];
    raw.courses[0].confirmation.tasks = '待确认';
  });
  const result = runBuild(options);
  assert.equal(result.course_count, 1);
  assert.ok(result.pending.includes('课程A：description'));
  assert.ok(result.pending.includes('课程A：Task数量状态'));
  const task = read(path.join(options.out, 'task_configs.json')).tasks[0];
  assert.doesNotMatch(task.config.requirement, /Task 数：/);
});

test('统一招募入口接收课程信息JSON配置并生成浏览器稿', t => {
  const {directory, input, options} = setup(t);
  const config = path.join(directory, '配置.json');
  write(config, {sample_only: true, period: input.period, recruitment: {courses_file: options.courses, overrides_file: options.overrides}});
  const result = spawnSync(process.execPath, [path.join(root, 'runtime/assistant/scripts/助教评价入口.mjs'), 'recruit-preview', '--config', config, '--out', options.out], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).course_count, 1);
  const browser = fs.readFileSync(path.join(options.out, '浏览器进度与满额导出.js'), 'utf8');
  assert.match(browser, /"period":"1"/);
  assert.match(browser, /"sample_only":true/);
});

test('进度入口使用同一课程信息JSON并保留课程输入的模拟标记', t => {
  const {directory, options} = setup(t);
  const snapshot = read(path.join(root, 'skills/team-learning-recruitment/Sample/项目任务JSON.json'));
  snapshot.sample_only = false;
  const snapshotFile = path.join(directory, '任务.json');
  write(snapshotFile, snapshot);
  const out = path.join(directory, 'progress');
  const result = spawnSync(process.execPath, [path.join(root, 'runtime/assistant/scripts/招募进度.mjs'), snapshotFile, options.courses, out], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const report = read(path.join(out, '招募进度.json'));
  assert.equal(report.sample_only, true);
  assert.equal(report.summary.courses, 1);
  assert.equal(report.summary.expected_slots, 3);
});

test('已有内部助教课程事实格式仍可读取', t => {
  const {options} = setup(t);
  options.courses = path.join(root, 'skills/team-learning-recruitment/Sample/助教课程事实.json');
  assert.equal(runBuild(options).total_capacity, 3);
});
