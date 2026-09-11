# Blokee Sync (Chrome extension)

Mirrors a live Blokus game tab (including [blokee.mattle.online](https://blokee.mattle.online)) into the Blokee coach so you do not have to re-enter every move by hand.

## Install (unpacked)

1. Run Blokee locally: `npm run dev` (usually `http://localhost:5173`).
2. Open Chrome → `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this `extension/` folder.
5. If you already loaded it before, click **Reload** on the Blokee Sync card after updates (current version: **1.3.5**), then **refresh the game tab and the Blokee tab**. Reloading the extension without refreshing tabs can leave a dead content script behind.
6. Open your live Blokus game tab **and** the Blokee coach tab.
7. In Blokee, turn **Live sync** on.

Blokee immediately requests a board snapshot. Status should move to **Updated** / **Mirrored remote board…** and the coach grid should fill to match the game.

## How it works

```
Game tab → content.js → background.js → coach tab content.js → Blokee page
```

Uses a **single** content script (`content.js`) so Chrome’s shared extension world cannot collide on duplicate `const` declarations.

The scraper reads a 20×20 occupancy grid (DOM cells, color classes, or pixel sampling of the board), then Blokee **hydrates** that snapshot onto the local engine so mid-game positions appear right away.

## Tips

- Reload the extension after pulling code changes, then refresh both tabs.
- Keep the game tab open; Live sync needs that tab’s content script.
- Classic Blokus **red** maps to Blokee **purple**.
- If status stays on “waiting for board data”, the game page may be canvas-only or unusual — tell us the URL and we can tune the scraper.

## Live CPU eval

`npm run live-cpu-eval -- --manual-lobby` opens a headed browser. Create a 1-human + 3-CPU game; the script detects your seat and prints each suggested placement as an ASCII grid.

Coordinates: **x is column** (0 = left, Blue’s corner), **y is row** (0 = top, Blue’s corner). `(7,4)` means column 7, row 4 — not row 7, column 4.

## Permissions

- Broad site access so any Blokus-like tab can be scraped
- `localhost` / `127.0.0.1` to deliver updates into Blokee
