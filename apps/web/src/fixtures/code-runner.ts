// A tiny simulated compiler/runtime, only good enough for the prototype's demo snippets.

export interface RunResult {
  ok: boolean
  stdout: string[]
  stderr: string[]
}

interface FnDef {
  params: { name: string; type: string }[]
  body: string[]
  bodyStart: number
}

function stripComment(line: string) {
  let inStr = false
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') inStr = !inStr
    if (!inStr && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr
    if (!inStr) {
      if (c === '(' || c === '{' || c === '[') depth++
      if (c === ')' || c === '}' || c === ']') depth--
      if (c === ',' && depth === 0) {
        out.push(cur.trim())
        cur = ''
        continue
      }
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function parseFns(lines: string[]): Record<string, FnDef> {
  const fns: Record<string, FnDef> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*fn\s+(\w+)\s*\(([^)]*)\)/)
    if (!m) continue
    const params = m[2]!
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [name, ...rest] = p.split(':')
        return { name: name!.replace('mut ', '').trim(), type: rest.join(':').trim() }
      })
    let depth = 0
    const body: string[] = []
    let j = i
    for (; j < lines.length; j++) {
      const l = stripComment(lines[j]!)
      for (const c of l) {
        if (c === '{') depth++
        if (c === '}') depth--
      }
      if (j > i) body.push(l)
      if (depth === 0 && j > i) break
      if (depth === 0 && j === i && l.includes('}')) break
    }
    body.pop()
    fns[m[1]!] = { params, body, bodyStart: i + 1 }
    i = j
  }
  return fns
}

type Env = Record<string, string>

function evalExpr(raw: string, env: Env, fns: Record<string, FnDef>, out: string[]): string {
  const e = raw.trim().replace(/;$/, '')
  let m: RegExpMatchArray | null
  if ((m = e.match(/^String::from\("(.*)"\)$/))) return m[1]!
  if ((m = e.match(/^"(.*)"\.to_string\(\)$/))) return m[1]!
  if ((m = e.match(/^"(.*)"$/))) return m[1]!
  if (e === 'String::new()') return ''
  if ((m = e.match(/^&(mut\s+)?(.+)$/))) return evalExpr(m[2]!, env, fns, out)
  if ((m = e.match(/^(.+)\.clone\(\)$/))) return evalExpr(m[1]!, env, fns, out)
  if ((m = e.match(/^(.+)\.len\(\)$/))) return String([...evalExpr(m[1]!, env, fns, out)].length)
  if ((m = e.match(/^(.+)\.to_uppercase\(\)$/))) return evalExpr(m[1]!, env, fns, out).toUpperCase()
  if ((m = e.match(/^(\w+)\((.*)\)$/)) && fns[m[1]!]) {
    return callFn(m[1]!, splitTopLevel(m[2]!), env, fns, out)
  }
  if (/^-?\d+(\.\d+)?$/.test(e) || e === 'true' || e === 'false') return e
  if (e in env) return env[e]!
  return e
}

function formatPrint(args: string[], env: Env, fns: Record<string, FnDef>, out: string[]) {
  const fmtMatch = args[0]?.match(/^"(.*)"$/)
  if (!fmtMatch) return ''
  let fmt = fmtMatch[1]!
  let idx = 1
  fmt = fmt.replace(/\{(\w*)(:\?)?\}/g, (_, name: string) => {
    if (name) return env[name] ?? name
    const v = args[idx++]
    return v ? evalExpr(v, env, fns, out) : ''
  })
  return fmt
}

