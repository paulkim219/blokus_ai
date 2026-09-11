import { chromium } from 'playwright';

const base = 'http://localhost:5174';
const routes = [
  '/',
  '/models/hanni-1',
  '/models/hanni-2-lite',
  '/models/hanni-2-pro',
  '/models/hanni-3-1-nano',
  '/models/hanni-3-1-lite',
  '/models/hanni-3-1',
  '/models/hanni-3-1-pro',
  '/models/hanni-3-1-pro-max',
  '/models/hanni-3-2',
  '/models/hanni-3-2-pro',
  '/models/hanni-3-2-pro-max',
  '/models/hanni-3-7-pro',
  '/models/hanni-4-1-lite',
  '/models/hanni-4-1',
  '/models/hanni-4-1-pro',
  '/models/hanni-4-1-pro-max',
  '/models/hanni-4',
  '/research',
  '/research/leaf-and-weights',
  '/research/how-the-design-was-tested',
  '/research/hanni-3-2',
  '/research/hanni-4-1',
  '/research/hanni-4',
];

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
});
const page = await browser.newPage();
const problems = [];

function blokeeMentions(text) {
  const matches = [...text.matchAll(/Blokee|blokee/g)];
  return matches.map((m) => m[0]);
}

for (const route of routes) {
  const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ timeout: 8000 });
  if (!response || response.status() >= 400) {
    problems.push(`${route} status ${response?.status()}`);
  }
  const title = await page.title();
  if (title.includes('Blokee') || title.includes('blokee')) {
    problems.push(`${route} title leaks Blokee: ${title}`);
  }
  const body = await page.locator('body').innerText();
  const leaked = blokeeMentions(body).filter((word) => word.toLowerCase() === 'blokee');
  if (leaked.length) {
    const allowed = body.includes('Play four-player Blokus on Blokee') || body.includes('blokee.mattle.online');
    if (!allowed || leaked.length > 2) {
      problems.push(`${route} unexpected Blokee text (${leaked.length}): ${body.slice(0, 200)}`);
    }
  }
  if (route.startsWith('/models/hanni-') && route !== '/models/hanni-4') {
    const over = page.getByText('Over the game');
    const cost = page.getByText('At a given cost');
    if (!(await over.isVisible()) || !(await cost.isVisible())) {
      problems.push(`${route} missing benchmark charts`);
    }
    const tabs = page.getByRole('tab');
    if ((await tabs.count()) > 0) problems.push(`${route} still has old benchmark tabs`);
  }
}

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'Hanni' }).hover();
const flyout = page.locator('.hanni-flyout');
if (!(await flyout.isVisible())) problems.push('Hanni flyout did not open on hover');
await page.getByRole('button', { name: 'Hanni 3.1' }).hover();
const nano = page.getByRole('link', { name: /Hanni 3.1 Nano/ });
if (!(await nano.isVisible())) {
  problems.push('Hanni 3.1 side panel missing Nano');
} else {
  await nano.click();
  await page.waitForURL(/hanni-3-1-nano$/);
  if (!(await page.getByRole('heading', { name: 'Hanni 3.1 Nano' }).isVisible())) {
    problems.push('Did not land on Hanni 3.1 Nano');
  }
}

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
await page.getByRole('button', { name: 'Menu' }).click();
if (!(await page.getByLabel('Primary').getByRole('link', { name: 'Research' }).isVisible())) {
  problems.push('Mobile menu did not show Research');
}

await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base + '/models/hanni-1', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const hanni1 = await page.locator('body').innerText();
if (!hanni1.includes('This page shows Hanni 1.')) {
  problems.push('Hanni 1 page should only list Hanni 1 in the overlay set');
}
if (hanni1.includes('This page shows') && hanni1.includes('Hanni 3.2')) {
  problems.push('Hanni 1 overlay set leaked a later generation');
}
if (hanni1.includes('Direct predecessors')) {
  problems.push('Hanni 1 should not duplicate its greedy overlay as a predecessor chart');
}
if (!hanni1.includes('Own-moves 16–21')) {
  problems.push('Hanni 1 overlay crop should start at move 16');
}

