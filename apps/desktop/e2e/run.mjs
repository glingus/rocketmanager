// End-to-end flows against the Vite dev server with the mock backend.
// Run: pnpm --filter @rocketsync/desktop e2e
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'e2e', 'screenshots');
mkdirSync(shots, { recursive: true });

const PORT = 1431;
const BASE = `http://127.0.0.1:${PORT}`;
const EXP = 'p-experimental';
const AURORA = 'p-aurora';
const VEGA = 'p-vega';

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const errors = [];
let failed = false;
const results = [];

async function newPage(url, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'it-IT', timezoneId: 'Europe/Rome' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(url);
  return { page, context };
}

const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};

async function flow(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    await fn();
    results.push(`PASS ${name}`);
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    results.push(`FAIL ${name}: ${e.message}`);
    console.error(`FAIL ${name}\n`, e);
  }
}

const ready = (hash = '') => `${BASE}/?ready=1&nodev=1#/${hash}`;
const mock = (page, fn, ...args) => page.evaluate(({ fn, args }) => new Function('m', 'args', `return (${fn})(m, ...args)`)(window.__mock, args), { fn: fn.toString(), args });

// ---------------------------------------------------------------------------
await flow('onboarding', async () => {
  const { page, context } = await newPage(`${BASE}/?nodev=1#/`);
  await page.waitForSelector('[data-testid="onboarding-step-0"]');
  await page.waitForSelector('text=Trovato, versione');
  await shot(page, '01-onboarding-ambiente');
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="github-signin"]');
  await shot(page, '02-onboarding-accesso');
  await page.click('[data-testid="github-signin"]');
  await page.waitForSelector('text=Accesso eseguito come', { timeout: 8000 });
  await shot(page, '02b-onboarding-accesso-ok');
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-2"]');
  await page.waitForSelector('input[value="Simone Ferri"]');
  await shot(page, '03-onboarding-profilo');
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-3"]');
  await page.waitForSelector('text=Experimental Rocket');
  await page.click('[data-testid="new-project"]');
  await page.fill('[data-testid="new-project-name"]', 'Nuovo Razzo Test');
  await shot(page, '04-onboarding-progetti');
  await page.click('[data-testid="create-project"]');
  await page.waitForSelector('text=Nuovo Razzo Test', { timeout: 8000 });
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-4"]');
  await page.waitForSelector('text=La cartella verrà creata', { timeout: 5000 });
  // warn about a folder inside OneDrive
  const first = page.locator('input[id$="-path"]').first();
  await first.fill('C:\\Users\\simone\\OneDrive\\Razzi');
  await page.waitForSelector('text=La cartella è dentro OneDrive');
  assert.equal(await page.locator('[data-testid="step-next"]').isDisabled(), true, 'next must be blocked until the OneDrive risk is accepted');
  // and a non-empty folder
  const second = page.locator('input[id$="-path"]').nth(1);
  await second.fill('C:\\Users\\simone\\Desktop\\Razzi esistenti');
  await page.waitForSelector('text=La cartella non è vuota');
  await shot(page, '05-onboarding-cartelle');
  await first.fill('C:\\Users\\simone\\RocketSync\\Experimental Rocket');
  await page.waitForSelector('text=La cartella verrà creata');
  await page.waitForFunction(() => !document.querySelector('[data-testid="step-next"]').disabled, null, { timeout: 5000 });
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-5"]');
  await page.waitForSelector('[role="progressbar"]');
  await shot(page, '06-onboarding-sincronizzazione');
  await page.waitForSelector('text=Tutto pronto: i tuoi progetti sono sincronizzati', { timeout: 30000 });
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-6"]');
  await shot(page, '07-onboarding-preferenze');
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid="onboarding-step-7"]');
  await shot(page, '08-onboarding-fine');
  await page.click('[data-testid="step-next"]');
  await page.waitForSelector('[data-testid^="project-card-"]');
  assert.ok((await page.locator('[data-testid^="project-card-"]').count()) >= 4);
  await context.close();
});

