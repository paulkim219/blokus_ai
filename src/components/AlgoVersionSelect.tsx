import {
  DEFAULT_UI_ALGO_VERSION,
  UI_ALGO_VERSIONS,
  type UiAlgoVersion,
} from '../ai/algoVersions';

interface AlgoVersionSelectProps {
  value: string;
  onChange: (version: UiAlgoVersion) => void;
}

export function AlgoVersionSelect({ value, onChange }: AlgoVersionSelectProps) {
  const selected = UI_ALGO_VERSIONS.includes(value as UiAlgoVersion)
    ? value
    : DEFAULT_UI_ALGO_VERSION;

  return (
    <label className="algo-select">
      <span>Model</span>
      <select
        aria-label="Search version"
        value={selected}
        onChange={(event) => onChange(event.target.value as UiAlgoVersion)}
      >
        {UI_ALGO_VERSIONS.map((id) => (
          <option key={id} value={id}>
            {id === DEFAULT_UI_ALGO_VERSION ? `${id} (default)` : id}
          </option>
        ))}
      </select>
    </label>
  );
}