function execLines(lines: string[], env: Env, fns: Record<string, FnDef>, out: string[]): string | undefined {
  let last: string | undefined
  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim()
    if (!line || line === '}' || line === '{') continue
    let m: RegExpMatchArray | null
    if ((m = line.match(/^println!\((.*)\);?$/))) {
      out.push(formatPrint(splitTopLevel(m[1]!), env, fns, out))
    } else if ((m = line.match(/^let\s+(mut\s+)?(\w+)\s*(:[^=]+)?=\s*(\w+)\s*\{(.*)\}\s*;$/))) {
      const name = m[2]!
      for (const field of splitTopLevel(m[5]!)) {
        const [k, ...v] = field.split(':')
        env[`${name}.${k!.trim()}`] = evalExpr(v.join(':'), env, fns, out)
      }
      env[name] = m[4]!
    } else if ((m = line.match(/^let\s+(mut\s+)?(\w+)\s*(:[^=]+)?=\s*(.+);$/))) {
      env[m[2]!] = evalExpr(m[4]!, env, fns, out)
    } else if ((m = line.match(/^(\w+)\.push_str\("(.*)"\);$/))) {
      env[m[1]!] = (env[m[1]!] ?? '') + m[2]!
    } else if ((m = line.match(/^(\w+)\s*=\s*(.+);$/))) {
      env[m[1]!] = evalExpr(m[2]!, env, fns, out)
    } else if ((m = line.match(/^(\w+)\((.*)\);$/)) && fns[m[1]!]) {
      callFn(m[1]!, splitTopLevel(m[2]!), env, fns, out)
    } else if (!line.endsWith(';')) {
      last = evalExpr(line, env, fns, out)
    }
  }
  return last
}

function callFn(name: string, args: string[], env: Env, fns: Record<string, FnDef>, out: string[]): string {
  const fn = fns[name]!
  const local: Env = {}
  fn.params.forEach((p, i) => {
    local[p.name] = args[i] ? evalExpr(args[i], env, fns, out) : ''
  })
  return execLines(fn.body, local, fns, out) ?? ''
}

function isStringExpr(expr: string) {
  return /String::from|String::new|\.to_string\(\)|\.clone\(\)/.test(expr)
}

function checkRust(code: string, fileName: string): string[] | null {
  const lines = code.split('\n')
  const fns = parseFns(lines)
  const stringVars = new Set<string>()
  const moved: Record<string, { at: number; decl: number; col: number; viaFn?: string }> = {}
  const decls: Record<string, number> = {}

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!)
    let m: RegExpMatchArray | null

    for (const [v, info] of Object.entries(moved)) {
      if (i === info.at) continue
      const re = new RegExp(`(^|[^\\w.])${v}(?![\\w])`)
      if (re.test(line) && !new RegExp(`let\\s+(mut\\s+)?${v}\\b`).test(line)) {
        const matches = [...line.matchAll(new RegExp(`\\b${v}\\b`, 'g'))]
        const col = (matches[matches.length - 1]?.index ?? 0) + 1
        const pad = String(i + 1).length
        const sp = ' '.repeat(pad)
        const declLine = lines[info.decl]!
        const moveLine = lines[info.at]!
        const moveCol = moveLine.search(new RegExp(`\\b${v}\\b`))
        const errs = [
          `error[E0382]: borrow of moved value: \`${v}\``,
          `${sp}--> ${fileName}:${i + 1}:${col}`,
          `${sp} |`,
          `${String(info.decl + 1).padStart(pad)} | ${declLine}`,
          `${sp} | ${' '.repeat(declLine.search(new RegExp(`\\b${v}\\b`)))}${'-'.repeat(v.length)} move occurs because \`${v}\` has type \`String\`, which does not implement the \`Copy\` trait`,
          `${String(info.at + 1).padStart(pad)} | ${moveLine}`,
          `${sp} | ${' '.repeat(moveCol)}${'-'.repeat(v.length)} value moved here`,
          `${String(i + 1).padStart(pad)} | ${lines[i]}`,
          `${sp} | ${' '.repeat(col - 1)}${'^'.repeat(v.length)} value borrowed here after move`,
          `${sp} |`,
        ]
        if (info.viaFn) {
          errs.push(
            `note: consider changing this parameter type in function \`${info.viaFn}\` to borrow instead if owning the value isn't necessary`,
          )
        }
        errs.push(
          `help: consider cloning the value if the performance cost is acceptable`,
          '',
          'error: aborting due to 1 previous error',
          '',
          `For more information about this error, try \`rustc --explain E0382\`.`,
        )
        return errs
      }
    }

    if ((m = line.match(/let\s+(mut\s+)?(\w+)\s*(:[^=]+)?=\s*(.+);/))) {
      decls[m[2]!] = i
      if (isStringExpr(m[4]!)) stringVars.add(m[2]!)
      const rhs = m[4]!.trim()
      if (stringVars.has(rhs)) {
        moved[rhs] = { at: i, decl: decls[rhs]!, col: 0 }
        stringVars.add(m[2]!)
      }
    }

    const callRe = /(\w+)\(([^()]*)\)/g
    let cm: RegExpExecArray | null
    while ((cm = callRe.exec(line))) {
      const fn = fns[cm[1]!]
      if (!fn || /^\s*fn\s/.test(line)) continue
      const args = splitTopLevel(cm[2]!)
      for (let a = 0; a < args.length; a++) {
        const arg = args[a]!
        const param = fn.params[a]
        if (!param) continue
        if (param.type.startsWith('&') && !arg.startsWith('&') && stringVars.has(arg)) {
          const pad = String(i + 1).length
          const sp = ' '.repeat(pad)
          return [
            `error[E0308]: mismatched types`,
            `${sp}--> ${fileName}:${i + 1}:${line.indexOf(arg) + 1}`,
            `${sp} |`,
            `${String(i + 1).padStart(pad)} | ${lines[i]}`,
            `${sp} | ${' '.repeat(line.indexOf(arg))}${'^'.repeat(arg.length)} expected \`${param.type}\`, found \`String\``,
            `${sp} |`,
            `help: consider borrowing here: \`&${arg}\``,
            '',
            'error: aborting due to 1 previous error',
          ]
        }
        if (param.type === 'String' && stringVars.has(arg)) {
          moved[arg] = { at: i, decl: decls[arg] ?? i, col: 0, viaFn: cm[1] }
        }
      }
    }
  }
  return null
}

