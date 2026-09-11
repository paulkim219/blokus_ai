import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Renders `selfplay-results/trajectories.json` into a self-contained HTML report.
 *
 * Form choice: score-over-ply is change-over-time → line charts, as small multiples so the six
 * matchups share one y scale and can be compared by eye. Compute cost is magnitude across a few
 * named things → a horizontal bar chart. Palette is the validated categorical slots 1 and 2
 * (blue/orange), which pass all six checks on both the light and dark surfaces.
 */

interface Result {
  label: string;
  heroVersion: string;
  heroPolicy: string;
  opponentVersion: string;
  opponentPolicy: string;
  games: number;
  iterations: number | null;
  hero: number[];
  opponents: number[];
  heroMsPerMove: number;
  opponentMsPerMove: number;
  finalHero: number;
  finalOpponents: number;
}

const W = 380;
const H = 230;
const M = { top: 16, right: 46, bottom: 32, left: 40 };

function path(values: number[], xs: (i: number) => number, ys: (v: number) => number): string {
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join('');
}

function chart(r: Result, yMin: number, yMax: number, maxPly: number): string {
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const xs = (i: number) => M.left + (i / Math.max(1, maxPly - 1)) * iw;
  const ys = (v: number) => M.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const yTicks = [0, -20, -40, -60, -80].filter((t) => t >= yMin && t <= yMax);
  const grid = yTicks
    .map(
      (t) =>
        `<line class="grid" x1="${M.left}" x2="${M.left + iw}" y1="${ys(t).toFixed(1)}" y2="${ys(t).toFixed(1)}"/>` +
        `<text class="tick" x="${M.left - 8}" y="${(ys(t) + 4).toFixed(1)}" text-anchor="end">${t}</text>`,
    )
    .join('');
  const xTicks = [0, 5, 10, 15, 20].filter((t) => t < maxPly);
  const xAxis = xTicks
    .map((t) => `<text class="tick" x="${xs(t).toFixed(1)}" y="${H - 10}" text-anchor="middle">${t}</text>`)
    .join('');

  const heroEnd = r.hero[r.hero.length - 1];
  const oppEnd = r.opponents[r.opponents.length - 1];
  const endX = xs(r.hero.length - 1);
  // nudge the two end labels apart when the final scores nearly coincide
  const collide = Math.abs(ys(heroEnd) - ys(oppEnd)) < 14;
  const heroLabelY = ys(heroEnd) + (collide ? -6 : 4);
  const oppLabelY = ys(oppEnd) + (collide ? 14 : 4);

  return `<figure class="card">
  <figcaption>
    <span class="card-title">${r.label}</span>
    <span class="card-sub">${r.games} games · ${r.iterations ?? '—'} iterations/move</span>
  </figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${r.label}: score per turn"
       data-hero="${r.hero.join(',')}" data-opp="${r.opponents.join(',')}"
       data-xmin="${M.left}" data-xmax="${M.left + iw}" data-n="${r.hero.length}">
    ${grid}${xAxis}
    <path class="s2" d="${path(r.opponents, xs, ys)}"/>
    <path class="s1" d="${path(r.hero, xs, ys)}"/>
    <circle class="dot s2f" cx="${endX.toFixed(1)}" cy="${ys(oppEnd).toFixed(1)}" r="4"/>
    <circle class="dot s1f" cx="${endX.toFixed(1)}" cy="${ys(heroEnd).toFixed(1)}" r="4"/>
    <text class="endlabel" x="${(endX + 8).toFixed(1)}" y="${heroLabelY.toFixed(1)}">${heroEnd.toFixed(1)}</text>
    <text class="endlabel dim" x="${(endX + 8).toFixed(1)}" y="${oppLabelY.toFixed(1)}">${oppEnd.toFixed(1)}</text>
    <g class="cross" hidden><line class="crossline" y1="${M.top}" y2="${M.top + ih}"/></g>
    <rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}" fill="transparent"/>
  </svg>
  <div class="tip" hidden></div>
</figure>`;
}

function costBars(rows: Array<{ name: string; ms: number; note: string }>): string {
  const max = Math.max(...rows.map((r) => r.ms));
  return rows
    .map((r) => {
      const pct = (r.ms / max) * 100;
      return `<div class="costrow">
      <div class="costname">${r.name}</div>
      <div class="costtrack"><div class="costbar" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="costval">${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms</div>
      <div class="costnote">${r.note}</div>
    </div>`;
    })
    .join('');
}

/** Properly-measured, seat-rotated results for the pairings that have one. */
const MEASURED: Record<string, string> = {
  'v2-pro vs 3× v1': 'vs v2-lite: +5.89 [4.72, 7.08], 100 seeds',
  'v3.1 vs 3× v3': '+2.20 [1.79, 2.61], 400 seeds (eval level)',
};

