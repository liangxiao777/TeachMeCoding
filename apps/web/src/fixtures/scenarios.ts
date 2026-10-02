import { pytorchSpace, rustInProgressSpace } from './demo-data';
import type { AppState } from './types';

/** Explicit, disposable browser fixtures. No storage, network, or host execution. */
export function createFixtureState(params: URLSearchParams): AppState {
  const scene = params.get('scene');
  const populated = scene === 'spaces' || scene === 'route' || scene === 'unit';
  const spaces = populated ? [rustInProgressSpace(), pytorchSpace()] : [];
  if (scene === 'route') spaces[0]!.view = 'route';
  return {
    spaces,
    currentSpaceId: scene === 'route' || scene === 'unit' ? 'space_rust' : null,
    globalView: scene === 'spaces' ? 'spaces' : 'home',
    controls: {
      failNextReply: params.get('fault') === 'reply',
      failNextGeneration: params.get('fault') === 'lesson',
      assessmentOverride: 'auto',
    },
  };
}
