interface MoveQualityChipProps {
  label: 'best' | 'blunder';
}

export function MoveQualityChip({ label }: MoveQualityChipProps) {
  return <div className={`quality-chip ${label}`}>{label}</div>;
}
