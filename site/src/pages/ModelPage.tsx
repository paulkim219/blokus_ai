import { Link, Navigate, useParams } from 'react-router-dom';
import {
  ChartWell,
  GreedyParetoChart,
  ScoreDeltaChart,
  V31ParetoChart,
} from '../components/Charts';
import {
  CROP_CAPTION,
  PROTOCOL_CAPTION,
  V31_PROTOCOL_CAPTION,
  hasPublicTrajectories,
  predecessorTrajectory,
  visibleModelIds,
  visibleVs31ModelIds,
} from '../data/benchmarks';
import { displayNameOf, isModelId, MODELS, type ModelId } from '../data/models';
import { usePageTitle } from '../hooks/usePageTitle';

function statusLabel(status: (typeof MODELS)[ModelId]['status']): string {
  if (status === 'champion') return 'Shipping champion';
  if (status === 'coming-soon') return 'Coming soon';
  if (status === 'baseline') return 'Baseline';
  return 'Shipping';
}

export function ModelPage() {
  const { id } = useParams();
  const model = isModelId(id) ? MODELS[id] : undefined;
  usePageTitle(model ? `${model.displayName} · Art of Blokus` : 'Art of Blokus');

  if (!id || !isModelId(id) || !model) {
    return <Navigate to="/" replace />;
  }

  const comingSoon = model.status === 'coming-soon';
  const visible = visibleModelIds(model.generation);
  const ready = hasPublicTrajectories(visible);
  const predecessors = model.comparators.filter(
    (opponent) => !(opponent === 'greedy' && visible.length === 1),
  );

  return (
    <>
      <header className="model-hero">
        <p className="kicker">{model.kicker}</p>
        <h1>{model.displayName}</h1>
        <p className="lede">{model.lede}</p>
        <div className="status-row">
          <span className={model.status === 'champion' ? 'chip champion' : model.status === 'coming-soon' ? 'chip coming' : 'chip'}>
            {statusLabel(model.status)}
          </span>
          {model.costMsPerMove != null ? (
            <span className="chip">~{model.costMsPerMove} ms / move</span>
          ) : null}
          <span className="chip">
            {model.engine === 'legacy'
              ? 'Object-board search'
              : model.engine === 'bitboard'
                ? 'Bitboard search'
                : 'Learned evaluation'}
          </span>
        </div>
      </header>

      <section className="section">
        <h2>How it was created</h2>
        <p>{model.created}</p>
        {model.generation === '4.1' ? (
          <p>
            <Link to="/research/hanni-4-1">Read the research note on Hanni 4.1.</Link>
          </p>
        ) : null}
      </section>

      {comingSoon ? (
        <section className="section">
          <h2>What the measurements say</h2>
          <p>
            Replacing the rollout with the distilled leaf scored −10.62 against Hanni 3.1 over 100
            games. Policy-only priors have not cleared a held-out promotion gate. There is no
            efficiency claim attached to that cost: a cheap leaf that loses by ten points is not a
            better engine.
          </p>
          <p>
            <Link to="/research/hanni-4">Read the research note on Hanni 4.</Link>
          </p>
        </section>
      ) : (
        <section className="section wide">
          <h2>Benchmarks</h2>
          <p>
            Every shipping Hanni is measured against the same floor: three one-ply greedy seats.
            Later pages overlay every earlier generation. This page shows{' '}
            {visible.map((visibleId) => MODELS[visibleId].displayName).join(', ')}.
          </p>
          <p className="measure-note">
            {PROTOCOL_CAPTION} {CROP_CAPTION}
          </p>
          <ChartWell
            title="Over the game"
            caption="Own-moves 16–21. The band is the 95% bootstrap interval on this page’s engine. The dashed line is the greedy floor."
          >
            <ScoreDeltaChart ids={visible} featured={model.id} />
          </ChartWell>
          <ChartWell
            title="At a given cost"
            caption="Final score delta versus greedy, against wall-clock milliseconds per move measured in the same games. Cost decreases to the right. A generation’s effort tiers are a connected range. The dotted segment joins 3.5 Pro to 3.6 Pro Max, the same architecture at max effort. Hover a point for the configuration."
          >
            <GreedyParetoChart ids={visible} featured={model.id} />
          </ChartWell>
          <ChartWell
            title="At a given cost versus Hanni 3.1"
            caption={`Final score delta versus Hanni 3.1, against wall-clock milliseconds per move measured in the same games. Cost decreases to the right. ${V31_PROTOCOL_CAPTION} Hover a point for the configuration.`}
          >
            <V31ParetoChart ids={visibleVs31ModelIds(model.generation)} featured={model.id} />
          </ChartWell>
          {!ready ? (
            <p className="measure-note">
              Charts stay empty until the 400-game vs-greedy block for a visible engine is on disk.
              Numbers are never interpolated.
            </p>
          ) : null}

          {predecessors.length > 0 ? (
            <>
              <h3 className="bench-subhead">Direct predecessors</h3>
              <p className="measure-note">
                Each chart is this engine minus the mean of three predecessor seats, seat-rotated,
                400 games. Unmeasured pairs stay blank rather than guessed.
              </p>
              {predecessors.map((opponent) => {
                const row = predecessorTrajectory(model.id, opponent);
                const name = displayNameOf(opponent);
                return (
                  <ChartWell
                    key={String(opponent)}
                    title={`vs ${name}`}
                    caption={`Own-moves 16–21. Score minus the mean of three ${name} seats.`}
                  >
                    <ScoreDeltaChart
                      series={row ? [{ id: model.id, row }] : []}
                      featured={model.id}
                      axisLabel={`Score Δ vs ${name}`}
                      empty={`400-game vs-${name} trajectories are not on disk yet.`}
                    />
                  </ChartWell>
                );
              })}
            </>
          ) : null}
        </section>
      )}

      <section className="section">
        <h2>What changed</h2>
        <p>{model.changed}</p>
      </section>

      <section className="section">
        <h2>Related</h2>
        <div className="related">
          {model.related.map((relatedId) => {
            const related = MODELS[relatedId];
            return (
              <Link key={relatedId} to={`/models/${relatedId}`}>
                <span className="meta">{related.kicker}</span>
                <strong>{related.displayName}</strong>
                <p>{related.lede}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