// ---------------------------------------------------------------------------
await flow('dashboard e notifiche', async () => {
  const { page, context } = await newPage(ready());
  await page.waitForSelector(`[data-testid="project-card-${EXP}"]`);
  await page.waitForSelector('text=Modifiche non pubblicate');
  await shot(page, '10-dashboard');
  const bell = page.locator('button[aria-label^="Notifiche"]').first();
  assert.match((await bell.getAttribute('aria-label')) ?? '', /non lette/);
  await bell.click();
  await page.waitForSelector('text=Segna tutte come lette');
  await shot(page, '11-notifiche');
  await page.selectOption('[role="dialog"] select', EXP);
  await page.click('text=Segna tutte come lette');
  await page.waitForFunction(() => /^Notifiche$/.test(document.querySelector('button[aria-label^="Notifiche"]')?.getAttribute('aria-label') ?? ''), null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await context.close();
});

await flow('panoramica: pubblicazione', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/overview`));
  await page.waitForSelector('[data-testid="unpublished-banner"]');
  await page.waitForSelector('[data-testid="countdown"]');
  assert.match(await page.textContent('[data-testid="countdown"]'), /^\d+:\d{2}$/);
  await shot(page, '20-panoramica-modifiche');
  await page.fill('input[placeholder^="es. Pinne"]', 'Tubo del motore più lungo');
  await page.click('[data-testid="publish-button"]');
  await page.waitForSelector('text=Versione 13 pubblicata', { timeout: 10000 });
  await page.waitForSelector('text=Nessun file modificato');
  await shot(page, '21-panoramica-sincronizzato');
  await context.close();
});

await flow('aggiornamento bloccato da OpenRocket e guardia', async () => {
  const { page, context } = await newPage(ready(`p/${AURORA}/overview`));
  await page.waitForSelector('text=Sincronizzato');
  await mock(page, (m) => m.controls.editorOpen(m.world, 'p-aurora', ['Aurora.ork']));
  await mock(page, (m) => m.controls.colleaguePublish(m.world, 'p-aurora'));
  await page.waitForSelector('[data-testid="update-panel"]', { timeout: 8000 });
  await page.waitForSelector('text=chiudi il file in OpenRocket');
  await shot(page, '22-panoramica-aggiornamento-bloccato');
  await page.click('text=Aggiorna comunque');
  await page.click('[role="dialog"] >> text=Aggiorna comunque');
  await page.waitForSelector('[data-testid="update-panel"]', { state: 'detached', timeout: 8000 });
  await mock(page, (m) => m.controls.save(m.world, 'p-aurora'));
  await page.waitForSelector('[data-testid="stale-panel"]', { timeout: 5000 });
  await shot(page, '23-panoramica-guardia-editor');
  await page.click('text=No, oppure non lo so');
  await page.waitForSelector('[data-testid="conflict-banner"]', { timeout: 5000 });
  await shot(page, '24-panoramica-conflitto');
  await context.close();
});

await flow('offline e versioni in attesa', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/overview`));
  await page.waitForSelector('[data-testid="unpublished-banner"]');
  await mock(page, (m) => m.controls.offline(m.world, true));
  await page.waitForSelector('text=Sei offline');
  await page.click('[data-testid="publish-button"]');
  await page.waitForSelector('[data-testid="pending-panel"]', { timeout: 8000 });
  await page.waitForSelector('text=Offline: parte appena torna la connessione');
  await shot(page, '25-panoramica-offline');
  await mock(page, (m) => m.controls.offline(m.world, false));
  await page.waitForSelector('[data-testid="pending-panel"]', { state: 'detached', timeout: 10000 });
  await context.close();
});

await flow('version history, confronto e ripristino', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/history`));
  await page.waitForSelector('[data-testid="timeline"]');
  await page.waitForSelector('[data-testid="changelog-panel"] >> text=Cosa è cambiato');
  await shot(page, '30-history');
  await page.click('[data-testid="version-7"]');
  await page.waitForSelector('text=/non interpretat/ >> nth=0');
  await shot(page, '31-history-non-interpretate');
  await page.click('[data-testid="version-8"]');
  await page.waitForSelector('text=Ripristino');
  await page.click('[data-testid="version-3"]');
  await page.waitForSelector('text=Pinne trapezoidali');
  await page.click('[data-testid="open-compare"]');
  await page.waitForSelector('[data-testid="compare-panel"]');
  await shot(page, '32-history-confronto');
  await page.click('text=Chiudi il confronto');
  // restore requires published local changes: publish them first through the backend
  await page.goto(ready(`p/${EXP}/overview`));
  await page.click('[data-testid="publish-button"]');
  await page.waitForSelector('text=Nessun file modificato', { timeout: 10000 });
  await page.goto(ready(`p/${EXP}/history`));
  await page.waitForSelector('[data-testid="timeline"]');
  await page.click('[data-testid="version-5"]');
  await page.click('[data-testid="restore-button"]');
  await page.waitForSelector('text=Ripristinare la versione 5?');
  await shot(page, '33-history-ripristino');
  await page.click('text=Ripristina e crea nuova versione');
  await page.waitForSelector('text=Ripristinata la versione 5', { timeout: 10000 });
  await context.close();
});

await flow('conflitti: tre colonne e risoluzione', async () => {
  const { page, context } = await newPage(ready(`p/${VEGA}/conflicts`));
  await page.waitForSelector('text=Vega.ork');
  await shot(page, '40-conflitti-elenco');
  await page.click('text=Risolvi');
  await page.waitForSelector('[data-testid="three-way"]');
  await page.waitForSelector('[data-overlap]');
  await shot(page, '41-conflitto-risoluzione');
  assert.equal(await page.locator('[data-testid="resolve-button"]').isDisabled(), true);
  await page.click('[data-testid="open-theirs"]');
  await page.waitForSelector('text=Copia aperta in OpenRocket');
  await page.check('text=Tieni entrambe');
  await page.waitForFunction(() => !document.querySelector('[data-testid="resolve-button"]').disabled);
  await page.click('[data-testid="resolve-button"]');
  await page.waitForSelector('text=Confermare la risoluzione?');
  await shot(page, '42-conflitto-conferma');
  await page.click('[role="dialog"] >> text=Risolvi il conflitto');
  await page.waitForSelector('[data-testid="timeline"]', { timeout: 10000 });
  await page.waitForSelector('text=Risoluzione conflitto');
  await shot(page, '43-history-dopo-risoluzione');
  await context.close();
});

await flow('notes & tasks', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/notes`));
  await page.waitForSelector('[data-testid="board"]');
  await shot(page, '50-notes-bacheca');
  await page.fill('[data-testid="quick-add"]', 'Controllare il paracadute di riserva');
  await page.press('[data-testid="quick-add"]', 'Enter');
  await page.waitForSelector('text=Controllare il paracadute di riserva');
  await page.click('button:has-text("Controllare il paracadute di riserva")');
  await page.waitForSelector('[data-testid="card-drawer"]');
  await page.click('[data-testid="to-task"]');
  await page.waitForSelector('text=Assegnatario');
  await shot(page, '51-notes-dettaglio-attivita');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="card-drawer"]', { state: 'detached' });
  await page.click('button[role="radio"]:has-text("Per stato")');
  await page.waitForSelector('[data-testid="columns"]');
  await shot(page, '52-notes-colonne');
  await page.click('button[role="radio"]:has-text("Bacheca")');
  await page.click('button:has-text("Alta")');
  await page.waitForSelector('[data-testid="board"]');
  const n = await page.locator('[data-testid^="card-"]').count();
  assert.ok(n >= 2 && n < 12, `filtered cards: ${n}`);
  await shot(page, '53-notes-filtri');
  await context.close();
});