export function runRust(code: string, fileName: string): RunResult {
  const errors = checkRust(code, fileName)
  if (errors) return { ok: false, stdout: [], stderr: errors }
  const lines = code.split('\n')
  const fns = parseFns(lines)
  if (!fns.main) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        `error[E0601]: \`main\` function not found in crate \`${fileName.split('/').at(-1)!.replace(/\.rs$/, '')}\``,
        'error: aborting due to 1 previous error',
      ],
    }
  }
  const out: string[] = []
  execLines(fns.main.body, {}, fns, out)
  return { ok: true, stdout: out, stderr: [] }
}

const PY_KNOWN: Record<string, string> = {
  'x.shape': 'torch.Size([2, 2])',
  x: 'tensor([[1., 2.],\n        [3., 4.]])',
  'x + y': 'tensor([[2., 3.],\n        [4., 5.]])',
  'x @ y': 'tensor([[3., 3.],\n        [7., 7.]])',
}

export function runPython(code: string, fileName = 'tensor_basics.py'): RunResult {
  const out: string[] = []
  const lines = code.split('\n')
  if (/torch\.ones\(2,\s*3\)/.test(code) && /x\s*\+\s*y/.test(code)) {
    return {
      ok: false,
      stdout: ['torch.Size([2, 2])'],
      stderr: [
        'Traceback (most recent call last):',
        `  File "${fileName}", line 7, in <module>`,
        '    print(x + y)',
        'RuntimeError: The size of tensor a (2) must match the size of tensor b (3) at non-singleton dimension 1',
      ],
    }
  }
  for (const line of lines) {
    const m = line.trim().match(/^print\((.*)\)$/)
    if (!m) continue
    const expr = m[1]!.trim()
    const lit = expr.match(/^"(.*)"(\s*\+\s*(\w+))?$/)
    if (lit) {
      const varMatch = lit[3] ? code.match(new RegExp(`${lit[3]}\\s*=\\s*"(.*)"`)) : null
      out.push(lit[1]! + (varMatch ? varMatch[1]! : ''))
    } else {
      out.push(...(PY_KNOWN[expr] ?? `<${expr}>`).split('\n'))
    }
  }
  return { ok: true, stdout: out, stderr: [] }
}

export function runFile(name: string, content: string, language: 'rust' | 'python'): RunResult {
  return language === 'rust' ? runRust(content, name) : runPython(content, name)
}

export function runCommandFor(name: string, language: 'rust' | 'python') {
  const quoted = JSON.stringify(name)
  const binary = JSON.stringify(`./${name.split('/').at(-1)!.replace(/\.rs$/, '')}`)
  return language === 'rust' ? `rustc ${quoted} && ${binary}` : `python ${quoted}`
}
