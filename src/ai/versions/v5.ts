import type { AlgoConfig, AlgoVersionId, OracleSearchConfig } from '../algoVersions';
import type { OracleProfileMode } from '../oracle/types';
import { V4_VERSIONS } from './v4';

const RESPONSE: Omit<OracleSearchConfig, 'profileMode'> = {
  baseVersion: 'v4.1',
  temperature: 0.6,
  minimumObservations: 3,
  rootCandidates: 6,
  replyWidth: 3,
  beamWidth: 6,
  baseSearchFraction: 0.65,
  responseBlend: 0.25,
  riskWeight: 0.1,
  responseEvaluator: 'static',
  terminalRollouts: 0,
  responseMode: 'absoluteBeam',
  scenarioCount: 0,
  responseVisitScale: 4,
};

function oneLap(
  id: AlgoVersionId,
  profileMode: OracleProfileMode,
  overrides: Partial<OracleSearchConfig> = {},
): AlgoConfig {
  const base = V4_VERSIONS['v4.1'];
  return {
    ...base,
    id,
    summary:
      `Experimental v5 Oracle one-lap response search over v4.1 using the ${profileMode} ` +
      'opponent-profile control. Not a promoted release.',
    engine: 'oracle',
    oracle: { ...RESPONSE, ...overrides, profileMode },
  };
}

/** Experiment D arms. Only the posterior source differs between the three versions. */
export const V5_VERSIONS: Record<AlgoVersionId, AlgoConfig> = {
  'v5-oracle-one-lap': oneLap('v5-oracle-one-lap', 'personalized'),
  'v5-oracle-one-lap-fixed': oneLap('v5-oracle-one-lap-fixed', 'fixed'),
  'v5-oracle-one-lap-shuffled': oneLap('v5-oracle-one-lap-shuffled', 'shuffled'),
  'v5-oracle-terminal': oneLap('v5-oracle-terminal', 'personalized', {
    responseEvaluator: 'terminal',
    terminalRollouts: 3,
  }),
  'v5-oracle-terminal-fixed': oneLap('v5-oracle-terminal-fixed', 'fixed', {
    responseEvaluator: 'terminal',
    terminalRollouts: 3,
  }),
  'v5-oracle-terminal-shuffled': oneLap('v5-oracle-terminal-shuffled', 'shuffled', {
    responseEvaluator: 'terminal',
    terminalRollouts: 3,
  }),
  'v5-oracle-budget65': oneLap('v5-oracle-budget65', 'fixed', {
    responseBlend: 0,
  }),
  'v5-oracle-counterfactual': oneLap('v5-oracle-counterfactual', 'personalized', {
    baseSearchFraction: 1,
    responseEvaluator: 'terminal',
    terminalRollouts: 1,
    responseMode: 'counterfactualSample',
    scenarioCount: 12,
    riskWeight: 0,
  }),
  'v5-oracle-counterfactual-fixed': oneLap('v5-oracle-counterfactual-fixed', 'fixed', {
    baseSearchFraction: 1,
    responseEvaluator: 'terminal',
    terminalRollouts: 1,
    responseMode: 'counterfactualSample',
    scenarioCount: 12,
    riskWeight: 0,
  }),
  'v5-oracle-counterfactual-shuffled': oneLap(
    'v5-oracle-counterfactual-shuffled',
    'shuffled',
    {
      baseSearchFraction: 1,
      responseEvaluator: 'terminal',
      terminalRollouts: 1,
      responseMode: 'counterfactualSample',
      scenarioCount: 12,
      riskWeight: 0,
    },
  ),
};
