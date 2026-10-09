import type { Quote, RouteActionKind, Session, Space, Unit } from './types'

interface ReplyInput {
  space: Space
  unit?: Unit
  session: Session
  text: string
  quote?: Quote | null
  inAssessment: boolean
}

export interface Reply {
  text: string
  action?: RouteActionKind
  title?: string
}

const has = (s: string, re: RegExp) => re.test(s)

function routeReply({ space, text }: ReplyInput): Reply {
  if (space.kind === 'rust' && has(text, /(已经会|会了|学过|跳过)/) && has(text, /(基础|语法)/)) {
    return {
      action: 'skip-basics',
      text: '好的。根据你的 Python 经验，「基础语法速览」里的大部分内容你可以跳过，遇到新语法时我们在具体单元里顺带讲解。\n\n我建议把它标记为「已掌握」，直接从「所有权与借用」开始。确认后路线会更新。',
    }
  }
  if (space.kind === 'rust' && has(text, /(先做项目|想做项目|项目驱动|边做边学)/)) {
    return {
      action: 'project-first',
      text: '可以把项目感提前。我建议在「所有权与借用」之后插入一个小练习项目「单词计数器」，用刚学到的知识先做出一个能跑的东西，再继续学习结构体与错误处理。\n\n确认后路线会更新，其余单元顺序不变。',
    }
  }
  return {
    text: `我们围绕「${space.requirement?.rows.find((row) => row.answer.trim())?.answer ?? space.name}」来安排这条路线。\n\n你可以告诉我哪些内容已经掌握、想提前做什么项目，或者希望怎样调整节奏。我会先给出建议，确认后再更新路线。`,
  }
}

function rustReply(input: ReplyInput): Reply {
  const { text, quote, unit, inAssessment } = input
  const all = `${text} ${quote?.text ?? ''}`
  const isOwnership = unit?.lessonKey === 'ownership'

  if (inAssessment) {
    return {
      text: `这道题想看的是你能否**用自己的话**说明 move 发生的时机，以及你知道哪几种办法让原变量继续可用。\n\n我不直接给出答案，给你一个思考方向：先找到「值被交给别人」的那一行，再想想如果只是想让对方看一眼，而不是拿走，应该怎么写。写完可以先点「运行」验证代码题。`,
    }
  }

  if (quote?.source === 'advice') {
    return {
      text: `我们就针对这一点练一下。上次测评里，你修复代码时用了 \`.clone()\`，结果是对的，但还没说明为什么也可以改用借用。\n\n试着把下面的函数改成接收 \`&String\`，并让调用处传 \`&name\`：\n\n\`\`\`rust\nfn shout(s: &String) -> String {\n    s.to_uppercase()\n}\n\nfn main() {\n    let name = String::from("ferris");\n    let loud = shout(&name);\n    println!("{} -> {}", name, loud);\n}\n\`\`\`\n\n跑通之后想一想：两种写法在内存上有什么不同？想好了随时可以再次发起测评。`,
    }
  }

  if (quote?.source === 'code' || quote?.source === 'terminal' || has(all, /(报错|错误|E0382|编译不过|error|跑不通)/i)) {
    return {
      title: '调试我的练习',
      text: `这是一个典型的 **E0382：使用了已被移动的值**。编译器已经把三件事都指出来了：\n\n1. \`s1\` 的类型是 \`String\`，没有实现 \`Copy\`；\n2. 在 \`let s2 = s1;\` 这一行，所有权转移给了 \`s2\`；\n3. 之后又在 \`println!\` 中使用了 \`s1\`。\n\n修复方式取决于你的意图。如果两个变量都需要各自的一份数据，用 \`clone\`：\n\n\`\`\`rust\nfn main() {\n    let s1 = String::from("hello");\n    let s2 = s1.clone();\n\n    println!("s2 = {}", s2);\n    println!("s1 = {}", s1);\n}\n\`\`\`\n\n如果 \`s2\` 只是想读一读，借用 \`let s2 = &s1;\` 更轻量。可以把代码带入 IDE 分别试试。`,
    }
  }

  if (has(text, /(例子|举例|换个|再来一个)/)) {
    return {
      text: '换一个函数调用的例子。把 `String` 交给函数，同样会发生所有权转移：\n\n```rust\nfn takes(s: String) {\n    println!("拿到了 {}", s);\n}\n\nfn main() {\n    let s1 = String::from("hello");\n    takes(s1);\n    println!("{}", s1);\n}\n```\n\n可以把它当作「把书送给朋友」：送出去以后，书就不在你手上了。想让朋友只是看看，就应该「借」给他——把参数改成 `&String`，调用时写 `takes(&s1)`。',
    }
  }

  if (has(all, /(借用|引用|&)/)) {
    return {
      text: '借用就是「只看不拿」。`&s1` 创建一个指向 `s1` 的引用，所有权仍然在 `s1` 手里。\n\n需要记住一条规则：同一时刻，要么有**任意多个** `&T`，要么有**恰好一个** `&mut T`。这样编译器就能保证不会有人在你读的时候偷偷修改数据。',
    }
  }

  if (has(all, /(clone|复制|拷贝)/i)) {
    return {
      text: '`.clone()` 会在堆上复制一份完整的数据，两个变量各自拥有一份，互不影响。它最直接，但数据很大时有开销。\n\n一个经验：如果只是读取，优先考虑借用；确实需要两份独立的数据时再 `clone`。',
    }
  }

  if (isOwnership && (quote?.source === 'lesson' || has(text, /(什么意思|为什么|不明白|不懂|解释|怎么理解)/))) {
    return {
      title: '理解所有权转移',
      text: '可以对照你熟悉的 Python 来理解。Python 里 `b = a` 之后两个名字指向同一个对象，由垃圾回收统一释放。\n\nRust 没有垃圾回收，内存在**所有者离开作用域时**释放。如果 `s1` 和 `s2` 同时拥有同一块堆内存，就会被释放两次。所以 Rust 让 `s2` 接管所有权，`s1` 随即失效——这就是 move。\n\n课件里的 `move_demo.rs` 正好演示了这一点，带入 IDE 运行一下，读读编译器的提示。',
    }
  }

  const unitTitle = unit?.title ?? '当前单元'
  return {
    text: `好问题。结合你正在学习的「${unitTitle}」和你的 Python 背景，我的理解是：${quote ? `你选中的这段是在说「${quote.text.slice(0, 28)}${quote.text.length > 28 ? '…' : ''}」。` : ''}关键在于先弄清它要解决什么问题，再看具体写法。\n\n你可以告诉我更具体的困惑点，或者把相关代码带入 IDE 跑一下，我们围绕结果继续讨论。`,
  }
}