function main(): void {
  const inPath = process.argv[2] ?? 'selfplay-results/trajectories.json';
  const outPath = process.argv[3] ?? 'selfplay-results/engine-report.html';
  const data = JSON.parse(readFileSync(inPath, 'utf8')) as { results: Result[] };
  const results = data.results;

  const all = results.flatMap((r) => [...r.hero, ...r.opponents]);
  const yMin = Math.floor(Math.min(...all) / 10) * 10;
  const yMax = Math.max(5, Math.ceil(Math.max(...all) / 5) * 5);
  const maxPly = Math.max(...results.map((r) => r.hero.length));

  // per-engine cost: each engine's own ms/move, taken from the matchup where it is the hero
  const costs = new Map<string, number>();
  for (const r of results) {
    costs.set(r.heroVersion, r.heroMsPerMove);
    if (r.opponentPolicy === 'greedy') {
      costs.set('greedy policy', r.opponentMsPerMove);
    }
  }
  const noteFor: Record<string, string> = {
    'greedy policy': 'evaluation only, no tree',
    v1: 'best of generation 1',
    'v2-lite': 'fitted evaluation, truncated rollouts',
    'v2-pro': 'same evaluation, rollouts played out — champion',
    v3: 'research report as implemented',
    'v3.1-lite': 'tuned v3 evaluation, truncated rollouts',
    'v3.1': 'same evaluation, rollouts played out',
  };
  const order = ['greedy policy', 'v1', 'v2-lite', 'v2-pro', 'v3', 'v3.1-lite', 'v3.1'];
  const costRows = order
    .filter((n) => costs.has(n))
    .map((n) => ({ name: n, ms: costs.get(n)!, note: noteFor[n] ?? '' }));

  const tableRows = results
    .map(
      (r) => `<tr><td>${r.label}</td><td class="num">${r.finalHero.toFixed(1)}</td>
      <td class="num">${r.finalOpponents.toFixed(1)}</td>
      <td class="num">${(r.finalHero - r.finalOpponents).toFixed(1)}</td>
      <td class="num">${Math.round(r.heroMsPerMove)}</td>
      <td class="num">${r.opponentMsPerMove < 10 ? r.opponentMsPerMove.toFixed(1) : Math.round(r.opponentMsPerMove)}</td>
      <td class="measured">${MEASURED[r.label] ?? '—'}</td></tr>`,
    )
    .join('');

  const html = `<title>Blokus Engine Generations</title>
<style>
  /* Tokens live on :root so <body> can paint from them — the artifact composites over a ground the
     viewer paints in its own theme, and a transparent body silently borrows it. */
  :root{
    color-scheme:light;
    --surface-1:#fcfcfb; --surface-2:#f4f3f0; --line:#e2e1dc;
    --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#78776f;
    --series-1:#2a78d6; --series-2:#eb6834;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    color-scheme:dark;
    --surface-1:#1a1a19; --surface-2:#232322; --line:#3a3a37;
    --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8e8d84;
    --series-1:#3987e5; --series-2:#d95926;
  }}
  :root[data-theme="dark"]{
    color-scheme:dark;
    --surface-1:#1a1a19; --surface-2:#232322; --line:#3a3a37;
    --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8e8d84;
    --series-1:#3987e5; --series-2:#d95926;
  }
  body{background:var(--surface-1);color:var(--text-primary);margin:0}
  .viz-root{
    font-family:var(--sans);
    background:var(--surface-1); color:var(--text-primary);
    padding:32px 24px 56px; margin:0 auto; max-width:1180px;
  }
  h1{font-size:24px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
  .lede{color:var(--text-secondary);font-size:14px;line-height:1.6;margin:0 0 4px;max-width:76ch}
  h2{font-size:15px;margin:40px 0 4px;letter-spacing:.02em;text-transform:uppercase;color:var(--text-muted)}
  .h2sub{color:var(--text-secondary);font-size:13.5px;line-height:1.6;margin:0 0 18px;max-width:76ch}
  .legend{display:flex;gap:20px;align-items:center;margin:22px 0 4px;font-size:13px;color:var(--text-secondary)}
  .key{display:inline-flex;align-items:center;gap:7px}
  .swatch{width:14px;height:3px;border-radius:2px;display:inline-block}
  .grid-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:14px}
  .card{margin:0;background:var(--surface-2);border-radius:12px;padding:14px 12px 6px;position:relative}
  figcaption{display:flex;flex-direction:column;gap:2px;padding:0 4px 6px}
  .card-title{font-size:14px;font-weight:600}
  .card-sub{font-size:11.5px;color:var(--text-muted)}
  svg{width:100%;height:auto;display:block;overflow:visible}
  .grid{stroke:var(--line);stroke-width:1}
  .tick{fill:var(--text-muted);font-size:10px;font-family:var(--mono)}
  .s1{fill:none;stroke:var(--series-1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .s2{fill:none;stroke:var(--series-2);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .dot{stroke:var(--surface-2);stroke-width:2}
  .s1f{fill:var(--series-1)} .s2f{fill:var(--series-2)}
  .endlabel{fill:var(--text-primary);font-size:11px;font-weight:600;font-family:var(--mono)}
  .endlabel.dim{fill:var(--text-secondary);font-weight:500}
  .crossline{stroke:var(--text-muted);stroke-width:1;opacity:.45}
  .tip{position:absolute;pointer-events:none;background:var(--surface-1);border:1px solid var(--line);
       border-radius:8px;padding:7px 9px;font-size:11.5px;line-height:1.5;color:var(--text-primary);
       box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap;z-index:5}
  .tip b{font-weight:600}
  .costrow{display:grid;grid-template-columns:112px 1fr 62px 1fr;gap:12px;align-items:center;
           padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
  .costname{font-weight:600;font-family:var(--mono);font-size:12.5px}
  .costtrack{background:var(--line);height:9px;border-radius:5px;overflow:hidden}
  .costbar{background:var(--series-1);height:100%;border-radius:5px}
  .costval{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);
          font-size:12.5px;color:var(--text-secondary)}
  .costnote{color:var(--text-muted);font-size:12px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
  .num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
  .tablewrap{overflow-x:auto}
  .measured{font-size:12px}
  .foot{color:var(--text-muted);font-size:12px;line-height:1.65;margin-top:26px;max-width:76ch}
  .warn{font-size:13px;line-height:1.6;color:var(--text-secondary);max-width:76ch;margin:14px 0 0;
        padding:10px 13px;border-left:3px solid var(--series-2);background:var(--surface-2);border-radius:0 8px 8px 0}
  .measured{color:var(--text-secondary)}
  @media (max-width:560px){.costrow{grid-template-columns:100px 1fr 56px;}.costnote{display:none}}
</style>
<div class="viz-root">
  <h1>Blokus engine generations</h1>
  <p class="lede">Blokus scores <b>−(squares still in hand)</b>, so every game starts at −89 and climbs toward 0 as
  pieces go down. Where a line flattens is where that engine ran out of places to put things — which is why the
  interesting part of each panel is the last third, not the first. The x axis counts a player's own turns, not
  plies, so one step is one placement.</p>
  <p class="lede">Each panel is one engine (blue) against three opponents (orange, averaged), mean of ${results[0]?.games ?? 0} games.</p>
  <p class="warn"><b>Read the shapes, not the margins.</b> ${results[0]?.games ?? 0} games resolves an effect of about
  ±4.7 points, so the end-of-game gaps here are illustrative. The measured head-to-heads come from
  seat-rotated runs of 400–1600 games and are quoted in the table below where they exist.</p>

  <div class="legend">
    <span class="key"><span class="swatch" style="background:var(--series-1)"></span> engine under test</span>
    <span class="key"><span class="swatch" style="background:var(--series-2)"></span> mean of its three opponents</span>
  </div>

  <div class="grid-cards">${results.map((r) => chart(r, yMin, yMax, maxPly)).join('')}</div>

  <h2>Compute cost per move</h2>
  <p class="h2sub">Measured at the same iteration budget, so these are like-for-like. This is what the
  <b>lite</b> / <b>pro</b> suffixes encode: a pro shares its sibling's evaluation exactly and differs only in
  playing its rollouts to the end instead of truncating them — more time per move, materially stronger play.</p>
  ${costBars(costRows)}

  <h2>Final scores</h2>
  <p class="h2sub">The same data as the panels, at the last turn.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Matchup</th><th class="num">Engine</th><th class="num">Opponents</th>
    <th class="num">Margin (n=${results[0]?.games ?? 0})</th><th class="num">ms/move</th><th class="num">opp ms/move</th>
    <th>Measured separately</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table></div>

  <p class="foot">Curves are means over ${results[0]?.games ?? 0} seeded games per matchup; each game's final score is
  carried forward past its own last turn, so every game contributes at every x position — otherwise the tail would
  average only the long games, which are exactly the ones where somebody still had space.</p>
</div>
<script>
  for (const fig of document.querySelectorAll('.card')) {
    const svg = fig.querySelector('svg'), tip = fig.querySelector('.tip');
    const cross = svg.querySelector('.cross'), line = svg.querySelector('.crossline');
    const hero = svg.dataset.hero.split(',').map(Number);
    const opp = svg.dataset.opp.split(',').map(Number);
    const x0 = +svg.dataset.xmin, x1 = +svg.dataset.xmax, n = +svg.dataset.n;
    svg.querySelector('.hit').addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const vx = ((e.clientX - box.left) / box.width) * vb.width;
      const i = Math.max(0, Math.min(n - 1, Math.round(((vx - x0) / (x1 - x0)) * (n - 1))));
      const px = x0 + (i / (n - 1)) * (x1 - x0);
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      cross.removeAttribute('hidden');
      tip.innerHTML = '<b>turn ' + i + '</b><br>engine ' + hero[i].toFixed(1) + '<br>opponents ' + opp[i].toFixed(1);
      tip.removeAttribute('hidden');
      const rel = (px / vb.width) * box.width;
      tip.style.left = Math.min(box.width - 118, Math.max(0, rel + 10)) + 'px';
      tip.style.top = '46px';
    });
    svg.querySelector('.hit').addEventListener('pointerleave', () => {
      cross.setAttribute('hidden', ''); tip.setAttribute('hidden', '');
    });
  }
</script>`;
  writeFileSync(outPath, html);
  console.log(`wrote ${outPath}`);
}

main();
