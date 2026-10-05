import { ArrowLeft, Blocks, BookOpen, Plug, Settings2 } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ThemeToggle } from '@/app/theme'
import { ModelSettingsForm } from './model-settings'
import { McpSettingsForm } from './mcp-settings'
import { SkillsSettingsForm } from './skills-settings'

export const SettingsNavigation = createContext<(() => void) | null>(null)

export function SettingsButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const open = useContext(SettingsNavigation)
  if (!open) return null
  return (
    <Button variant="ghost" size={iconOnly ? 'icon-sm' : 'sm'} aria-label="应用设置" title="应用设置" onClick={open}>
      <Settings2 data-icon={iconOnly ? undefined : 'inline-start'} />
      {!iconOnly && <span className="max-sm:hidden">设置</span>}
    </Button>
  )
}

const categories = [
  { id: 'model', label: '模型配置', icon: Blocks },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'skills', label: 'Skills', icon: BookOpen },
] as const

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [category, setCategory] = useState('model')
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 768px)').matches)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    title.current?.focus()
    const query = matchMedia('(min-width: 768px)')
    const resize = () => setDesktop(query.matches)
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [])

  return (
    <section aria-label="应用设置" className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b px-4 md:px-6">
        <Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" /> 返回学习</Button>
        <span className="h-5 border-l" aria-hidden />
        <h1 ref={title} tabIndex={-1} className="text-base font-semibold outline-none">设置</h1>
        <ThemeToggle className="ml-auto" />
      </header>
      <Tabs value={category} onValueChange={(value) => setCategory(String(value))} orientation={desktop ? 'vertical' : 'horizontal'}
        className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b bg-sidebar p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
          <TabsList aria-label="设置类别" className="h-auto! w-full gap-1 bg-transparent p-0">
            {categories.map(({ id, label, icon: Icon }) => (
              <TabsTrigger key={id} value={id} className="h-10 flex-none px-3 max-md:flex-1 data-active:bg-background">
                <Icon />{label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {categories.map(({ id, label, icon: Icon }) => (
          <TabsContent key={id} value={id} keepMounted className="min-h-0 min-w-0 overflow-y-auto p-5 md:p-10">
            <div className={`mx-auto flex w-full flex-col gap-6 ${id === 'skills' ? 'max-w-5xl' : 'max-w-3xl'}`}>
              {id === 'model' && <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">{label}</h2>
                {id === 'model' && <p className="text-sm text-muted-foreground">选择教学模型、推理强度与登录方式。</p>}
              </div>}
              {id === 'model' && <ModelSettingsForm active={category === id} />}
              {id === 'mcp' && <McpSettingsForm active={category === id} />}
              {id === 'skills' && <SkillsSettingsForm active={category === id} />}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  )
}
