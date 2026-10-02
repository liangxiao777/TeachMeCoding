import type { Unit } from './types'

export type LessonBlock =
  | { type: 'h2'; id: string; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; file: string; language: 'rust' | 'python'; code: string; caption?: string }
  | { type: 'callout'; title: string; text: string }
  | { type: 'practice'; items: string[] }
  | { type: 'diagram-move' }

export interface Lesson {
  intro: string
  blocks: LessonBlock[]
}

const ownership: Lesson = {
  intro:
    '你已经熟悉 Python，所以这份课件会从 Python 的变量模型出发，对照理解 Rust 的所有权。遇到不清楚的地方，直接选中那段文字向我提问。',
  blocks: [
    { type: 'h2', id: 'from-python', text: '从 Python 的视角出发' },
    {
      type: 'p',
      text: '在 Python 中，`b = a` 只是让两个名字指向同一个对象，内存由垃圾回收器在合适的时候释放。Rust 没有垃圾回收，它用一套在编译期检查的规则来决定内存何时释放——这套规则就是所有权。',
    },
    { type: 'h2', id: 'rules', text: '三条所有权规则' },
    {
      type: 'list',
      items: [
        '每个值都有一个被称为「所有者」的变量。',
        '同一时刻，一个值只能有一个所有者。',
        '当所有者离开作用域，这个值会被自动释放（drop）。',
      ],
    },
    { type: 'h2', id: 'move', text: '所有权转移（move）' },
    {
      type: 'p',
      text: '将 String 赋值给另一个变量时，所有权会转移。之后继续使用原变量会导致编译错误。',
    },
    {
      type: 'p',
      text: '这是因为 String 的实际内容存放在堆上。如果 `s1` 和 `s2` 同时拥有这块内存，离开作用域时就会被释放两次。Rust 选择让 `s1` 失效，从根本上避免这个问题。',
    },
    { type: 'diagram-move' },
    {
      type: 'code',
      file: 'move_demo.rs',
      language: 'rust',
      caption: '带入 IDE 运行一下，看看编译器会说什么',
      code: `fn main() {
    let s1 = String::from("hello");
    let s2 = s1;

    println!("s2 = {}", s2);
    println!("s1 = {}", s1);
}`,
    },
    {
      type: 'callout',
      title: '为什么整数不会这样？',
      text: '`i32`、`bool` 这类大小固定、完全存放在栈上的类型实现了 `Copy`。赋值时直接复制一份值，原变量依然可用。',
    },
    { type: 'h2', id: 'borrow', text: '借用：只看不拿' },
    {
      type: 'p',
      text: '如果只是想读取一个值，而不想拿走它的所有权，可以传递引用 `&s1`，这被称为借用。借用结束后，所有权仍然留在原变量手里。',
    },
    {
      type: 'code',
      file: 'borrow_demo.rs',
      language: 'rust',
      code: `fn print_len(s: &String) {
    println!("长度是 {}", s.len());
}

fn main() {
    let s1 = String::from("hello");
    print_len(&s1);
    println!("s1 仍然可用：{}", s1);
}`,
    },
    {
      type: 'p',
      text: '同一时刻，你可以拥有任意多个不可变借用 `&T`，或者恰好一个可变借用 `&mut T`，但两者不能同时存在。这条规则让 Rust 在编译期就排除了数据竞争。',
    },
    { type: 'h2', id: 'practice', text: '动手试试' },
    {
      type: 'practice',
      items: [
        '运行 move_demo.rs，读一读 E0382 报错里的每一行提示。',
        '分别用 `.clone()` 和 `&` 借用两种方式修复它，比较两者的差别。',
        '写一个接收 `String` 参数的函数，调用后再使用原变量，观察会发生什么。',
      ],
    },
  ],
}

