/**
 * Selectors for blokee.mattle.online lobby / board UI.
 * Update this file when the live site restyles — keep all mattle CSS hooks here.
 */
export const MATTLE_ORIGIN = 'https://blokee.mattle.online';

export const mattleSelectors = {
  playAsGuest: 'button:has-text("Play as Guest"), a:has-text("Play as Guest")',
  createGame: [
    'button:has-text("Create")',
    'button:has-text("New Game")',
    'a:has-text("Create Room")',
    'button:has-text("Play")',
  ].join(', '),
  addCpu: [
    'button:has-text("CPU")',
    'button:has-text("AI")',
    'button:has-text("Computer")',
    'button:has-text("Add Bot")',
  ].join(', '),
  startGame: [
    'button:has-text("Start")',
    'button:has-text("Begin")',
    'button:has-text("Play")',
  ].join(', '),
  boardCanvas: 'canvas',
  boardCell: [
    '[id*="square_"]',
    '[id*="cell_"]',
    '.board-cell',
    '.board_cell',
    '.blokus_square',
  ].join(', '),
  gameOver: [
    'text=Game Over',
    'text=Results',
    'text=Winner',
    '.game-over',
    '.score-board',
  ].join(', '),
};
