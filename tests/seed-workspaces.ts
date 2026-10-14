import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/storage/database.js';
import { Learning } from '../apps/server/src/modules/learning.js';
import { Assessments } from '../apps/server/src/modules/assessments.js';
import { Projects } from '../apps/server/src/modules/projects.js';
import { conceptIntake } from '../apps/server/src/agents/test-support.js';

// Test-only fixture writer. This module is never imported by either application.
export function seedWorkspaces(root: string) {
  const db = openDatabase(join(root, 'app.db')); const learning = new Learning(db);
  try {
    const space = learning.create({ name: '存储验收 Rust', goal: '写一个自己的命令行工具' });
    learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: '想完成什么？', answer: '写一个自己的命令行工具' }] }, intake: conceptIntake, confirmed: true });
    const units = ['所有权与借用', '错误处理'].map((title) => ({ id: randomUUID(), title, summary: '持久化验收材料，不来自模型', goals: ['保存学习记录'] }));
    const content = { note: '验收数据：两个独立单元。', stages: [{ id: randomUUID(), title: '语言基础', units }] };
    const route = space.sessions.find((s) => s.scope === 'route')!.id;
    learning.applyProposal(space.id, learning.proposeRoute(space.id, route, content).id);
    for (const unit of units) {
      learning.createSession(space.id, { scope: 'unit', unitId: unit.id, title: unit.title });
      learning.saveLesson(space.id, unit.id, { title: unit.title, content: `这是 ${unit.title} 的验收课件。\n\n请将问题与代码引用保存在本单元会话中。` });
      learning.saveAssessmentSpec(space.id, unit.id, { q1: '解释这个概念', q2: '写下练习代码', starter: '' });
    }
    learning.saveAssessmentDraft(space.id, units[0]!.id, { revision: 0, q1: '历史解释', q2: '历史代码' });
    const record = learning.saveAssessmentResult(space.id, units[0]!.id, 1, { result: 'needs_work', summary: '验收记录：需要更多证据', mastered: ['基本概念'], concerns: ['补充借用示例'], evidence: ['解释已保存'], toVerify: ['实际运行尚未验证'] });
    const other = learning.create({ name: '另一个 Python 空间', goal: '学习 Python' });
    const projects = new Projects(root);
    projects.create(space.id, { path: 'src', kind: 'directory' });
    projects.create(space.id, { path: 'src/main.rs', kind: 'file' });
    projects.save(space.id, { ...projects.read(space.id, 'src/main.rs'), content: 'fn main() { println!("17"); }\n' });
    return { root, spaceId: space.id, unitIds: units.map((u) => u.id), otherId: other.id, recordId: record.id };
  } finally { db.close(); }
}

// Review has its own space, so its mandatory decision cannot block unrelated
// persistence, layout or editor tests that share the normal Rust fixture.
export function seedRouteReview(root: string) {
  const db = openDatabase(join(root, 'app.db')), learning = new Learning(db), assessments = new Assessments(learning);
  try {
    const space = learning.create({ name: '学习路线调整验收', goal: '保留学习记录，细化后续路线' });
    learning.saveRequirement(space.id, { ...space.requirement, value: { rows: [{ question: '学习目标', answer: '用 Rust 完成一个可靠的命令行工具' }] }, intake: conceptIntake, confirmed: true });
    const unit = (title: string, summary: string, goals: string[]) => ({ id: randomUUID(), title, summary, goals });
    const learned = [unit('Rust 基础语法', '变量、分支与循环，建立表达程序的基础。', ['解释变量与控制流程']),
      unit('所有权与移动', '理解值的所有者与移动语义。', ['追踪值的所有者'])];
    const project = unit('命令行项目', '完成一个小工具。', ['编写命令行程序']);
    const removed = unit('并发入门', '初步了解线程。', ['创建线程']);
    const before = { note: '先掌握语言基础，再完成一个小项目，最后了解并发。', stages: [
      { id: randomUUID(), title: '语言基础', units: learned },
      { id: randomUUID(), title: '项目与拓展', units: [project, removed] },
    ] };
    const routeSession = space.sessions.find((session) => session.scope === 'route')!.id;
    learning.applyProposal(space.id, learning.proposeRoute(space.id, routeSession, before).id);
    for (const unit of learned) {
      learning.createSession(space.id, { scope: 'unit', unitId: unit.id, title: unit.title });
      learning.saveLesson(space.id, unit.id, { title: unit.title, content: `已保存的课件：${unit.title}。\n\n历史内容保持原样。` });
      assessments.saveSpec(space.id, unit.id, { public: { q1: '解释概念的边界', q2: '比较两个示例', q2Kind: 'reasoning' },
        rubric: { q1: { answer: '具体解释', criteria: ['给出例子'] }, q2: { answer: '解释差异', criteria: ['识别边界'] } } },
      { requirement: learning.space(space.id).requirement.revision, route: 1, lesson: 1 }, 0);
      const fixed = assessments.submit(space.id, unit.id, { kind: 'evaluation', revision: 0, specRevision: 1, q1: '具体解释与例子', q2: '比较并解释边界差异' });
      assessments.grade(space.id, unit.id, fixed, { result: 'pass', summary: '概念解释已核对' });
    }
    const supplements = [unit('借用规则与引用', '补充所有权之后遗漏的借用规则，区分共享引用与可变引用。', ['解释共享与可变借用的边界']),
      unit('生命周期与作用域', '结合已有所有权课件，理解引用有效范围。', ['判断引用能否安全返回'])];
    const after = { note: '保留两个已通过单元，补上借用与生命周期；把项目练习拆细，暂缓并发。', stages: [
      { id: randomUUID(), title: '补充基础', units: supplements },
      { ...before.stages[0]!, units: learned },
      { ...before.stages[1]!, title: '项目实践', units: [{ ...project, title: '单词计数器：输入与错误处理',
        summary: '分步读取文件、统计单词并报告错误，明确每一步的练习与验收边界。', goals: ['读取并统计文件', '处理缺失文件与空输入'] }] },
    ] };
    const proposal = learning.proposeRoute(space.id, routeSession, after);
    return { spaceId: space.id, routeSession, before, after, proposalId: proposal.id, learnedIds: learned.map((unit) => unit.id), removedId: removed.id };
  } finally { db.close(); }
}
