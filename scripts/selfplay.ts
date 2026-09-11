import { formatLadderSummary, runLadder, type PolicyId } from '../src/ai/selfplay.ts';
import { DEFAULT_ALGO_VERSION, isAlgoVersionId, type AlgoVersionId } from '../src/ai/algoVersions.ts';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const POLICIES: PolicyId[] = ['greedy', 'mcts-bench', 'mcts-short', 'mcts-long'];

function parsePolicy(value: string | undefined, fallback: PolicyId): PolicyId {
  if (value && POLICIES.includes(value as PolicyId)) {
    return value as PolicyId;
  }
  return fallback;
}

function parseVersion(value: string | undefined, fallback: AlgoVersionId): AlgoVersionId {
  if (isAlgoVersionId(value)) {
    return value;
  }
  return fallback;
}

async function main(): Promise<void> {
  const hero = parsePolicy(arg('hero'), 'mcts-short');
  const opponents = parsePolicy(arg('opponents'), 'greedy');
  const games = Number(arg('games', '5'));
  const maxPliesRaw = arg('max-plies');
  const maxPlies = maxPliesRaw ? Number(maxPliesRaw) : undefined;
  const heroColor = (arg('hero-color', 'blue') ?? 'blue') as 'blue' | 'yellow' | 'purple' | 'green';
  const heroVersion = parseVersion(arg('hero-version'), DEFAULT_ALGO_VERSION);
  const opponentVersion = parseVersion(arg('opponent-version'), heroVersion);

  console.log(
    `Running ${games} game(s): 1× ${hero} ${heroVersion} vs 3× ${opponents} ${opponentVersion} (hero=${heroColor})`,
  );
  const ladder = await runLadder({
    hero,
    opponents,
    games,
    heroColor,
    maxPlies,
    heroVersion,
    opponentVersion,
  });
  console.log(formatLadderSummary(ladder));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
