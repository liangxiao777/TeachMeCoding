import { AppShell } from '@/components/app-shell'
import { AppModelProvider } from './context'
import { usePersistentModel } from './persistent-model'

export default function PersistentApp() {
  const model = usePersistentModel()
  return <AppModelProvider value={model}><AppShell /></AppModelProvider>
}
