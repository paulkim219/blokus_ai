import { useState } from 'react';
import type { OpeningMode, PlayerColor } from '../engine/types';
import { COLOR_LABELS, PLAYER_COLORS } from '../engine/types';

interface SetupModalProps {
  onStart: (config: {
    userColor: PlayerColor;
    userName: string;
    openingMode: OpeningMode;
  }) => void;
}

const COLOR_VARS: Record<PlayerColor, string> = {
  blue: 'var(--blue)',
  yellow: 'var(--yellow)',
  purple: 'var(--purple)',
  green: 'var(--green)',
};

export function SetupModal({ onStart }: SetupModalProps) {
  const [userColor, setUserColor] = useState<PlayerColor>('blue');
  const [userName, setUserName] = useState('You');
  const [openingMode, setOpeningMode] = useState<OpeningMode>('corner');

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h1>Blokee</h1>
        <p>Reconstruct a four-player Blokus game and review where your moves could have been stronger.</p>

        <label htmlFor="player-name">Display name</label>
        <input
          id="player-name"
          value={userName}
          onChange={(event) => setUserName(event.target.value)}
          style={{ width: '100%', marginTop: '0.35rem', padding: '0.55rem' }}
        />

        <p style={{ marginTop: '1rem', marginBottom: '0.35rem' }}>Your seat color</p>
        <div className="color-picker">
          {PLAYER_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`color-option ${userColor === color ? 'selected' : ''}`}
              onClick={() => setUserColor(color)}
            >
              <span className="color-dot" style={{ background: COLOR_VARS[color] }} />
              {COLOR_LABELS[color]}
            </button>
          ))}
        </div>

        <p style={{ marginTop: '0.25rem', marginBottom: '0.35rem' }}>Opening mode</p>
        <div className="mode-picker">
          <button
            type="button"
            className={`mode-option ${openingMode === 'corner' ? 'selected' : ''}`}
            onClick={() => setOpeningMode('corner')}
          >
            <strong>Corner</strong>
            <span>First piece must cover your start corner.</span>
          </button>
          <button
            type="button"
            className={`mode-option ${openingMode === 'anywhere' ? 'selected' : ''}`}
            onClick={() => setOpeningMode('anywhere')}
          >
            <strong>Anywhere</strong>
            <span>First piece can sit anywhere fully inside your quarter.</span>
          </button>
        </div>

        <button
          type="button"
          className="control-button primary"
          onClick={() =>
            onStart({
              userColor,
              userName: userName.trim() || 'You',
              openingMode,
            })
          }
        >
          Start session
        </button>
      </div>
    </div>
  );
}
