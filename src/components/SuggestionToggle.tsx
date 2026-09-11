interface SuggestionToggleProps {
  enabled: boolean;
  forAll: boolean;
  onChangeEnabled: (enabled: boolean) => void;
  onChangeForAll: (forAll: boolean) => void;
}

export function SuggestionToggle({
  enabled,
  forAll,
  onChangeEnabled,
  onChangeForAll,
}: SuggestionToggleProps) {
  return (
    <div className="suggestion-toggles">
      <label className="toggle">
        <button
          type="button"
          className={`toggle-switch ${enabled ? 'on' : ''}`}
          aria-pressed={enabled}
          onClick={() => onChangeEnabled(!enabled)}
        />
        <span>Suggestions {enabled ? 'on' : 'off'}</span>
      </label>

      {enabled ? (
        <label className="toggle">
          <button
            type="button"
            className={`toggle-switch ${forAll ? 'on' : ''}`}
            aria-pressed={forAll}
            onClick={() => onChangeForAll(!forAll)}
          />
          <span>{forAll ? 'All players' : 'My player only'}</span>
        </label>
      ) : null}
    </div>
  );
}