const structs: Lesson = {
  intro:
    '上一单元你已经掌握了所有权转移与借用。这一单元我们用结构体和枚举组织数据，你会看到所有权规则同样作用于结构体的字段。',
  blocks: [
    { type: 'h2', id: 'struct', text: '用结构体描述一件事' },
    {
      type: 'p',
      text: '结构体类似 Python 中只有属性的 dataclass：把相关的数据打包成一个有名字的类型。每个字段都有明确的类型，结构体实例拥有它所有字段的所有权。',
    },
    {
      type: 'code',
      file: 'struct_demo.rs',
      language: 'rust',
      code: `struct Todo {
    title: String,
    done: bool,
}

fn main() {
    let t = Todo { title: String::from("学习所有权"), done: true };
    println!("{} 完成了吗？{}", t.title, t.done);
}`,
    },
    { type: 'h2', id: 'impl', text: '为结构体添加方法' },
    {
      type: 'p',
      text: '在 `impl` 块中定义方法。第一个参数 `&self` 表示借用这个实例——正是上一单元学过的不可变借用，调用方法不会拿走实例的所有权。',
    },
    { type: 'h2', id: 'enum', text: '枚举：一个值只能是几种情况之一' },
    {
      type: 'p',
      text: 'Rust 的枚举比 Python 的 Enum 更强大，每个变体都可以携带数据。配合 `match`，编译器会检查你是否处理了所有情况。',
    },
    {
      type: 'callout',
      title: '与命令行项目的联系',
      text: '最终的命令行工具会用枚举表示「搜索模式」，用结构体保存配置。现在打下的基础会直接用在项目里。',
    },
    { type: 'h2', id: 'practice', text: '动手试试' },
    {
      type: 'practice',
      items: [
        '给 Todo 增加一个 `priority: u8` 字段并打印出来。',
        '尝试把 `t.title` 赋值给新变量后再打印 `t.title`，结合上一单元想想会发生什么。',
      ],
    },
  ],
}

const tensors: Lesson = {
  intro: '你熟悉 NumPy，所以可以把张量理解为「能在 GPU 上运行、并且能自动求导的 ndarray」。',
  blocks: [
    { type: 'h2', id: 'create', text: '创建张量' },
    {
      type: 'p',
      text: '`torch.tensor` 从 Python 列表创建张量，`torch.zeros`、`torch.rand` 按形状创建。张量的 `shape` 与 `dtype` 决定了它能参与哪些运算。',
    },
    {
      type: 'code',
      file: 'tensor_basics.py',
      language: 'python',
      code: `import torch

x = torch.tensor([[1., 2.], [3., 4.]])
y = torch.ones(2, 2)

print(x.shape)
print(x + y)
print(x @ y)`,
    },
    { type: 'h2', id: 'broadcast', text: '广播与矩阵乘法' },
    {
      type: 'p',
      text: '逐元素运算遵循与 NumPy 相同的广播规则；矩阵乘法使用 `@`。shape 对不上是初学时最常见的报错来源。',
    },
    { type: 'h2', id: 'practice', text: '动手试试' },
    { type: 'practice', items: ['把 y 改为 `torch.ones(2, 3)`，分别运行 `x + y` 与 `x @ y`，比较结果。'] },
  ],
}

const LESSONS: Record<string, Lesson> = { ownership, structs, tensors }

export function getLesson(unit: Unit, language: 'rust' | 'python'): Lesson {
  const lesson = LESSONS[unit.lessonKey]
  if (lesson) return lesson
  const file = language === 'rust' ? `${unit.id}_practice.rs` : `${unit.id}_practice.py`
  return {
    intro: `这份课件根据你当前的学习情况生成，围绕「${unit.title}」展开。`,
    blocks: [
      { type: 'h2', id: 'why', text: '本单元要解决的问题' },
      { type: 'p', text: unit.summary },
      { type: 'h2', id: 'goals', text: '学完之后你能做到' },
      { type: 'list', items: unit.goals },
      {
        type: 'code',
        file,
        language,
        code:
          language === 'rust'
            ? `fn main() {\n    let topic = String::from("${unit.title}");\n    println!("开始练习：{}", topic);\n}`
            : `topic = "${unit.title}"\nprint("开始练习：" + topic)`,
      },
      { type: 'h2', id: 'practice', text: '动手试试' },
      { type: 'practice', items: ['修改示例并运行，遇到任何疑问都可以直接问我。'] },
    ],
  }
}

export function lessonToText(lesson: Lesson): string {
  return lesson.blocks
    .map((b) => {
      if (b.type === 'p' || b.type === 'h2') return b.text
      if (b.type === 'list' || b.type === 'practice') return b.items.join('\n')
      if (b.type === 'callout') return `${b.title} ${b.text}`
      return ''
    })
    .join('\n')
}
