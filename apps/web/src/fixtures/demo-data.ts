import type { CodeFile, Requirement, Session, Space, Stage, Unit } from './types'

let counter = 0
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`

const unit = (id: string, title: string, summary: string, goals: string[], lessonKey = id): Unit => ({
  id,
  title,
  summary,
  goals,
  status: 'not_started',
  contentState: 'none',
  lessonKey,
})

export function rustStages(): Stage[] {
  return [
    {
      id: 'st1',
      title: '从 Python 到 Rust',
      units: [
        unit('basics', '基础语法速览', '变量、可变性、类型与控制流，与 Python 逐项对照，快速建立语感。', [
          '理解 let 与 mut 的区别',
          '读懂常见的类型标注',
          '用 if / loop / for 写出简单逻辑',
        ]),
        unit('ownership', '所有权与借用', '理解 Rust 如何在没有垃圾回收的情况下安全地管理内存。', [
          '说清所有权转移（move）发生的时机',
          '区分 clone、不可变借用与可变借用',
          '读懂并修复 E0382 等常见所有权报错',
        ]),
      ],
    },
    {
      id: 'st2',
      title: '组织数据与处理错误',
      units: [
        unit('structs', '结构体与枚举', '用 struct 和 enum 为问题建模，配合 match 处理所有情况。', [
          '定义结构体并为其实现方法',
          '用枚举表达几种互斥的情况',
          '用 match 穷尽处理分支',
        ]),
        unit('errors', '错误处理', '用 Result 与 ? 运算符写出不会意外崩溃的程序。', [
          '区分 panic 与可恢复错误',
          '使用 Result 与 ? 传播错误',
        ]),
      ],
    },
    {
      id: 'st3',
      title: '动手做项目',
      units: [
        unit('cli', '命令行项目：minigrep', '综合所学，完成一个能在文件中搜索文本的命令行工具。', [
          '解析命令行参数',
          '读取文件并处理错误',
          '组织模块并编写测试',
        ]),
      ],
    },
  ]
}

function genericStages(topic: string): Stage[] {
  return [
    {
      id: 'st1',
      title: '打好基础',
      units: [
        unit('g1', `${topic} 核心概念`, `了解 ${topic} 解决什么问题，以及最核心的几个概念。`, ['说清核心概念', '跑通第一个示例']),
        unit('g2', `${topic} 常用操作`, '掌握日常使用中最常见的操作与写法。', ['熟悉常用写法', '能独立查阅文档']),
      ],
    },
    {
      id: 'st2',
      title: '学以致用',
      units: [unit('g3', `${topic} 小项目`, '用一个小项目把前面的内容串起来。', ['独立完成一个小项目'])],
    },
  ]
}

function pytorchStages(): Stage[] {
  const s: Stage[] = [
    {
      id: 'pt1',
      title: '张量与自动求导',
      units: [
        unit('tensors', '张量与基础运算', '创建张量、理解 shape 与 dtype，掌握广播和矩阵乘法。', [
          '按需创建不同形状的张量',
          '判断两个张量能否运算',
        ]),
        unit('autograd', '自动求导 autograd', '理解计算图与 backward，手动实现一次梯度下降。', ['读懂 requires_grad 与 grad']),
      ],
    },
    {
      id: 'pt2',
      title: '训练第一个模型',
      units: [
        unit('nn', '用 nn.Module 构建网络', '定义层、前向传播与参数管理。', ['写出一个两层 MLP']),
        unit('mnist', 'MNIST 训练实战', '完整的训练循环：数据加载、损失、优化器与评估。', ['训练并评估一个分类模型']),
      ],
    },
  ]
  s[0]!.units[0]!.status = 'learning'
  s[0]!.units[0]!.contentState = 'ready'
  return s
}

export const RUST_ROUTE_NOTE =
  '你已有 Python 基础，所以「基础语法」以对照为主，可以快速浏览；所有权是 Rust 与 Python 差异最大的地方，安排了更多动手练习；最后用一个命令行工具把所学串起来，对应你的目标。'

export function emptySpace(): Space {
  return {
    id: uid('space'),
    kind: 'generic',
    name: '新的学习空间',
    topic: '',
    requirement: null,
    onboarding: { messages: [], step: 0, agentTyping: false, summaryReady: false },
    routeNote: '',
    stages: [],
    currentUnitId: null,
    view: 'onboarding',
    sessions: [],
    activeSessionIds: {},
    files: [],
    directories: [],
    expandedDirectoryIds: [],
    selectedEntryId: null,
    openFileIds: [],
    activeFileId: null,
    terminal: [],
    terminalDirectoryId: null,
    running: false,
    env: 'disconnected',
    envLabel: '',
    ideOpen: false,
    ideFullscreen: false,
    explorerOpen: true,
    agentOpen: true,
    draft: null,
    records: [],
    viewingRecordId: null,
    completed: false,
    lastActive: Date.now(),
  }
}

export function stagesFor(kind: Space['kind'], topic: string): Stage[] {
  if (kind === 'rust') return rustStages()
  return genericStages(topic || '新主题')
}

export function newSession(unitId: string | null): Session {
  return {
    id: uid('sess'), unitId, title: '新会话', updatedAt: Date.now(), messages: [],
    composerText: '', composerQuote: null, routeSuggestion: '',
  }
}

export function detectKind(text: string): Space['kind'] {
  if (/rust/i.test(text)) return 'rust'
  return 'generic'
}

export function topicFrom(text: string): string {
  if (/rust/i.test(text)) return 'Rust'
  const m = text.match(/学习?\s*([A-Za-z0-9+#.\u4e00-\u9fa5]{1,12})/)
  return m ? m[1]!.replace(/[，。,.]/g, '') : '新主题'
}

export function initialRequirement(kind: Space['kind'], topic: string, answers: string[]): Requirement {
  const background = answers[1] || '有一定编程基础'
  const scheduleText = answers[2] || ''
  if (kind === 'rust') {
    return {
      goal: '系统学习 Rust，能独立完成一个简单的命令行工具',
      background: /python/i.test(background) ? '熟悉 Python，没有接触过需要手动管理内存的语言' : background,
      outcome: '理解所有权等核心概念，独立写出一个可用的 CLI 工具',
      schedule: /\d/.test(scheduleText) ? scheduleText : '每周约 5 小时',
    }
  }
  return {
    goal: `学习 ${topic}`,
    background,
    outcome: `能用 ${topic} 独立完成一个小项目`,
    schedule: /\d/.test(scheduleText) ? scheduleText : '每周约 5 小时',
  }
}

const now = () => Date.now()

export function rustInProgressSpace(): Space {
  const stages = rustStages()
  stages[0]!.units[0]!.status = 'skipped'
  stages[0]!.units[1]!.status = 'learning'
  stages[0]!.units[1]!.contentState = 'ready'
  const files: CodeFile[] = [
    {
      id: 'f_move',
      name: 'move_demo.rs',
      parentId: 'dir_examples',
      language: 'rust',
      content: `fn main() {
    let s1 = String::from("hello");
    let s2 = s1;

    println!("s2 = {}", s2);
    println!("s1 = {}", s1);
}`,
    },
    { id: 'f_main', name: 'main.rs', parentId: 'dir_src', language: 'rust', content: 'fn main() {\n    println!("Hello, Rust!");\n}\n' },
    { id: 'f_lib', name: 'lib.rs', parentId: 'dir_src', language: 'rust', content: 'pub mod utils;\n' },
    { id: 'f_mod', name: 'mod.rs', parentId: 'dir_utils', language: 'rust', content: 'pub mod parser;\n' },
    { id: 'f_parser', name: 'parser.rs', parentId: 'dir_utils', language: 'rust', content: 'pub fn words(text: &str) -> Vec<&str> {\n    text.split_whitespace().collect()\n}\n' },
    { id: 'f_test_parser', name: 'parser.rs', parentId: 'dir_tests', language: 'rust', content: '#[test]\nfn parses_words() {\n    let words: Vec<_> = "hello rust".split_whitespace().collect();\n    assert_eq!(words.len(), 2);\n}\n' },
    { id: 'f_cargo', name: 'Cargo.toml', parentId: null, language: 'text', content: '[package]\nname = "rust-workspace"\nversion = "0.1.0"\nedition = "2021"\n' },
    { id: 'f_readme', name: 'README.md', parentId: null, language: 'text', content: '# Rust 学习项目\n\n- src/：项目代码\n- examples/：课程练习\n- tests/：测试示例\n\n当前运行器是原型模拟，不支持完整 Cargo 项目构建。\n' },
  ]
  const s1: Session = {
    ...newSession('ownership'),
    id: 'sess_move',
    title: '理解所有权转移',
    updatedAt: now() - 1000 * 60 * 42,
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: '为什么赋值后原变量不能用了？',
        quote: {
          source: 'lesson',
          label: '所有权与借用 · 课件',
          text: '将 String 赋值给另一个变量时，所有权会转移。之后继续使用原变量会导致编译错误。',
        },
        createdAt: now() - 1000 * 60 * 44,
      },
      {
        id: 'm2',
        role: 'agent',
        status: 'done',
        text: '可以对照你熟悉的 Python 来理解。Python 里 `b = a` 之后两个名字指向同一个对象，由垃圾回收统一释放。\n\nRust 没有垃圾回收，内存在**所有者离开作用域时**释放。如果 `s1` 和 `s2` 都拥有同一块堆内存，就会被释放两次。所以 Rust 让 `s2` 接管所有权，`s1` 随即失效——这就是 move。',
        createdAt: now() - 1000 * 60 * 42,
      },
    ],
  }
  const space: Space = {
    ...emptySpace(),
    id: 'space_rust',
    kind: 'rust',
    name: 'Rust 入门',
    topic: 'Rust',
    requirement: {
      goal: '系统学习 Rust，能独立完成一个简单的命令行工具',
      background: '熟悉 Python，没有接触过需要手动管理内存的语言',
      outcome: '理解所有权等核心概念，独立写出一个可用的 CLI 工具',
      schedule: '每周约 5 小时',
    },
    onboarding: { messages: [], step: 3, agentTyping: false, summaryReady: true },
    routeNote: RUST_ROUTE_NOTE,
    stages,
    currentUnitId: 'ownership',
    view: 'unit',
    sessions: [s1],
    activeSessionIds: { 'unit:ownership': s1.id },
    files,
    directories: [
      { id: 'dir_src', name: 'src', parentId: null },
      { id: 'dir_utils', name: 'utils', parentId: 'dir_src' },
      { id: 'dir_examples', name: 'examples', parentId: null },
      { id: 'dir_tests', name: 'tests', parentId: null },
    ],
    expandedDirectoryIds: ['dir_src', 'dir_utils', 'dir_examples', 'dir_tests'],
    selectedEntryId: 'f_move',
    openFileIds: ['f_move'],
    activeFileId: 'f_move',
    lastActive: now() - 1000 * 60 * 40,
  }
  return space
}

export function pytorchSpace(): Space {
  const session: Session = {
    ...newSession('tensors'),
    id: 'sess_pt',
    title: '张量的 shape 总是对不上',
    updatedAt: now() - 1000 * 60 * 60 * 26,
    messages: [
      {
        id: 'pm1',
        role: 'user',
        text: '为什么 (2, 2) 和 (2, 3) 的张量不能相加，但可以做矩阵乘法？',
        createdAt: now() - 1000 * 60 * 60 * 26,
      },
      {
        id: 'pm2',
        role: 'agent',
        status: 'done',
        text: '逐元素相加要求两个张量在每个维度上长度相同，或者其中一个为 1（这就是广播）。`(2, 2)` 与 `(2, 3)` 在第二维分别是 2 和 3，无法广播。\n\n矩阵乘法 `A @ B` 只要求 A 的列数等于 B 的行数：`(2, 2) @ (2, 3)` 得到 `(2, 3)`，所以没问题。',
        createdAt: now() - 1000 * 60 * 60 * 26,
      },
    ],
  }
  return {
    ...emptySpace(),
    id: 'space_pytorch',
    kind: 'pytorch',
    name: 'PyTorch 基础',
    topic: 'PyTorch',
    requirement: {
      goal: '能用 PyTorch 训练一个简单的图像分类模型',
      background: '熟悉 Python 与 NumPy，线性代数基础一般',
      outcome: '独立完成 MNIST 手写数字分类',
      schedule: '周末集中学习',
    },
    onboarding: { messages: [], step: 3, agentTyping: false, summaryReady: true },
    routeNote: '从你熟悉的 NumPy 出发理解张量，再逐步过渡到自动求导和完整的训练循环。',
    stages: pytorchStages(),
    currentUnitId: 'tensors',
    view: 'unit',
    sessions: [session],
    activeSessionIds: { 'unit:tensors': session.id },
    files: [
      {
        id: 'f_tensor',
        name: 'tensor_basics.py',
        parentId: 'dir_pt_examples',
        language: 'python',
        content: `import torch

