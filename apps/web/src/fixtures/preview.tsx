import { AppShell } from '@/components/app-shell';
import { AppProvider } from './store';
import { createFixtureState } from './scenarios';

// This explicit preview entry is the only consumer of the in-memory prototype.
// It must not be used as an API fallback or share state with real learning data.
export default function Preview() {
  return <AppProvider initialState={() => createFixtureState(new URLSearchParams(location.search))}>
    <AppShell />
  </AppProvider>;
}
