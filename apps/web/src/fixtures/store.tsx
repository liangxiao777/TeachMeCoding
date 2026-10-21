'use client'

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { AppModelProvider } from '@/app/context'
import i18n from '@/i18n'
import { notice } from '@/i18n/notice'
import { ONBOARDING_QUESTIONS, composeReply, titleFrom } from './agent-script'
import { evaluate, getAssessment } from './assessment'
import { getLesson } from './lessons'
import { runCommandFor, runFile } from './code-runner'
import { activeSession, ensureSession, selectSession, sessionUnitId } from './sessions'
import { addProjectEntry, closeProjectFile, entryPath, openProjectFile, projectChildren, renameProjectEntry, resolveProjectPath } from './project-files'
import { availableUnitIds, canAccessView } from '@/app/selectors'
import {
  RUST_ROUTE_NOTE,
  detectKind,
  emptySpace,
  findUnit,
  initialRequirement,
  newSession,
  nextUnit,
  pytorchSpace,
  rustInProgressSpace,
  stagesFor,
  topicFrom,
  uid,
} from './demo-data'
import type {
  AppState,
  AssessmentDraft,
  CodeFile,
  Controls,
  Message,
  Quote,
  Requirement,
  Session,
  Space,
  SpaceView,
  TermLine,
  Unit,
} from './types'

type SpaceFn = (s: Space) => Space

const withUnit = (s: Space, unitId: string, fn: (u: Unit) => Unit): Space => ({
  ...s,
  stages: s.stages.map((st) => ({ ...st, units: st.units.map((u) => (u.id === unitId ? fn(u) : u)) })),
})

const withSession = (s: Space, sessionId: string, fn: (x: Session) => Session): Space => ({
  ...s,
  sessions: s.sessions.map((x) => (x.id === sessionId ? fn(x) : x)),
})

const withMessage = (s: Space, sessionId: string, msgId: string, fn: (m: Message) => Message): Space =>
  withSession(s, sessionId, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === msgId ? fn(m) : m)) }))

const langOf = (s: Space): 'rust' | 'python' => (s.kind === 'pytorch' ? 'python' : 'rust')

const termLines = (runId: string, kind: TermLine['kind'], lines: string[], message?: TermLine['notice']): TermLine[] =>
  lines.map((text) => ({ id: uid('t'), runId, kind, text, ...(message ? { notice: message } : {}) }))

