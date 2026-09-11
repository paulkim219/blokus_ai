import { chromium } from 'playwright';
const [,, file, out, theme] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewportSize: { width: 1200, height: 1500 }, colorScheme: theme === 'dark' ? 'dark' : 'light' });
await p.goto('file://' + file);
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log('shot ->', out);
