import { Link } from 'react-router-dom';
import { ChartWell, GreedyParetoChart, V31ParetoChart, V32ProParetoChart } from '../components/Charts';
import {
  PROTOCOL_CAPTION,
  V31_PROTOCOL_CAPTION,
  V32_PRO_PROTOCOL_CAPTION,
  visibleModelIds,
  visibleVs31ModelIds,
  visibleVs32ProModelIds,
} from '../data/benchmarks';
import { PLAY_BLOKUS_URL } from '../data/models';
import { usePageTitle } from '../hooks/usePageTitle';

export function HomePage() {
  usePageTitle('Art of Blokus');

  return (
    <>
      <section className="hero">
        <p className="kicker">A journal of four-player play</p>
        <h1>Art of Blokus</h1>
        <p className="lede">
          Hanni is an artificial intelligence built to beat four-player Blokus. The game is a 20×20
          board, four seats, and twenty-one polyominoes each. You score the squares you place, not a
          binary win, and the tree is wide, then suddenly narrow.
        </p>
        <p>
          This site is the public record of that work: how each Hanni was made, what it costs per
          move, and how it compares with the engines that came before it.
        </p>
        <div className="cta-row">
          <Link className="btn btn-primary" to="/models/hanni-3-2-pro">
            Read about Hanni 3.2 Pro
          </Link>
          <Link className="btn btn-ghost" to="/research">
            Research
          </Link>
          <a className="btn btn-ghost" href={PLAY_BLOKUS_URL} rel="noreferrer">
            Play Blokus
          </a>
        </div>
      </section>

      <div className="champion-strip">
        <Link className="champion-card" to="/models/hanni-3-2-pro">
          <div>
            <p className="kicker">Current champion</p>
            <h2>Hanni 3.2 Pro</h2>
            <p>
              The 3.1 Pro search shell, with 60% of terminal-rollout moves sampled uniformly. Pooled
              +0.88 against Hanni 3.1 Pro Max at the same iteration budget — a strength release, not
              a larger tree.
            </p>
          </div>
          <div>
            <div className="stat">
              +0.88
              <span>vs Hanni 3.1 Pro Max · 560 games</span>
            </div>
          </div>
        </Link>
      </div>

      <section className="section">
        <h2>Why this project exists</h2>
        <p>
          The aim is not only to play Blokus well. It is to know <em>why</em> strength moved. Across
          this lineage, how a leaf’s value is obtained and how the evaluation is fitted decide
          outcomes. Tree-policy gadgets — selection rules, widening, transpositions, learned priors —
          mostly do not.
        </p>
        <p>
          That allocation of effort was backwards in the first written design, which spent most of
          its length on architecture and a clause on weights. Measurement reversed it. The pages
          here keep that order: what changed, then the numbers that survived a held-out test.
        </p>
      </section>

      <section className="section">
        <h2>Lineage</h2>
        <ol className="timeline">
          <li>
            <Link to="/models/hanni-1">Hanni 1</Link>
            <p>Hand-tuned Monte-Carlo tree search. The baseline later results are quoted against.</p>
          </li>
          <li>
            <Link to="/models/hanni-2-lite">Hanni 2</Link>
            <p>
              Cross-entropy fitting on about 46,000 games, then full-length rollouts in Pro. Former
              champion, still the expensive quality bar.
            </p>
          </li>
          <li>
            <Link to="/models/hanni-3-1">Hanni 3.1</Link>
            <p>
              Bitboard engine, fitted evaluation, full rollouts, then compute tiers. Pro is the first
              configuration in this line to beat Hanni 2 Pro, at about a quarter of the time.
            </p>
          </li>
          <li>
            <Link to="/models/hanni-3-2-pro">Hanni 3.2</Link>
            <p>Same tiers; 60% uniform moves inside terminal rollouts.</p>
          </li>
          <li>
            <Link to="/models/hanni-3-7-pro">Hanni 3.7</Link>
            <p>
              No tree on a seat’s first three placements. Stronger and cheaper than the move-curve
              generation it sits on.
            </p>
          </li>
          <li>
            <Link to="/models/hanni-4-1-pro">Hanni 4.1</Link>
            <p>
              A learned rollout-policy table on the 3.2 budgets plus the 3.7 opening shortcut.
              Beats the matched Hanni 3.1 tier more cheaply. Not a claim that the student adds
              strength, and not a claim over Hanni 3.7.
            </p>
          </li>
          <li>
            <Link to="/models/hanni-4">Hanni 4</Link>
            <p>Learned evaluation as a leaf. In progress, and not a shipping release.</p>
          </li>
        </ol>
      </section>

      <section className="section wide">
        <h2>Strength at a given cost</h2>
        <p>
          Every shipping Hanni against the same floor: three one-ply greedy seats. Cost is
          milliseconds per move measured in those games, decreasing to the right. Effort tiers of
          one generation are a connected range. The dotted segment is Hanni 3.5 Pro to 3.6 Pro Max:
          the same move-curve design at max effort. Top-right is stronger than greedy and cheaper.
          The second chart is the same engines, excluding Hanni 3.1, against three Hanni 3.1 seats.
          Zero is that floor: below it loses, above it wins. The third raises the floor again to
          Hanni 3.2 Pro, because the strongest tiers crowd together against a reference they both
          beat comfortably; Hanni 3.2 Pro is plotted at zero so its own cost is on the same axis.
        </p>
        <ChartWell title="Hanni versus greedy" caption={PROTOCOL_CAPTION}>
          <GreedyParetoChart ids={visibleModelIds('4.1')} />
        </ChartWell>
        <ChartWell title="Hanni versus Hanni 3.1" caption={V31_PROTOCOL_CAPTION}>
          <V31ParetoChart ids={visibleVs31ModelIds('4.1')} />
        </ChartWell>
        <ChartWell title="Hanni versus Hanni 3.2 Pro" caption={V32_PRO_PROTOCOL_CAPTION}>
          <V32ProParetoChart ids={visibleVs32ProModelIds('4.1')} />
        </ChartWell>
      </section>
    </>
  );
}