x = torch.tensor([[1., 2.], [3., 4.]])
y = torch.ones(2, 2)

print(x.shape)
print(x + y)
print(x @ y)`,
      },
      { id: 'f_pt_readme', name: 'README.md', parentId: null, language: 'text', content: '# PyTorch 学习项目\n\n课程练习位于 examples/。\n' },
    ],
    directories: [{ id: 'dir_pt_examples', name: 'examples', parentId: null }],
    expandedDirectoryIds: ['dir_pt_examples'],
    openFileIds: ['f_tensor'],
    selectedEntryId: 'f_tensor',
    activeFileId: 'f_tensor',
    env: 'connected',
    envLabel: 'Python 3.11 · torch 2.4 · ~/teachme/pytorch-basics',
    lastActive: now() - 1000 * 60 * 60 * 26,
  }
}

export function allUnits(space: Space): Unit[] {
  return space.stages.flatMap((s) => s.units)
}

export function findUnit(space: Space, id: string | null): Unit | undefined {
  if (!id) return undefined
  return allUnits(space).find((u) => u.id === id)
}

export function nextUnit(space: Space, id: string): Unit | undefined {
  const units = allUnits(space)
  const idx = units.findIndex((u) => u.id === id)
  return units.slice(idx + 1).find((u) => u.status !== 'passed' && u.status !== 'skipped')
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
