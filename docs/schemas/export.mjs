/**
 * Exporte les schemas de docs/schemas/schemas.html en PNG (figures 4.1 a 4.3).
 * Usage : node docs/schemas/export.mjs   (Playwright doit etre installe)
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const out = fileURLToPath(new URL('../images/', here));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.goto(new URL('schemas.html', here).href);
await page.waitForTimeout(300);

const figures = { architecture: 'fig-4-1-architecture.png', sequence: 'fig-4-2-sequence.png', validation: 'fig-4-3-validation.png' };
for (const [id, file] of Object.entries(figures)) {
  await page.locator(`#${id}`).screenshot({ path: out + file });
  console.log('ecrit', file);
}
await browser.close();
