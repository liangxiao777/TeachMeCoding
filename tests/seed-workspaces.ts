import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDatabase } from '../apps/server/src/storage/database.js';
import { Learning } from '../apps/server/src/modules/learning.js';
import { Projects } from '../apps/server/src/modules/projects.js';

// Test-only fixture writer. This module is never imported by either application.
export function seedWorkspaces(root: string) {
  const db = openDatabase(join(root, 'app.db')); const learning = new Learning(db);
  try {
    const space = learning.create({ name: '存储验收 Rust', goal: '写一个自己的命令行工具' });
    learning.saveRequirement(space.id, { ...space.requirement, confirmed: true });
    const units = ['所有权与借用', '错误处理'].map((title) => ({ id: randomUUID(), title, summary: '持久化验收材料，不来自模型', goals: ['保存学习记录'] }));
    const content = { note: '验收数据：两个独立单元。', stages: [{ id: randomUUID(), title: '语言基础', units }] };
    const route = space.sessions.find((s) => s.scope === 'route')!.id;
    learning.applyProposal(space.id, learning.proposeRoute(space.id, route, content).id);
    const proposal = learning.proposeRoute(space.id, route, { ...content, note: '用户确认后的路线说明' });
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
    return { root, spaceId: space.id, unitIds: units.map((u) => u.id), otherId: other.id, recordId: record.id, proposalId: proposal.id };
  } finally { db.close(); }
}
