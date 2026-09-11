import { Link } from 'react-router-dom';
import { TruncationChart } from '../components/Charts';
import { ESSAYS } from '../data/essays';
import { usePageTitle } from '../hooks/usePageTitle';

export function ResearchPage() {
  usePageTitle('Research · Art of Blokus');

  return (
    <>
      <header className="hero">
        <p className="kicker">Research</p>
        <h1>What we actually know</h1>
        <p className="lede">
          Hanni is measured, not declared. The pages below are rewritten from the internal reports so
          they can be read without the laboratory ids. Claims that did not survive a held-out test
          are labelled as such.
        </p>
      </header>

      <section className="section">
        <h2>The finding</h2>
        <p>
          Leaf estimation and fitted weights decide outcomes. Tree policy, in this implementation,
          barely registers. Playing rollouts to the end rather than cutting them at twelve plies is
          worth about +4.7 points at equal compute. Fitting the evaluation by self-play is worth
          about +4.5. Most of the architectural catalogue is noise around those two facts.
        </p>
        <div className="finding-grid">
          <div>
            <strong>+4.7</strong>
            Full rollouts vs 12-ply truncation
          </div>
          <div>
            <strong>+4.5</strong>
            CEM-fitted weights, same features
          </div>
          <div>
            <strong>+2.01</strong>
            Hanni 3.1 Pro vs 2 Pro, quarter the time
          </div>
        </div>
      </section>

      <section className="section wide">
        <h2>Rollout truncation</h2>
        <p>
          The written design argued that short playouts were informative because the scoring rule is
          simple, then truncated them after three moves per seat. Sweeping the cutoff showed that
          argument was expensive.
        </p>
        <div className="chart-panel">
          <p className="chart-caption">Advantage versus a 12-ply baseline, same engine. First-place rate rises from 25% to 52% when the simulation is allowed to finish.</p>
          <TruncationChart />
        </div>
      </section>

      <section className="section">
        <h2>Measurement</h2>
        <p>
          The challenger sits in each of the four seats on every seed. The statistic is score minus
          the mean of the other three. Intervals are bootstrap 95%. Fitting seeds are not confirmation
          seeds. Promote only after a result reproduces. Screens that look good at sixteen or forty
          seeds are hypotheses.
        </p>
      </section>

      <section className="section">
        <h2>Compute</h2>
        <p>
          Hanni 3.1 Pro beats Hanni 2 Pro by +2.01 [1.00, 3.02] over 400 held-out games at about 360
          milliseconds per move against about 1,498. The earlier story that the bitboard line had
          hit a design ceiling was an artifact of matching on iterations instead of wall-clock.
        </p>
      </section>

      <section className="section">
        <h2>Hanni 3.2</h2>
        <p>
          Raising the uniform branch inside terminal rollouts from 15% to 60% produced a champion
          line. An ensemble of two trees scored −2.99. MAST, RAVE, and variance-tuned
          selection collapsed under larger blocks. Failed ideas stay on this page because they
          constrain the next ones.
        </p>
      </section>

      <section className="section">
        <h2>Hanni 4.1</h2>
        <p>
          A compiled rollout-policy table on the 3.2 budgets plus the 3.7 opening shortcut. It beats
          Hanni 3.1 Pro by +1.13 [0.51, 1.74] over 140 reproduced seeds, more cheaply. Removing only
          the table leaves that gain intact, so this is a foundation for later students, not
          evidence that the first one works.
        </p>
      </section>

      <section className="section">
        <h2>What failed</h2>
        <p>
          The unpublished design draft sat behind a fitted incumbent until its weights were learned
          and its rollouts were allowed to finish. A withdrawn parity claim had compared two
          truncated engines. Hanni 4 as a value leaf lost by more than ten points. Those are
          results, not footnotes.
        </p>
      </section>

      <section className="section">
        <h2>Essays</h2>
        <div className="related">
          {ESSAYS.map((essay) => (
            <Link key={essay.slug} className="essay-card" to={`/research/${essay.slug}`}>
              <span className="meta">{essay.kicker}</span>
              <strong>{essay.title}</strong>
              <p>{essay.lede}</p>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