await flow('membri: admin e member', async () => {
  let ctx = await newPage(ready(`p/${EXP}/members`));
  await ctx.page.waitForSelector('[data-testid="members-list"]');
  await shot(ctx.page, '60-membri-admin');
  await ctx.page.fill('[data-testid="invite-login"]', 'mrossi');
  await ctx.page.click('[data-testid="invite-button"]');
  await ctx.page.waitForSelector('text=Invito inviato a mrossi', { timeout: 8000 });
  await ctx.context.close();
  ctx = await newPage(ready(`p/${AURORA}/members`));
  await ctx.page.waitForSelector('[data-testid="admin-note"]');
  assert.equal(await ctx.page.locator('[data-testid="invite-button"]').isDisabled(), true);
  await shot(ctx.page, '61-membri-member');
  await ctx.context.close();
});

await flow('activity log', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/activity`));
  await page.waitForSelector('[data-testid="activity-list"]');
  await page.waitForSelector('[data-testid="activity-note"]');
  await shot(page, '70-activity-log');
  await page.selectOption('select >> nth=2', 'critical');
  await page.waitForTimeout(300);
  const rows = await page.locator('[data-importance]').count();
  assert.ok(rows >= 1);
  await shot(page, '71-activity-log-critici');
  await context.close();
});

await flow('impostazioni', async () => {
  let ctx = await newPage(ready(`p/${EXP}/settings`));
  await ctx.page.waitForSelector('text=Quando nasce una versione');
  await shot(ctx.page, '80-impostazioni-progetto');
  await ctx.page.click('[data-testid="discord-test"]');
  await ctx.page.waitForSelector('text=Messaggio di prova inviato', { timeout: 8000 });
  await ctx.context.close();
  ctx = await newPage(ready(`p/${AURORA}/settings`));
  await ctx.page.waitForSelector('[data-testid="readonly-note"]');
  await shot(ctx.page, '81-impostazioni-progetto-member');
  await ctx.context.close();
  ctx = await newPage(ready('settings'));
  await ctx.page.waitForSelector('[data-testid="notification-prefs"]');
  await shot(ctx.page, '82-impostazioni-app');
  await ctx.page.click('[data-testid="check-update"]');
  await ctx.page.waitForSelector('text=Hai l’ultima versione');
  await ctx.context.close();
});

await flow('finestra stretta 1024px', async () => {
  const { page, context } = await newPage(ready(`p/${EXP}/overview`), { width: 1024, height: 768 });
  await page.waitForSelector('[data-testid="unpublished-banner"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no horizontal page scroll at 1024px');
  await shot(page, '90-panoramica-1024');
  await page.goto(ready(`p/${VEGA}/conflicts/${await page.evaluate(() => window.__mock.world.sim('p-vega').openConflicts()[0].conflict.id)}`));
  await page.waitForSelector('[data-testid="three-way"]');
  await shot(page, '91-conflitto-1024');
  await context.close();
});

await browser.close();
await server.close();

const real = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
if (real.length) {
  console.error('Browser errors:\n' + real.join('\n'));
  failed = true;
}
console.log('\n' + results.join('\n'));
process.exit(failed ? 1 : 0);