await page.goto(base + '/models/hanni-2-lite', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const hanni2 = await page.locator('body').innerText();
if (!hanni2.includes('Hanni 2 Pro') || !hanni2.includes('Hanni 1')) {
  problems.push('Hanni 2 page should overlay Hanni 1 and both Hanni 2s');
}
if (!hanni2.includes('Direct predecessors') || !hanni2.includes('vs Hanni 1')) {
  problems.push('Hanni 2 Lite should have a vs Hanni 1 predecessor well');
}

await page.goto(base + '/models/hanni-3-2-pro', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const hanni32 = await page.locator('body').innerText();
if (!hanni32.includes('Hanni 3.1 Nano') || !hanni32.includes('Hanni 2 Lite')) {
  problems.push('Hanni 3.2 page should overlay every earlier shipping engine');
}
if (!hanni32.includes('vs Hanni 2 Pro') || !hanni32.includes('vs Hanni 3.1 Pro')) {
  problems.push('Hanni 3.2 Pro should have predecessor wells for 2 Pro and 3.1 Pro');
}
const overlayHits = page.locator('.chart-well').first().locator('.chart-hit');
if ((await overlayHits.count()) < 60) {
  problems.push('3.2 Pro overlay should have a hit target per visible engine × cropped move');
} else {
  await overlayHits.nth(20).hover({ force: true });
  const overlayCard = page.locator('.chart-hover-card');
  if (!(await overlayCard.isVisible())) {
    problems.push('Overlay hover card did not appear');
  } else {
    const text = await overlayCard.innerText();
    if (!text.includes('Own move') || !text.includes('Hanni')) {
      problems.push(`Overlay hover card missing name/move: ${text}`);
    }
  }
}
const paretoHits = page.locator('.chart-well').nth(1).locator('.chart-hit');
if ((await paretoHits.count()) < 8) {
  problems.push('3.2 Pro Pareto should have a hit target per visible engine');
} else {
  await paretoHits.nth(4).hover({ force: true });
  const paretoCard = page.locator('.chart-hover-card');
  if (!(await paretoCard.isVisible())) {
    problems.push('Pareto hover card did not appear');
  } else {
    const text = await paretoCard.innerText();
    if (!text.includes('ms / move') || !text.includes('vs greedy')) {
      problems.push(`Pareto hover card missing cost/Δ: ${text}`);
    }
  }
}

await page.goto(base + '/models/hanni-3-1-lite', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const liteNano = page.locator('.chart-well').filter({ hasText: 'vs Hanni 3.1 Nano' });
if ((await liteNano.locator('.chart-hit').count()) < 6) {
  problems.push('3.1 Lite vs Nano predecessor well should plot once 400 games are on disk');
}

await page.goto(base + '/models/hanni-3-7-pro', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const hanni37 = await page.locator('body').innerText();
const overlay37 = hanni37.split('\n').find((line) => line.includes('This page shows')) ?? '';
if (overlay37.includes('Hanni 4.1')) {
  problems.push('Hanni 3.7 overlay set leaked Hanni 4.1');
}

await page.goto(base + '/models/hanni-4-1-pro', { waitUntil: 'domcontentloaded' });
await page.locator('h1').first().waitFor({ timeout: 8000 });
const hanni41 = await page.locator('body').innerText();
const overlay41 = hanni41.split('\n').find((line) => line.includes('This page shows')) ?? '';
if (!overlay41.includes('Hanni 4.1 Pro') || !overlay41.includes('Hanni 3.7')) {
  problems.push('Hanni 4.1 page should overlay 3.7 and the 4.1 suites');
}
if (!hanni41.includes('vs Hanni 3.1 Pro')) {
  problems.push('Hanni 4.1 Pro should have a predecessor well against Hanni 3.1 Pro');
}

const play = page.locator('a[href="https://blokee.mattle.online/lobby/rooms"]');
if ((await play.count()) < 1) problems.push('Missing Play Blokus URL');

await browser.close();

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`ok ${routes.length} routes, nav, charts, generation filters, mobile, play link`);