function pytorchReply(input: ReplyInput): Reply {
  const { text, quote } = input
  const all = `${text} ${quote?.text ?? ''}`
  if (quote?.source === 'terminal' || has(all, /(RuntimeError|报错|错误|size)/i)) {
    return {
      title: '调试 shape 不匹配',
      text: '这个 RuntimeError 说的是：逐元素相加时，第 1 维一个是 2、一个是 3，无法广播。\n\n`+` 需要每个维度相同或其中一个为 1；而 `@` 只要求左边的列数等于右边的行数。把 `x + y` 注释掉，只保留 `x @ y` 再运行试试。',
    }
  }
  return {
    text: '在 NumPy 里你已经熟悉了 ndarray，张量的大部分操作可以一一对应。主要区别在于张量可以放到 GPU 上（`.to("cuda")`），并且能记录计算过程以便自动求导。\n\n你可以把想验证的写法放到 `tensor_basics.py` 里跑一下，我们看着输出继续聊。',
  }
}

export function composeReply(input: ReplyInput): Reply {
  if (input.session.unitId === null) return routeReply(input)
  if (input.space.kind === 'pytorch') return pytorchReply(input)
  return rustReply(input)
}

export function titleFrom(text: string, quote?: Quote | null) {
  const base = text.trim() || quote?.text || '新会话'
  return base.length > 14 ? `${base.slice(0, 14)}…` : base
}

export const ONBOARDING_QUESTIONS = {
  background: '好的，先了解一下你的基础：你之前用过哪些编程语言？有没有接触过 C/C++ 这类需要自己关心内存的语言？',
  levelWithGoal: '你提到最后想做出一个命令行工具，目标很明确，我就不再追问了。那么每周大概能投入多少时间？有没有希望完成的时间点？',
  level: '明白了。你希望学到什么程度？比如能读懂别人的代码，还是能独立完成一个项目？每周大概能投入多少时间？',
  summary: '信息足够了，我把你的学习需求整理成了下面这份摘要。你可以直接修改，也可以继续告诉我需要调整的地方。确认后我会为你规划学习路线。',
  updated: '收到，我已经把这点补充进摘要里了，你看看现在是否准确。',
}
