import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYER_COLORS } from '../src/engine/types.ts';

/**
 * De-seats a match result against a mirror baseline.
 *
 * The tournament statistic is seat-rotated on purpose: the challenger plays every seat and the four
 * rotations of a seed sum to zero, which removes seat advantage from the *headline* number. The
 * per-seat breakdown it also prints is **not** de-seated, and cannot be read directly, because
 * Blokus seats are not equal — a seat's raw advantage mixes how well the engine plays that seat with
 * how good the seat is.
 *
 * A mirror match separates them. With all four seats on the same engine, the per-seat advantage is
 * pure seat bias under that engine's play. Subtracting it from a real match leaves the part that is
 * actually about skill:
 *
 *     seat skill(seat) = advantage(seat) − mirrorBias(seat)
 *
 * This is the only way to answer "does it play the last seat badly", and no number reported so far
 * in this project could have answered it.
 *
 *   npm run seat-profile -- --mirror <mirror-summary.txt> --match <match-summary.txt>
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseSummary(path: string): {
  challenger: string;
  champion: string;
  overall: number;
  seats: Record<string, number>;
} {
  const text = readFileSync(path, 'utf8');
  const head = /Challenger: (\S+)\s+Champion: (\S+)/.exec(text);
  const adv = /Advantage \([^)]*\): (-?[\d.]+)/.exec(text);
  const seatLine = /Per-seat advantage: (.*)/.exec(text);
  const seats: Record<string, number> = {};
  if (seatLine) {
    for (const color of PLAYER_COLORS) {
      const m = new RegExp(`${color}\\s+(-?[\\d.]+)`).exec(seatLine[1]);
      seats[color] = m ? Number(m[1]) : Number.NaN;
    }
  }
  return {
    challenger: head?.[1] ?? '?',
    champion: head?.[2] ?? '?',
    overall: adv ? Number(adv[1]) : Number.NaN,
    seats,
  };
}

function findLatest(pattern: (s: ReturnType<typeof parseSummary>) => boolean): string | null {
  const dir = join(process.cwd(), 'selfplay-results');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('match-') && f.endsWith('-summary.txt'))
    .sort()
    .reverse();
  for (const f of files) {
    try {
      if (pattern(parseSummary(join(dir, f)))) {
        return join(dir, f);
      }
    } catch {
      // A summary written by an interrupted run may be truncated; skip it.
    }
  }
  return null;
}

function main(): void {
  const mirrorPath =
    arg('mirror') ?? findLatest((s) => s.challenger === s.champion && s.challenger !== '?');
  const matchPath = arg('match') ?? findLatest((s) => s.challenger !== s.champion);
  if (!mirrorPath || !matchPath) {
    console.error(
      'Need a mirror match and a real match. Run a mirror first:\n' +
        '  npm run match -- --challenger v2-pro --champion v2-pro --seeds 100 --iterations 300',
    );
    process.exitCode = 1;
    return;
  }

  const mirror = parseSummary(mirrorPath);
  const match = parseSummary(matchPath);

  console.log(
    `Seat profile\n` +
      `  match  : ${match.challenger} vs 3x ${match.champion}  (overall ${match.overall.toFixed(2)})\n` +
      `  mirror : ${mirror.challenger} vs itself — the seat bias baseline\n`,
  );
  console.log(
    `${'seat'.padEnd(9)}${'raw'.padStart(9)}${'seat bias'.padStart(12)}${'skill'.padStart(9)}`,
  );
  console.log('-'.repeat(39));
  const skills: number[] = [];
  PLAYER_COLORS.forEach((color, i) => {
    const raw = match.seats[color];
    const bias = mirror.seats[color];
    const skill = raw - bias;
    skills.push(skill);
    const order = ['first', 'second', 'third', 'last'][i];
    console.log(
      `${`${color} (${order})`.padEnd(9)}${raw.toFixed(2).padStart(9)}` +
        `${bias.toFixed(2).padStart(12)}${skill.toFixed(2).padStart(9)}`,
    );
  });
  const mean = skills.reduce((a, b) => a + b, 0) / skills.length;
  const spread = Math.max(...skills) - Math.min(...skills);
  console.log('-'.repeat(39));
  console.log(`${'mean'.padEnd(9)}${''.padStart(21)}${mean.toFixed(2).padStart(9)}`);
  console.log(
    `\nSpread across seats: ${spread.toFixed(2)} points. The weakest seat is ` +
      `${PLAYER_COLORS[skills.indexOf(Math.min(...skills))]}.`,
  );
  console.log(
    '\nThe mean should reproduce the headline advantage — a mirror baseline sums to zero across\n' +
      'seats by construction, so de-seating redistributes without changing the total.',
  );
}

main();
