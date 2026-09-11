import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Renders the round-robin matrix as one interactive page: pick a challenger and an opponent
 * archetype, read the measured result.
 *
 *   npm run matrix:render -- selfplay-results/matrix.json selfplay-results/matrix-report.html
 */

interface Cell {
  challenger: string;
  champion: string;
  seeds: number;
  games: number;
  advantage: number;
  low: number;
  high: number;
  significant: boolean;
  meanChallengerScore: number;
  firstPlaceRate: number;
  soleWinRate: number;
  perSeatAdvantage: Record<string, number>;
  meanGameMs: number;
  wallMinutes: number;
}

interface Matrix {
  versions: string[];
  iterations: number | null;
  requestedSeeds: number;
  updated: string;
  cells: Record<string, Cell>;
}

/** Per-move cost at 300 iterations, measured separately by `npm run trajectory`. */
const COST: Record<string, number> = {
  greedy: 1.8,
  v1: 279,
  'v2-lite': 271,
  'v2-pro': 732,
  v3: 41,
  'v3.1-nano': 43,
  'v3.1-lite': 56,
  'v3.1': 200,
  'v3.1-pro': 400,
  v4: 57,
};

const BLURB: Record<string, string> = {
  greedy: 'The v1 evaluation with no tree at all — one ranked move list, top pick. The floor.',
  v1: 'Best of generation 1 (nine variants). Legacy engine, hand-set weights, truncated rollouts.',
  'v2-lite': 'Generation 2: the same structure with weights fitted by CEM self-play. Rollouts truncated at 24 plies.',
  'v2-pro': 'v2-lite with rollouts played to the end instead of truncated. Nothing else differs. Champion.',
  v3: 'The research report implemented from scratch: bitboards, max^n vector backup, Voronoi territory, sealed-region packer.',
  'v3.1-nano': 'Tuned v3 evaluation, rollouts truncated at 12 plies. The cheapest tier.',
  'v3.1-lite': 'Tuned v3 evaluation with rollouts played out — the same change that separates v2-pro from v2-lite.',
  'v3.1': 'The 200 ms tier: wider rollouts (24 placements over 2 corners) at ~500 iterations.',
  'v3.1-pro': 'The 400 ms tier: the same rollout mix at ~1000 iterations.',
  v4: 'Learned evaluation: a network distilled from v2-pro and v3.1 search values, replacing the rollout entirely.',
};

