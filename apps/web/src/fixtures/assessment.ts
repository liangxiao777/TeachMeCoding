import i18n from '@/i18n'
import { runFile } from './code-runner'
import type { AssessmentRecord, Controls, Space, Unit } from './types'

export interface AssessmentSpec {
  abilities: string[]
  q1: { title: string; prompt: string; code?: string }
  q2: { title: string; prompt: string; starter: string; file: string; expected?: string }
}

export function getAssessment(unit: Unit, language: 'rust' | 'python'): AssessmentSpec {
  if (unit.lessonKey === 'ownership') {
    return {
      abilities: ['解释所有权转移的时机', '选择合适的方式保留变量可用性', '读懂并修复 E0382'],
      q1: {
        title: i18n.t('preview:assessment.explanation'),
        prompt: '阅读下面的代码，用自己的话解释第 4 行为什么无法编译；如果希望 `a` 之后依然可用，你会怎么改？',
        code: `let a = String::from("rust");\nlet b = a;\nprintln!("{}", b);\nprintln!("{}", a);`,
      },
      q2: {
        title: i18n.t('preview:assessment.debugging'),
        prompt: '这段代码无法通过编译。请修复它，使程序输出 `ferris -> FERRIS`，运行验证后提交。',
        file: 'assessment_fix.rs',
        expected: 'ferris -> FERRIS',
        starter: `fn shout(s: String) -> String {
    s.to_uppercase()
}

fn main() {
    let name = String::from("ferris");
    let loud = shout(name);
    println!("{} -> {}", name, loud);
}`,
      },
    }
  }
  return {
    abilities: unit.goals,
    q1: { title: i18n.t('preview:assessment.explanation'), prompt: `用你自己的话说明「${unit.title}」中最核心的概念，并举一个例子。` },
    q2: {
      title: i18n.t('preview:assessment.coding'),
      prompt: '修改下面的代码，让它输出与本单元主题相关的一句话，运行验证后提交。',
      file: language === 'rust' ? 'assessment.rs' : 'assessment.py',
      starter:
        language === 'rust'
          ? `fn main() {\n    println!("TODO");\n}`
          : `print("TODO")`,
    },
  }
}

export function evaluate(
  space: Space,
  unit: Unit,
  answers: { q1: string; q2: string },
  controls: Controls,
  attempt: number,
): AssessmentRecord {
  const language = space.kind === 'pytorch' ? 'python' : 'rust'
  const spec = getAssessment(unit, language)
  const run = runFile(spec.q2.file, answers.q2, language)
  const output = run.stdout.join('\n')

  let pass: boolean
  const mastered: string[] = []
  const concerns: string[] = []
  const evidence: string[] = []
  const toVerify: string[] = []

  if (unit.lessonKey === 'ownership') {
    const q1Move = /(所有权|转移|移动|move|失效)/i.test(answers.q1)
    const q1Fix = /(clone|借用|引用|&)/i.test(answers.q1)
    const q2Ok = run.ok && (!spec.q2.expected || output.includes(spec.q2.expected))
    const usedBorrow = /&\s*name|:\s*&(String|str)/.test(answers.q2)

    if (q1Move) {
      mastered.push('能够说明 `let b = a;` 会把所有权转移给 b')
      evidence.push(`解释题中你写道：「${answers.q1.slice(0, 40)}${answers.q1.length > 40 ? '…' : ''}」`)
    } else {
      concerns.push('解释中没有说明所有权在哪一行、转移给了谁')
      evidence.push(answers.q1.trim() ? `解释题的回答「${answers.q1.slice(0, 30)}…」没有提到所有权转移` : '解释题尚未作答')
    }
    if (q1Fix) mastered.push('知道可以通过 clone 或借用让原变量继续可用')
    else concerns.push('尚未提到如何让原变量继续可用（clone 或借用）')

    if (q2Ok) {
      mastered.push(usedBorrow ? '能用借用修复函数参数导致的 move，并通过运行验证' : '能修复函数参数导致的 move，并通过运行验证')
      evidence.push(`调试题代码可以编译运行，输出「${output}」`)
    } else {
      concerns.push('调试题代码仍无法通过编译，函数参数导致的所有权转移还需要练习')
      evidence.push(run.ok ? `调试题输出为「${output}」，与要求不一致` : `调试题代码编译失败：${run.stderr[0] ?? ''}`)
    }
    if (!usedBorrow && q2Ok) toVerify.push('本次用 clone 修复，借用写法（&String）尚未在代码中验证')
    toVerify.push('可变借用 &mut 的规则本次没有涉及，会在后续单元中继续观察')
    pass = q1Move && q1Fix && q2Ok
  } else {
    const q1Ok = answers.q1.trim().length >= 10
    const q2Ok = run.ok && !output.includes('TODO')
    if (q1Ok) mastered.push('能够用自己的话说明本单元核心概念')
    else concerns.push('解释题的回答过于简短，难以判断理解程度')
    if (q2Ok) mastered.push('能够独立修改并运行代码')
    else concerns.push('编程题尚未完成或仍无法运行')
    evidence.push(q1Ok ? '解释题给出了完整的说明' : '解释题回答少于 10 个字')
    evidence.push(q2Ok ? `编程题输出「${output}」` : '编程题未产生预期输出')
    pass = q1Ok && q2Ok
  }

  if (controls.assessmentOverride === 'pass') pass = true
  if (controls.assessmentOverride === 'needs_work') pass = false

  if (pass && concerns.length) {
    toVerify.unshift(...concerns)
    concerns.length = 0
  }
  if (!pass && concerns.length === 0) {
    concerns.push('解释中对「为什么需要所有权」的说明还比较模糊，建议再结合示例想一想')
  }

  return {
    id: `rec_${Date.now().toString(36)}`,
    unitId: unit.id,
    unitTitle: unit.title,
    attempt,
    result: pass ? 'pass' : 'needs_work',
    createdAt: Date.now(),
    answers,
    summary: pass
      ? `你已经能准确说明所有权何时转移，并能在代码中修复相关报错，达到了「${unit.title}」的单元目标。`
      : `你对「${unit.title}」已经有了初步理解，但有几处关键点还不稳定，建议针对下面的问题再巩固一下。`,
    mastered,
    concerns,
    evidence,
    toVerify,
  }
}
