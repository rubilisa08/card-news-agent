import { claudeCliEngine } from './claude-cli.ts';
import { mockEngine } from './mock.ts';
import type { Engine } from './types.ts';

const engines: Record<string, Engine> = {
  'claude-cli': claudeCliEngine,
  mock: mockEngine,
};

export function selectEngine(): Engine {
  // `npm run start:mock` passes --mock so beginners need no environment variables.
  const name = process.argv.includes('--mock') ? 'mock' : (process.env.CARD_NEWS_ENGINE ?? 'claude-cli');
  const engine = engines[name];
  if (!engine) {
    throw new Error(`알 수 없는 엔진 "${name}". 사용 가능: ${Object.keys(engines).join(', ')}`);
  }
  return engine;
}