const key = (a: string, b: string): string => `${a}|${b}`;

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function main(): void {
  const [, , inPath = 'selfplay-results/matrix.json', outPath = 'selfplay-results/matrix-report.html'] =
    process.argv;
  const matrix = JSON.parse(readFileSync(inPath, 'utf8')) as Matrix;
  const versions = matrix.versions;

  const played = Object.values(matrix.cells).filter((c) => c.games > 0);
  const totalGames = played.reduce((sum, c) => sum + c.games, 0);
  const maxAbs = Math.max(2, ...played.map((c) => Math.abs(c.advantage)));

  const fullGames = Math.max(0, ...played.map((c) => c.games));
  const data = JSON.stringify({
    versions,
    cells: matrix.cells,
    cost: COST,
    blurb: BLURB,
    maxAbs,
    fullGames,
  });

  const html = `<title>Blokus Engine Crosstable</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: light;
  --surface-0: #f4f3ef;
  --surface-1: #fcfcfb;
  --surface-2: #edece7;
  --line:      #dedcd4;
  --line-soft: #e9e7e0;
  --text-1:    #14140f;
  --text-2:    #55534a;
  --text-3:    #86847a;
  --pos:       #256abf;
  --neg:       #c93a39;
  --neutral:   #f0efec;
  --accent:    #2a78d6;
  --shadow:    0 1px 2px rgba(20,20,15,.06), 0 8px 24px rgba(20,20,15,.05);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface-0: #121211;
    --surface-1: #1a1a19;
    --surface-2: #232322;
    --line:      #34342f;
    --line-soft: #2a2a27;
    --text-1:    #ffffff;
    --text-2:    #c3c2b7;
    --text-3:    #8b8a80;
    --pos:       #3987e5;
    --neg:       #e66767;
    --neutral:   #383835;
    --accent:    #3987e5;
    --shadow:    0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-0: #121211;
  --surface-1: #1a1a19;
  --surface-2: #232322;
  --line:      #34342f;
  --line-soft: #2a2a27;
  --text-1:    #ffffff;
  --text-2:    #c3c2b7;
  --text-3:    #8b8a80;
  --pos:       #3987e5;
  --neg:       #e66767;
  --neutral:   #383835;
  --accent:    #3987e5;
  --shadow:    0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--surface-0);
  color: var(--text-1);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 56px 28px 80px; }
h1 { font-size: 30px; line-height: 1.15; margin: 0 0 10px; letter-spacing: -.02em; text-wrap: balance; }
.lede { color: var(--text-2); max-width: 65ch; margin: 0 0 6px; }
.meta { color: var(--text-3); font-size: 13px; font-family: var(--mono); margin-top: 14px; }
h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--text-3); margin: 52px 0 14px; font-weight: 600;
}
.picker {
  display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end;
  padding: 18px; background: var(--surface-1); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: var(--shadow);
}
.field { display: flex; flex-direction: column; gap: 6px; flex: 1 1 210px; min-width: 0; }
.field label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); font-weight: 600; }
select {
  font: 600 15px var(--mono); color: var(--text-1); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; width: 100%;
}
select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.vs { color: var(--text-3); font-size: 13px; padding-bottom: 11px; white-space: nowrap; }

.result {
  margin-top: 18px; padding: 26px 28px; background: var(--surface-1);
  border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
}
.headline { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.big { font: 700 52px/1 var(--mono); letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.ci { font: 400 15px var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
.verdict {
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
  padding: 4px 10px; border-radius: 999px; border: 1px solid currentColor;
}
.said { margin: 14px 0 0; color: var(--text-2); max-width: 62ch; }
.stats {
  margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--line-soft);
  display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 20px 24px;
}
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); font-weight: 600; }
.stat .v { font: 600 21px var(--mono); font-variant-numeric: tabular-nums; margin-top: 3px; }
.stat .s { font-size: 12px; color: var(--text-3); }

.tablewrap { overflow-x: auto; }
table.grid { border-collapse: separate; border-spacing: 3px; font-family: var(--mono); font-size: 13px; }
table.grid th { font-weight: 600; color: var(--text-2); font-size: 12px; padding: 4px 8px; white-space: nowrap; }
table.grid th.col { writing-mode: horizontal-tb; text-align: center; }
table.grid th.row { text-align: right; }
td.cell {
  width: 76px; height: 40px; text-align: center; border-radius: 6px; cursor: pointer;
  font-variant-numeric: tabular-nums; border: 1px solid transparent; color: var(--text-1);
}
td.cell:hover, td.cell:focus-visible { border-color: var(--text-1); outline: none; }
td.cell.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
td.cell.diag { color: var(--text-3); cursor: default; }
td.cell.empty { color: var(--text-3); cursor: default; background: var(--surface-2); }
/* Fewer games than the headline cells: the corner notch marks a wider interval, so a reader
   comparing two cells can see which one is the less certain measurement. */
td.cell.light { position: relative; }
td.cell.light::after {
  content: ''; position: absolute; right: 3px; bottom: 3px;
  border-left: 5px solid transparent; border-bottom: 5px solid var(--text-3); opacity: .55;
}
.legend { display: flex; align-items: center; gap: 10px; margin-top: 14px; font-size: 12px; color: var(--text-3); font-family: var(--mono); }
.ramp { height: 10px; width: 200px; border-radius: 999px; border: 1px solid var(--line); }

table.plain { width: 100%; border-collapse: collapse; font-size: 14px; }
table.plain th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--text-3); font-weight: 600; padding: 0 14px 8px 0; border-bottom: 1px solid var(--line);
}
table.plain td { padding: 10px 14px 10px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
table.plain td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
table.plain td.name { font-family: var(--mono); font-weight: 600; white-space: nowrap; }
.bar { display: inline-block; height: 8px; border-radius: 4px; background: var(--accent); vertical-align: middle; }
.note {
  margin-top: 18px; padding: 14px 18px; border-left: 3px solid var(--accent);
  background: var(--surface-1); border-radius: 0 8px 8px 0; font-size: 14px; color: var(--text-2);
}
.note strong { color: var(--text-1); }
footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--text-3); font-size: 13px; }
@media (max-width: 640px) {
  .wrap { padding: 32px 18px 60px; }
  .big { font-size: 40px; }
}
</style>

<div class="wrap">
  <h1>Blokus engine crosstable</h1>
  <p class="lede">
    Every engine generation played against every other, one challenger against three clones of an
    opponent, seats rotated so the statistic has an exactly-zero null. Positive means the challenger
    scored above the average of the three opponents it faced.
  </p>
  <p class="meta" id="meta"></p>

  <h2>Head to head</h2>
  <div class="picker">
    <div class="field">
      <label for="a">Challenger — one seat</label>
      <select id="a"></select>
    </div>
    <div class="vs">against three of</div>
    <div class="field">
      <label for="b">Opponents — three seats</label>
      <select id="b"></select>
    </div>
  </div>
  <div class="result" id="result"></div>

  <h2>Every pairing</h2>
  <p class="lede" style="margin-bottom:16px">
    Rows are the challenger, columns the opponent it faced three of. Click any cell to load it above.
    The diagonal is a mirror match, which cancels to exactly zero by construction — it is the
    harness's own validity check, not a measurement.
  </p>
  <div class="tablewrap"><table class="grid" id="grid"></table></div>
  <div class="legend">
    <span>challenger worse</span>
    <span class="ramp" id="ramp"></span>
    <span>challenger better</span>
    <span id="mixed" style="margin-left:14px"></span>
  </div>

  <h2>Compute cost per move</h2>
  <p class="lede" style="margin-bottom:16px">
    Measured at the same iteration budget, so these are like-for-like. This is what the
    <strong>lite</strong> / <strong>pro</strong> suffixes encode: a pro shares its sibling's
    evaluation exactly and differs only in playing its rollouts to the end instead of truncating
    them.
  </p>
  <div class="tablewrap"><table class="plain" id="costs"></table></div>

  <footer id="foot"></footer>
</div>

<script>
const DATA = ${data};

const fmt = (x, d = 2) => (x >= 0 ? '+' : '\\u2212') + Math.abs(x).toFixed(d);
const cellOf = (a, b) => DATA.cells[a + '|' + b];

function colorFor(v) {
  const t = Math.min(1, Math.abs(v) / DATA.maxAbs);
  const pole = v >= 0 ? 'var(--pos)' : 'var(--neg)';
  return 'color-mix(in oklab, ' + pole + ' ' + (t * 82).toFixed(1) + '%, var(--neutral))';
}

const selA = document.getElementById('a');
const selB = document.getElementById('b');
for (const v of DATA.versions) {
  for (const sel of [selA, selB]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v; sel.appendChild(o);
  }
}
selA.value = DATA.versions.includes('v3.1') ? 'v3.1' : DATA.versions[0];
selB.value = DATA.versions.includes('v2-lite') ? 'v2-lite' : DATA.versions[1];

function renderResult() {
  const a = selA.value, b = selB.value;
  const el = document.getElementById('result');
  const c = cellOf(a, b);

  if (a === b) {
    el.innerHTML = '<div class="headline"><span class="big">0.00</span>' +
      '<span class="verdict" style="color:var(--text-3)">mirror</span></div>' +
      '<p class="said">A version against three copies of itself on the same seeds cancels exactly: ' +
      'the four rotations of one seed sum to zero by construction. This cell is not played \\u2014 it is ' +
      'the definition of the statistic, and any harness that returns something else here is broken.</p>';
    paintGrid();
    return;
  }
  if (!c || c.games === 0) {
    el.innerHTML = '<div class="headline"><span class="big" style="color:var(--text-3)">\\u2014</span></div>' +
      '<p class="said">Not measured yet. Cells are played cheapest-first, so the pairings involving the ' +
      'slowest engines are the ones still outstanding.</p>';
    paintGrid();
    return;
  }

  const better = c.low > 0, worse = c.high < 0;
  const color = better ? 'var(--pos)' : worse ? 'var(--neg)' : 'var(--text-3)';
  const verdict = better ? a + ' is stronger' : worse ? b + ' is stronger' : 'no separation';
  const seats = Object.entries(c.perSeatAdvantage || {});
  const oppCost = DATA.cost[b], ownCost = DATA.cost[a];

  el.innerHTML =
    '<div class="headline">' +
      '<span class="big" style="color:' + color + '">' + fmt(c.advantage) + '</span>' +
      '<span class="ci">95% CI [' + fmt(c.low) + ', ' + fmt(c.high) + ']</span>' +
      '<span class="verdict" style="color:' + color + '">' + verdict + '</span>' +
    '</div>' +
    '<p class="said">Over ' + c.games + ' games on ' + c.seeds + ' seeds, <strong>' + a + '</strong> ' +
      'scored ' + fmt(c.advantage) + ' points against the mean of the three <strong>' + b + '</strong> ' +
      'seats it faced. ' +
      (better || worse
        ? 'The interval excludes zero, so this is a real difference at this budget.'
        : 'The interval covers zero \\u2014 at ' + c.seeds + ' seeds this does not resolve a difference.') +
    '</p>' +
    '<div class="stats">' +
      stat('Mean score', c.meanChallengerScore.toFixed(2), 'of a possible +15') +
      stat('First place', (c.firstPlaceRate * 100).toFixed(1) + '%', 'par is 25%') +
      stat('Sole wins', (c.soleWinRate * 100).toFixed(1) + '%', 'outright, no tie') +
      stat('Games', String(c.games), c.seeds + ' seeds \\u00d7 4 seats') +
      (ownCost && oppCost
        ? stat('Cost ratio', (ownCost / oppCost).toFixed(2) + '\\u00d7',
               ownCost + ' vs ' + oppCost + ' ms/move')
        : '') +
      stat('Wall clock', c.wallMinutes.toFixed(1) + ' min', 'to play this cell') +
    '</div>' +
    (seats.length
      ? '<div class="stats" style="margin-top:18px;padding-top:18px">' +
        seats.map(([s, v]) => stat(s + ' seat', fmt(v), '')).join('') + '</div>'
      : '');
  paintGrid();
}

function stat(k, v, s) {
  return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v +
         '</div><div class="s">' + s + '</div></div>';
}

function paintGrid() {
  const table = document.getElementById('grid');
  let html = '<tr><th></th>' + DATA.versions.map((v) => '<th class="col">' + v + '</th>').join('') + '</tr>';
  for (const a of DATA.versions) {
    html += '<tr><th class="row">' + a + '</th>';
    for (const b of DATA.versions) {
      const sel = a === selA.value && b === selB.value ? ' sel' : '';
      if (a === b) {
        html += '<td class="cell diag' + sel + '" style="background:var(--neutral)">\\u2014</td>';
        continue;
      }
      const c = cellOf(a, b);
      if (!c || c.games === 0) {
        html += '<td class="cell empty' + sel + '" data-a="' + a + '" data-b="' + b + '">\\u00b7</td>';
        continue;
      }
      const light = c.games < DATA.fullGames ? ' light' : '';
      html += '<td class="cell' + sel + light + '" tabindex="0" data-a="' + a + '" data-b="' + b + '" ' +
              'title="' + a + ' vs 3\\u00d7 ' + b + ': ' + fmt(c.advantage) + ' [' + fmt(c.low) + ', ' +
              fmt(c.high) + '], ' + c.games + ' games" ' +
              'style="background:' + colorFor(c.advantage) + '">' + fmt(c.advantage, 1) + '</td>';
    }
    html += '</tr>';
  }
  table.innerHTML = html;
  for (const td of table.querySelectorAll('td.cell[data-a]')) {
    const pick = () => { selA.value = td.dataset.a; selB.value = td.dataset.b; renderResult(); };
    td.addEventListener('click', pick);
    td.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  }
}

(function mixedNote() {
  const reduced = Object.values(DATA.cells).filter((c) => c.games > 0 && c.games < DATA.fullGames);
  if (reduced.length === 0) { return; }
  const n = Math.min(...reduced.map((c) => c.games));
  document.getElementById('mixed').innerHTML =
    '<span style="display:inline-block;width:0;height:0;border-left:5px solid transparent;' +
    'border-bottom:5px solid var(--text-3);opacity:.55;margin-right:6px"></span>' +
    reduced.length + ' cells at ' + n + ' games, not ' + DATA.fullGames;
})();

document.getElementById('ramp').style.background =
  'linear-gradient(to right, var(--neg), var(--neutral), var(--pos))';

(function costs() {
  const rows = DATA.versions.filter((v) => DATA.cost[v]).sort((x, y) => DATA.cost[x] - DATA.cost[y]);
  const max = Math.max(...rows.map((v) => DATA.cost[v]));
  document.getElementById('costs').innerHTML =
    '<tr><th>Version</th><th style="width:34%"></th><th style="text-align:right">ms / move</th><th>What it is</th></tr>' +
    rows.map((v) =>
      '<tr><td class="name">' + v + '</td>' +
      '<td><span class="bar" style="width:' + Math.max(2, (DATA.cost[v] / max) * 100) + '%"></span></td>' +
      '<td class="num">' + DATA.cost[v] + '</td>' +
      '<td style="color:var(--text-2)">' + (DATA.blurb[v] || '') + '</td></tr>').join('');
})();

selA.addEventListener('change', renderResult);
selB.addEventListener('change', renderResult);
renderResult();
</script>
`;

  const measured = played.length;
  const possible = versions.length * versions.length - versions.length;
  writeFileSync(
    outPath,
    html
      .replace(
        '<p class="meta" id="meta"></p>',
        (() => {
          const counts = [...new Set(played.map((c) => c.games))].sort((a, b) => b - a);
          const perCell =
            counts.length === 1
              ? `${counts[0]} games per cell`
              : `${counts.join(' / ')} games per cell`;
          return (
            `<p class="meta">${measured} of ${possible} pairings played · ` +
            `${totalGames.toLocaleString()} games · ${perCell} · ` +
            `${matrix.iterations ?? '—'} iterations/move · ` +
            `updated ${esc(matrix.updated.slice(0, 16).replace('T', ' '))}</p>`
          );
        })(),
      )
      .replace(
        '<footer id="foot"></footer>',
        `<footer>Each cell is the challenger's score minus the mean of the three opponent seats, ` +
          `bootstrapped over <em>seeds</em> rather than games — the four rotations of one seed are one ` +
          `observation, not four. The smallest detectable effect scales as 13.4/√seeds: about ` +
          `${(13.4 / Math.sqrt(Math.max(...played.map((c) => c.seeds), 1))).toFixed(1)} points in the ` +
          `${Math.max(...played.map((c) => c.games), 0)}-game cells and ` +
          `${(13.4 / Math.sqrt(Math.min(...played.map((c) => c.seeds), 1e9))).toFixed(1)} in the ` +
          `${Math.min(...played.map((c) => c.games), 0)}-game ones, which are notched in the grid. ` +
          `Cells below that floor are reported as no separation rather than as ties.</footer>`,
      ),
  );
  console.log(`${measured}/${possible} pairings, ${totalGames} games → ${outPath}`);
}

main();
