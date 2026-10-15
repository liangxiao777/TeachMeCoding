import { createContext, useContext, useState, type ReactNode } from 'react'

const Context = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null)

export function LessonDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Context value={{ open, setOpen }}>{children}</Context>
}

export function useLessonDrawer() {
  const drawer = useContext(Context)
  if (!drawer) throw new Error('useLessonDrawer requires LessonDrawerProvider')
  return drawer
}