function useStoreImpl(initialState: () => AppState) {
  const [state, setState] = useState<AppState>(initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const actions = useMemo(() => {
    const mapSpace = (id: string, fn: SpaceFn) =>
      setState((st) => ({ ...st, spaces: st.spaces.map((s) => (s.id === id ? fn(s) : s)) }))
    const curId = () => stateRef.current.currentSpaceId
    const cur = () => stateRef.current.spaces.find((s) => s.id === curId())
    const mapCur = (fn: SpaceFn) => {
      const id = curId()
      if (id) mapSpace(id, fn)
    }
    const mapActiveSession = (fn: (session: Session) => Session) => mapCur((s) => {
      const { space, session } = ensureSession(s)
      return withSession(space, session.id, fn)
    })
    const getSpace = (id: string) => stateRef.current.spaces.find((s) => s.id === id)

    const generateUnit = (spaceId: string, unitId: string) => {
      const space = getSpace(spaceId)
      if (!space || !availableUnitIds(space).has(unitId)) return
      mapSpace(spaceId, (s) => withUnit(s, unitId, (u) => ({ ...u, hasLesson: u.hasLesson ?? u.contentState === 'ready', contentState: 'generating' })))
      setTimeout(() => {
        const fail = stateRef.current.controls.failNextGeneration
        if (fail) setState((st) => ({ ...st, controls: { ...st.controls, failNextGeneration: false } }))
        mapSpace(spaceId, (s) => withUnit(s, unitId, (u) => ({ ...u, hasLesson: u.hasLesson || !fail, contentState: fail ? 'failed' : 'ready' })))
      }, 2600)
    }

    const enterUnit = (unitId: string) => {
      const s = cur()
      if (!s || !availableUnitIds(s).has(unitId)) return
      const u = findUnit(s, unitId)
      if (!u) return
      mapCur((sp) => {
        let next = withUnit({ ...sp, currentUnitId: unitId, view: 'unit' as SpaceView, viewingRecordId: null }, unitId, (x) => ({
          ...x,
          status: x.status === 'not_started' || x.status === 'skipped' ? 'learning' : x.status,
        }))
        next = ensureSession(next).space
        return next
      })
      if (u.contentState === 'none' || u.contentState === 'failed') generateUnit(s.id, unitId)
    }

    const startReply = (spaceId: string, sessionId: string, agentId: string, userMsg: Message) => {
      const t = setTimeout(() => {
        timers.current.delete(agentId)
        if (stateRef.current.controls.failNextReply) {
          setState((st) => ({ ...st, controls: { ...st.controls, failNextReply: false } }))
          mapSpace(spaceId, (s) => withMessage(s, sessionId, agentId, (m) => ({ ...m, status: 'error' })))
          return
        }
        const space = getSpace(spaceId)
        if (!space) return
        const session = space.sessions.find((x) => x.id === sessionId)
        if (!session) return
        const reply = composeReply({
          space,
          unit: findUnit(space, session.unitId),
          session: { ...session, messages: session.messages.filter((m) => m.id !== agentId) },
          text: userMsg.text,
          quote: userMsg.quote,
          inAssessment: userMsg.inAssessment ?? false,
        })
        mapSpace(spaceId, (s) => {
          let next = withMessage(s, sessionId, agentId, (m) => ({
            ...m,
            status: 'streaming',
            full: reply.text,
            text: '',
            action: reply.action ? { kind: reply.action, applied: false } : undefined,
          }))
          next = withSession(next, sessionId, (x) => ({
            ...x,
            title: x.title || (reply.title ?? titleFrom(userMsg.text, userMsg.quote)),
          }))
          return next
        })
        const interval = setInterval(() => {
          let finished = false
          mapSpace(spaceId, (s) =>
            withMessage(s, sessionId, agentId, (m) => {
              if (m.status !== 'streaming' || !m.full) return m
              const text = m.full.slice(0, m.text.length + 5)
              finished = text.length >= m.full.length
              return { ...m, text, status: finished ? 'done' : 'streaming' }
            }),
          )
          const msg = getSpace(spaceId)
            ?.sessions.find((x) => x.id === sessionId)
            ?.messages.find((m) => m.id === agentId)
          if (!msg || msg.status !== 'streaming' || finished) {
            clearInterval(interval)
            timers.current.delete(agentId)
          }
        }, 28)
        timers.current.set(agentId, interval as unknown as ReturnType<typeof setTimeout>)
      }, 800)
      timers.current.set(agentId, t)
    }

    const pushTerm = (spaceId: string, lines: TermLine[]) =>
      mapSpace(spaceId, (s) => ({ ...s, terminal: [...s.terminal, ...lines].slice(-300) }))

    const runFileIn = (spaceId: string, file: CodeFile) => {
      const s = getSpace(spaceId)
      if (!s) return
      const runId = uid('run')
      const language = file.language
      if (language === 'text') {
        pushTerm(spaceId, termLines(runId, 'info', ['此文件不可直接运行，原型支持 Rust 和 Python 练习。'], notice('preview', 'terminal.fileNotRunnable')))
        return
      }
      const path = entryPath(s, file.id)
      if (s.env !== 'connected') {
        pushTerm(
          spaceId,
          termLines(runId, 'info', [s.env === 'lost' ? '环境连接已断开，请重新连接后再运行。' : '环境正在自动连接，请稍候再运行。'],
            notice('preview', s.env === 'lost' ? 'terminal.connectionLost' : 'terminal.connecting')),
        )
        return
      }
      mapSpace(spaceId, (x) => ({ ...x, running: true }))
      setTimeout(() => {
        const latest = getSpace(spaceId)?.files.find((f) => f.id === file.id) ?? file
        const res = runFile(path, latest.content, language)
        const lines = [
          ...termLines(runId, 'out', res.stdout),
          ...termLines(runId, 'err', res.stderr),
          ...termLines(runId, 'info', [res.ok ? '进程已结束，退出码 0' : '运行失败，退出码 1'],
            notice('preview', res.ok ? 'terminal.processExited' : 'terminal.runFailed')),
        ]
        pushTerm(spaceId, lines)
        mapSpace(spaceId, (x) => ({ ...x, running: false }))
      }, 1100)
    }

    const onboardSend = (spaceId: string, text: string) => {
      if (!text.trim()) return
      const userMsg = { id: uid('ob'), role: 'user' as const, text: text.trim() }
      mapSpace(spaceId, (sp) => ({
        ...sp,
        onboarding: { ...sp.onboarding, messages: [...sp.onboarding.messages, userMsg], agentTyping: true },
      }))
      setTimeout(() => {
        mapSpace(spaceId, (sp) => {
          const step = sp.onboarding.step
          const answers = sp.onboarding.messages.filter((m) => m.role === 'user').map((m) => m.text)
          let reply = ''
          let patch: Partial<Space> = {}
          let summaryReady = sp.onboarding.summaryReady
          if (step === 0) {
            const kind = detectKind(text)
            const topic = topicFrom(text)
            patch = { kind, topic, name: kind === 'rust' ? i18n.t('preview:spaceNames.rust') : i18n.t('preview:spaceNames.learning', { topic }) }
            reply = ONBOARDING_QUESTIONS.background
          } else if (step === 1) {
            reply = /(工具|项目|做出|写一个|完成)/.test(answers[0] ?? '')
              ? ONBOARDING_QUESTIONS.levelWithGoal
              : ONBOARDING_QUESTIONS.level
          } else if (step === 2) {
            patch = { requirement: initialRequirement(sp.kind, sp.topic, answers) }
            summaryReady = true
            reply = ONBOARDING_QUESTIONS.summary
          } else {
            const req = sp.requirement!
            const isTime = /(\d+\s*(小时|h|天|周|个月)|周末|每天|晚上)/.test(text)
            patch = {
              requirement: { rows: [...req.rows, { question: isTime ? '补充时间安排？' : '还有什么偏好？', answer: text }] },
            }
            reply = ONBOARDING_QUESTIONS.updated
          }
          return {
            ...sp,
            ...patch,
            onboarding: {
              messages: [...sp.onboarding.messages, { id: uid('ob'), role: 'agent', text: reply }],
              step: step + 1,
              agentTyping: false,
              summaryReady,
            },
          }
        })
      }, 1100)
    }

    return {
      goHome: () => {
        setState((st) => ({ ...st, currentSpaceId: null, globalView: 'home' }))
      },
      goSpaces: () => {
        setState((st) => ({ ...st, currentSpaceId: null, globalView: 'spaces' }))
      },
      openSpace: (id: string) => {
        setState((st) => ({
          ...st,
          currentSpaceId: id,
          spaces: st.spaces.map((s) => (s.id === id ? { ...s, lastActive: Date.now() } : s)),
        }))
      },
      createSpace: (goal: string) => {
        if (!goal.trim()) return
        const s = emptySpace()
        setState((st) => ({ ...st, spaces: [s, ...st.spaces], currentSpaceId: s.id }))
        onboardSend(s.id, goal)
      },
      onboardSend: (text: string) => {
        const id = curId()
        if (id) onboardSend(id, text)
      },
      updateRequirement: (patch: Partial<Requirement>) =>
        mapCur((s) => (s.requirement ? { ...s, requirement: { ...s.requirement, ...patch } } : s)),
      renameSpace: (name: string) => mapCur((s) => ({ ...s, name })),
      confirmRequirement: () => {
        const s = cur()
        if (!s) return
        mapCur((sp) => ({ ...sp, view: 'planning' }))
        setTimeout(() => {
          mapSpace(s.id, (sp) => {
            const stages = stagesFor(sp.kind, sp.topic)
            return ensureSession({
              ...sp,
              stages,
              routeNote:
                sp.kind === 'rust'
                  ? RUST_ROUTE_NOTE
                  : `根据你的基础与目标，先建立核心概念，再通过常用操作熟练起来，最后用一个小项目把内容串起来。`,
              currentUnitId: stages[0]!.units[0]!.id,
              view: 'route',
              sessions: [],
              activeSessionIds: {},
            }).space
          })
        }, 2600)
      },

      setView: (view: SpaceView) => mapCur((s) => canAccessView(s, view, s.currentUnitId)
        ? { ...s, view, ideFullscreen: false } : s),
      enterUnit,
      retryGeneration: (unitId: string) => {
        const id = curId()
        if (id) generateUnit(id, unitId)
      },

      setComposerText: (text: string) => mapActiveSession((s) => ({ ...s, composerText: text })),
      setRouteSuggestion: (text: string) => mapActiveSession((s) => ({ ...s, routeSuggestion: text })),
      setQuote: (q: Quote | null) => mapCur((s) => {
        const { space, session } = ensureSession(s)
        return withSession({ ...space, agentOpen: q ? true : space.agentOpen }, session.id, (x) => ({ ...x, composerQuote: q }))
      }),
      sendMessage: (messageText?: string) => {
        const s = cur()
        if (!s) return false
        const { space, session } = ensureSession(s)
        if (session.messages.some((m) => m.status === 'thinking' || m.status === 'streaming')) return false
        const text = (messageText ?? session.composerText).trim()
        const quote = messageText === undefined ? session.composerQuote : null
        if (!text && !quote) return false
        const userMsg: Message = {
          id: uid('msg'),
          role: 'user',
          text,
          quote: quote ?? undefined,
          inAssessment: space.view === 'assessment',
          createdAt: Date.now(),
        }
        const agentMsg: Message = { id: uid('msg'), role: 'agent', text: '', status: 'thinking', createdAt: Date.now() }
        mapSpace(s.id, () => {
          const base = {
            ...space,
            agentOpen: true,
          }
          return withSession(base, session.id, (x) => ({
            ...x,
            ...(messageText === undefined ? { composerText: '', composerQuote: null } : {}),
            updatedAt: Date.now(),
            messages: [...x.messages, userMsg, agentMsg],
          }))
        })
        startReply(s.id, session.id, agentMsg.id, userMsg)
        return true
      },
      stopReply: () => {
        const s = cur()
        if (!s) return
        const sess = activeSession(s)
        const m = sess?.messages.find((x) => x.status === 'thinking' || x.status === 'streaming')
        if (!sess || !m) return
        const t = timers.current.get(m.id)
        if (t) {
          clearTimeout(t)
          clearInterval(t as unknown as ReturnType<typeof setInterval>)
          timers.current.delete(m.id)
        }
        mapSpace(s.id, (sp) => withMessage(sp, sess.id, m.id, (x) => ({ ...x, status: 'stopped' })))
      },
      retryReply: (agentId: string) => {
        const s = cur()
        if (!s) return
        const sess = activeSession(s)
        if (!sess) return
        const idx = sess.messages.findIndex((m) => m.id === agentId)
        const userMsg = sess.messages.slice(0, idx).reverse().find((m) => m.role === 'user')
        if (!userMsg) return
        mapSpace(s.id, (sp) =>
          withMessage(sp, sess.id, agentId, (m) => ({ ...m, status: 'thinking', text: '', full: undefined })),
        )
        startReply(s.id, sess.id, agentId, userMsg)
      },
      newSession: () =>
        mapCur((s) => {
          const sess = newSession(sessionUnitId(s))
          return selectSession({ ...s, sessions: [sess, ...s.sessions], agentOpen: true }, sess)
        }),
      switchSession: (id: string) => mapCur((s) => {
        const session = s.sessions.find((x) => x.id === id)
        return session ? selectSession(s, session) : s
      }),
      applyRouteAction: (msgId: string) =>
        mapCur((s) => {
          const sess = activeSession(s)
          const msg = sess?.messages.find((m) => m.id === msgId)
          if (!sess || sess.unitId !== null || !msg?.action || msg.action.applied) return s
          let next = s
          if (msg.action.kind === 'skip-basics') {
            next = withUnit(next, 'basics', (u) => ({ ...u, status: 'skipped' }))
            if (next.currentUnitId === 'basics') next = { ...next, currentUnitId: 'ownership' }
          } else {
            const exists = next.stages.some((st) => st.units.some((u) => u.id === 'mini'))
            if (!exists) {
              next = {
                ...next,
                stages: next.stages.map((st) => {
                  const i = st.units.findIndex((u) => u.id === 'ownership')
                  if (i === -1) return st
                  const mini: Unit = {
                    id: 'mini',
                    title: '练习项目：单词计数器',
                    summary: '用刚学到的所有权与借用，写一个统计文本中单词出现次数的小工具。',
                    goals: ['读取字符串并拆分单词', '用借用在函数间传递数据'],
                    status: 'not_started',
                    contentState: 'none',
                    lessonKey: 'mini',
                  }
                  const units = [...st.units]
                  units.splice(i + 1, 0, mini)
                  return { ...st, units }
                }),
              }
            }
          }
          return withMessage(next, sess.id, msgId, (m) => ({ ...m, action: { ...m.action!, applied: true } }))
        }),

      toggleAgent: (open?: boolean) => mapCur((s) => ({ ...s, agentOpen: open ?? !s.agentOpen })),
      toggleIde: (open?: boolean) => mapCur((s) => ({ ...s, ideOpen: open ?? !s.ideOpen, ideFullscreen: false })),
      setIdeFullscreen: (full: boolean) => mapCur((s) => ({ ...s, ideFullscreen: full, ideOpen: true })),
      toggleExplorer: () => mapCur((s) => ({ ...s, explorerOpen: !s.explorerOpen })),
      selectEntry: (id: string | null) => mapCur((s) => ({ ...s, selectedEntryId: id })),
      toggleDirectory: (id: string, open?: boolean) => mapCur((s) => {
        const expanded = open ?? !s.expandedDirectoryIds.includes(id)
        return { ...s, expandedDirectoryIds: expanded ? [...new Set([...s.expandedDirectoryIds, id])] : s.expandedDirectoryIds.filter((x) => x !== id) }
      }),
      collapseDirectories: () => mapCur((s) => ({ ...s, expandedDirectoryIds: [], selectedEntryId: null })),
      createEntry: (name: string, kind: 'file' | 'directory', parentId: string | null) => {
        const s = cur()
        if (!s) return notice('common', 'errors.noSpace')
        const result = addProjectEntry(s, name, kind, parentId)
        if (!result.error) mapCur(() => result.space)
        return result.error
      },
      renameEntry: (id: string, name: string) => {
        const s = cur()
        if (!s) return notice('common', 'errors.noSpace')
        const result = renameProjectEntry(s, id, name)
        if (!result.error) mapCur(() => result.space)
        return result.error
      },
      openFile: (id: string) => mapCur((s) => openProjectFile(s, id)),
      closeFile: (id: string) => mapCur((s) => closeProjectFile(s, id)),
      createFile: (name: string) => mapCur((s) => {
        const existing = s.files.find((f) => f.parentId === null && f.name === name)
        return existing ? openProjectFile(s, existing.id) : addProjectEntry(s, name, 'file', null).space
      }),
      updateFile: (id: string, content: string) =>
        mapCur((s) => ({ ...s, files: s.files.map((f) => (f.id === id ? { ...f, content } : f)) })),
      bringToIde: (code: string, name?: string) =>
        mapCur((s) => {
          const lang = langOf(s)
          let next = s
          let folder = s.directories.find((d) => d.parentId === null && d.name === 'examples')
          if (!folder) {
            next = addProjectEntry(s, 'examples', 'directory', null).space
            folder = next.directories.find((d) => d.parentId === null && d.name === 'examples')
          }
          const parentId = folder?.id ?? null
          const existing = name ? next.files.find((f) => f.parentId === parentId && f.name === name) : undefined
          if (existing) return openProjectFile(next, existing.id)
          const ext = lang === 'rust' ? '.rs' : '.py'
          let n = 1
          while (projectChildren(next, parentId).some((f) => f.name === `agent_example_${n}${ext}`)) n++
          const result = addProjectEntry(next, name ?? `agent_example_${n}${ext}`, 'file', parentId)
          if (result.error) return result.space
          return { ...result.space, files: result.space.files.map((f) => f.id === result.space.activeFileId ? { ...f, content: code } : f) }
        }),

      connectEnv: () => {
        const s = cur()
        if (!s || s.env === 'connected' || s.env === 'connecting') return
        const key = `env:${s.id}`
        if (timers.current.has(key)) return
        mapCur((sp) => ({ ...sp, env: 'connecting' }))
        const timer = setTimeout(() => {
          timers.current.delete(key)
          mapSpace(s.id, (sp) => ({
            ...sp,
            env: 'connected',
            envLabel:
              sp.kind === 'pytorch'
                ? 'Python 3.11 · torch 2.4 · ~/teachme/pytorch-basics'
                : `rustc 1.83.0 · ~/teachme/${sp.kind === 'rust' ? 'rust-intro' : 'practice'}`,
          }))
        }, 1500)
        timers.current.set(key, timer)
      },
      disconnectEnv: () => mapCur((s) => (s.env === 'connected' ? { ...s, env: 'lost' } : s)),
      terminalCommand: (cmd: string) => {
        const s = cur()
        if (!s) return
        const c = cmd.trim()
        if (!c) return
        const runId = uid('run')
        if (c === 'clear') {
          mapCur((sp) => ({ ...sp, terminal: [] }))
          return
        }
        pushTerm(s.id, termLines(runId, 'cmd', [c]))
        const tokens = c.match(/"[^"]*"|'[^']*'|\S+/g)?.map((x) => x.replace(/^(["'])(.*)\1$/, '$2')) ?? []
        if (tokens[0] === 'pwd') {
          pushTerm(s.id, termLines(runId, 'out', [`/${entryPath(s, s.terminalDirectoryId)}`]))
          return
        }
        if (tokens[0] === 'ls' || tokens[0] === 'cd') {
          const target = resolveProjectPath(s, tokens[1] ?? (tokens[0] === 'cd' ? '/' : '.'))
          if (!target || target.kind !== 'directory') {
            pushTerm(s.id, termLines(runId, 'err', [`目录不存在：${tokens[1] ?? ''}`], notice('preview', 'terminal.directoryNotFound', { path: tokens[1] ?? '' })))
          } else if (tokens[0] === 'cd') {
            mapCur((sp) => ({ ...sp, terminalDirectoryId: target.id }))
          } else {
            const entries = projectChildren(s, target.id).map((e) => `${e.name}${e.kind === 'directory' ? '/' : ''}`).join('   ')
            pushTerm(s.id, termLines(runId, 'out', [entries || '（空）'], entries ? undefined : notice('preview', 'terminal.emptyDirectory')))
          }
          return
        }
        if (c === 'help') {
          pushTerm(s.id, termLines(runId, 'out', ['原型模拟终端：pwd、cd <目录>、ls [目录]、clear、rustc <路径>、python <路径>、cargo run（仅模拟入口文件）'], notice('preview', 'terminal.help')))
          return
        }
        if (/^(rustc|python3?)$/.test(tokens[0] ?? '') || c === 'cargo run') {
          const target = resolveProjectPath(s, c === 'cargo run' ? '/src/main.rs' : tokens[1] ?? '')
          const f = target?.kind === 'file' ? s.files.find((x) => x.id === target.id) : undefined
          if (!f) {
            pushTerm(s.id, termLines(runId, 'err', [`error: 找不到文件 ${tokens[1] ?? ''}`], notice('preview', 'terminal.fileNotFound', { path: tokens[1] ?? '' })))
            return
          }
          if (c === 'cargo run') pushTerm(s.id, termLines(runId, 'info', ['原型仅模拟 src/main.rs，不执行 Cargo 构建或依赖解析。'], notice('preview', 'terminal.cargoSimulation')))
          runFileIn(s.id, f)
          return
        }
        pushTerm(s.id, termLines(runId, 'err', [`command not found: ${c.split(' ')[0]}`]))
      },

      startAssessment: () => {
        const s = cur()
        if (!s?.currentUnitId) return
        const unit = findUnit(s, s.currentUnitId)!
        if (s.draft && s.draft.unitId === unit.id) {
          mapCur((sp) => ({ ...sp, view: 'assessment' }))
          return
        }
        const spec = getAssessment(unit, langOf(s))
        const draft: AssessmentDraft = {
          unitId: unit.id,
          state: 'generating',
          q1: '',
          q2: spec.q2.starter,
          q2Output: null,
          q2Running: false,
          attempt: s.records.filter((r) => r.unitId === unit.id).length + 1,
        }
        mapCur((sp) => ({ ...sp, draft, view: 'assessment' }))
        setTimeout(() => {
          mapSpace(s.id, (sp) => (sp.draft ? { ...sp, draft: { ...sp.draft, state: 'ready' } } : sp))
        }, 2200)
      },
      updateDraft: (patch: Partial<AssessmentDraft>) =>
        mapCur((s) => (s.draft ? { ...s, draft: { ...s.draft, ...patch } } : s)),
      runDraft: () => {
        const s = cur()
        if (!s?.draft) return
        const unit = findUnit(s, s.draft.unitId)!
        const spec = getAssessment(unit, langOf(s))
        mapCur((sp) => (sp.draft ? { ...sp, draft: { ...sp.draft, q2Running: true } } : sp))
        setTimeout(() => {
          mapSpace(s.id, (sp) => {
            if (!sp.draft) return sp
            const res = runFile(spec.q2.file, sp.draft.q2, langOf(sp))
            const runId = uid('run')
            return {
              ...sp,
              draft: {
                ...sp.draft,
                q2Running: false,
                q2Output: [
                  ...termLines(runId, 'cmd', [runCommandFor(spec.q2.file, langOf(sp))]),
                  ...termLines(runId, 'out', res.stdout),
                  ...termLines(runId, 'err', res.stderr),
                ],
              },
            }
          })
        }, 900)
      },
      leaveAssessment: () => mapCur((s) => ({ ...s, view: 'unit' })),
      submitAssessment: () => {
        const s = cur()
        if (!s?.draft || s.draft.state !== 'ready') return
        mapCur((sp) => (sp.draft ? { ...sp, draft: { ...sp.draft, state: 'evaluating' } } : sp))
        setTimeout(() => {
          mapSpace(s.id, (sp) => {
            if (!sp.draft) return sp
            const unit = findUnit(sp, sp.draft.unitId)!
            const record = evaluate(sp, unit, { q1: sp.draft.q1, q2: sp.draft.q2 }, stateRef.current.controls, sp.draft.attempt)
            const passed = record.result === 'pass'
            let next = withUnit(sp, unit.id, (u) => ({
              ...u,
              status: passed ? 'passed' : 'needs_work',
              lastAdvice: passed ? undefined : record.concerns,
            }))
            const hasNext = !!nextUnit(next, unit.id)
            next = {
              ...next,
              draft: null,
              records: [...next.records, record],
              viewingRecordId: record.id,
              view: 'result',
              completed: passed && !hasNext ? true : next.completed,
            }
            return next
          })
        }, 2600)
      },
      viewRecord: (id: string) => mapCur((s) => ({ ...s, viewingRecordId: id, view: 'result', ideFullscreen: false })),
      goNextUnit: () => {
        const s = cur()
        if (!s?.currentUnitId) return
        const n = nextUnit(s, s.currentUnitId)
        if (n) enterUnit(n.id)
      },
      backToStudy: () => mapCur((s) => ({ ...s, view: 'unit' })),

      setControls: (patch: Partial<Controls>) => setState((st) => ({ ...st, controls: { ...st.controls, ...patch } })),
      loadPreset: (preset: 'empty' | 'multi') => {
        timers.current.forEach((t) => {
          clearTimeout(t)
          clearInterval(t as unknown as ReturnType<typeof setInterval>)
        })
        timers.current.clear()
        setState((st) => ({
          ...st,
          currentSpaceId: null,
          globalView: preset === 'empty' ? 'home' : 'spaces',
          spaces: preset === 'empty' ? [] : [rustInProgressSpace(), pytorchSpace()],
        }))
      },
      addPytorch: () =>
        setState((st) =>
          st.spaces.some((s) => s.kind === 'pytorch') ? st : { ...st, spaces: [...st.spaces, pytorchSpace()] },
        ),
    }
  }, [])

  const current = state.spaces.find((s) => s.id === state.currentSpaceId) ?? null
  const session = current ? activeSession(current) : undefined
  return { state, current, session, ...actions }
}

export function AppProvider({ children, initialState }: { children: ReactNode; initialState: () => AppState }) {
  const store = useStoreImpl(initialState)
  return <AppModelProvider value={{
    ...store,
    capabilities: { agent: true, terminal: true, assessment: true },
    lesson: (unit) => getLesson(unit, store.current?.kind === 'pytorch' ? 'python' : 'rust'),
    assessment: (unit) => getAssessment(unit, store.current?.kind === 'pytorch' ? 'python' : 'rust'),
  }}>{children}</AppModelProvider>
}
