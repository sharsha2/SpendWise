/* Moneta browser tests — clicks through the real app in headless Chrome.
   Run: npm run test:e2e   (set CHROME_PATH to use an installed Chrome with puppeteer-core)
   Builds its own fixtures: an old-format Excel export and two bank statement PDFs. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const XLSX = require('../vendor/xlsx/xlsx.full.min.js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = require('puppeteer-core'); }

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'moneta-e2e-'));
const DL = path.join(TMP, 'downloads');
const SHOTS = process.env.SCREENSHOT_DIR || '';
fs.mkdirSync(DL);

const results = [];
const ok = (name, cond, extra = '') => results.push({ name, pass: !!cond, extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const today = new Date();
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const thisMonth = ym(today);
const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
const lastMonth = ym(lastMonthDate);

// ---------- fixtures ----------
function makeOldExcel(file) {
  // Old export: no Category column, real date cells
  const rows = [];
  const stores = [['Walmart', 85], ['Costco', 140], ['Netflix', 16.99], ['Shell Gas', 60], ['Tim Hortons', 8.5], ['Rogers', 95]];
  [[lastMonthDate, 8], [today, 4]].forEach(([base, n]) => {
    for (let i = 0; i < n; i++) {
      const [st, a] = stores[i % stores.length];
      rows.push({ 'Date': new Date(base.getFullYear(), base.getMonth(), 1 + i), 'Purchased By': 'Harsha', 'Purchased Store': st, 'Bank Name': 'Amex', 'Debit [D]': a, 'Credit [C]': '', 'Amount Total': a });
    }
    rows.push({ 'Date': new Date(base.getFullYear(), base.getMonth(), 1), 'Purchased By': 'Harsha', 'Purchased Store': 'Payroll', 'Bank Name': 'Scotia Debit', 'Debit [D]': '', 'Credit [C]': 4200, 'Amount Total': 4200 });
  });
  // A card payment that must not count as spending
  rows.push({ 'Date': new Date(today.getFullYear(), today.getMonth(), 1), 'Purchased By': 'Harsha', 'Purchased Store': 'Amex credit card payment', 'Bank Name': 'Scotia Debit', 'Debit [D]': 500, 'Credit [C]': '', 'Amount Total': 500 });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { cellDates: true }), 'Sheet1');
  fs.writeFileSync(file, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  return rows.length;
}

async function makePdf(file, lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((cols, i) => {
    const y = 740 - i * 18;
    // Columns are drawn as separate text runs, like real statements
    (Array.isArray(cols) ? cols : [[40, cols]]).forEach(([x, text]) => page.drawText(text, { x, y, size: 10, font }));
  });
  fs.writeFileSync(file, await doc.save());
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d) => `${MON[d.getMonth()]} ${d.getDate()}`;
const day = (n) => new Date(today.getFullYear(), today.getMonth(), n);

// ---------- static server ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  const excel = path.join(TMP, 'old.xlsx');
  const excelRows = makeOldExcel(excel);
  const cardPdf = path.join(TMP, 'amex.pdf');
  await makePdf(cardPdf, [
    'American Express Cobalt Card',
    `Statement period: ${md(day(1))}, ${today.getFullYear()} to ${md(day(2))}, ${today.getFullYear()}`,
    [[40, md(day(1))], [90, md(day(2))], [150, 'UBER EATS TORONTO'], [480, '23.45']],
    [[40, md(day(1))], [90, md(day(2))], [150, 'PAYMENT RECEIVED - THANK YOU'], [480, '-500.00']],
    [[40, md(day(2))], [90, md(day(2))], [150, 'AMAZON.CA REFUND'], [480, '19.99 CR']],
    [[40, md(day(2))], [150, 'Total new charges'], [480, '23.45']]
  ]);
  const bankPdf = path.join(TMP, 'scotia.pdf');
  const iso = (n) => `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(n)}`;
  await makePdf(bankPdf, [
    'Scotiabank Basic Bank Account',
    [[40, 'Opening balance'], [480, '1,000.00']],
    [[40, iso(1)], [120, 'PAYROLL DEPOSIT ACME'], [400, '2,000.00'], [480, '3,000.00']],
    [[40, iso(2)], [120, 'HYDRO ONE BILL'], [400, '120.50'], [480, '2,879.50']]
  ]);

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const URL = `http://localhost:${server.address().port}/index.html`;
  const browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' || /Content.Security/i.test(m.text())) errs.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  const external = [];
  p.on('request', r => { if (!r.url().startsWith(URL.replace('/index.html', '')) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  const cdp = await p.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  // Center the target first: Puppeteer's own scrolling can leave it under the sticky header
  const tap = async sel => {
    await p.$eval(sel, el => el.scrollIntoView({ block: 'center' }));
    await p.click(sel);
  };
  const vis = sel => p.$eval(sel, el => getComputedStyle(el).display !== 'none' && !el.hidden).catch(() => false);
  const text = sel => p.$eval(sel, el => el.textContent.trim()).catch(() => null);
  const shot = async (name, sel) => {
    if (!SHOTS) return;
    await p.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    if (sel) await (await p.$(sel)).screenshot({ path: path.join(SHOTS, name) });
    else await p.screenshot({ path: path.join(SHOTS, name) });
  };

  await p.setViewport({ width: 1280, height: 900 });
  await p.goto(URL, { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle0' });
  await p.evaluate(() => { window.showOpenFilePicker = undefined; });

  // Menu
  for (const [action, modal] of [['openReportsHub', '#reportsHubModal'], ['openSettingsModal', '#settingsModal'], ['openCompareModal', '#compareMonthsModal']]) {
    await p.click('#menuBtn'); await sleep(120);
    await p.click(`[data-action="${action}"]`); await sleep(200);
    ok(`menu ${action} opens`, await vis(modal));
    ok(`menu ${action} moves focus into dialog`, await p.evaluate(m => document.querySelector(m).contains(document.activeElement), modal));
    await p.keyboard.press('Escape'); await sleep(120);
    ok(`menu ${action} closes`, !(await vis(modal)));
  }
  const theme0 = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await p.click('#menuBtn'); await sleep(120); await p.click('[data-action="toggleTheme"]'); await sleep(120);
  ok('theme toggles', await p.evaluate(() => document.documentElement.getAttribute('data-theme')) !== theme0);
  await p.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); updateThemeUI('light'); });

  // Open old Excel
  await (await p.$('#uploadFile')).uploadFile(excel); await sleep(700);
  ok('opens old-format Excel', await p.evaluate(() => budgetData.length) === excelRows);
  const totals = await p.evaluate(m => periodTotals(budgetData.filter(r => r.Date.startsWith(m))), thisMonth);
  ok('card payment not counted as spending', Math.abs(totals.spent - (85 + 140 + 16.99 + 60)) < 0.001, JSON.stringify(totals));
  ok('payment row labelled as transfer', (await p.$$eval('.kind-tag', els => els.map(e => e.textContent))).some(t => t.includes('Transfer')));

  // Store autocomplete: inline completion, list, Enter accepts without adding
  const rowsBeforeAc = await p.evaluate(() => budgetData.length);
  await p.click('#store'); await p.keyboard.type('Net'); await sleep(120);
  const ac = await p.$eval('#store', el => ({ v: el.value, sel: el.value.slice(el.selectionStart, el.selectionEnd) }));
  ok('autocomplete completes inline', ac.v === 'Netflix' && ac.sel === 'flix', JSON.stringify(ac));
  ok('autocomplete list shows', await vis('#storeSuggestions'));
  await shot('autocomplete.png', '#entryCard');
  await p.keyboard.press('Enter'); await sleep(120);
  ok('Enter accepts suggestion', (await p.$eval('#store', el => el.value)) === 'Netflix' && !(await vis('#storeSuggestions')));
  ok('accepting does not add a row', await p.evaluate(() => budgetData.length) === rowsBeforeAc);
  ok('accepting fills from last time', ((await text('#storeHint')) || '').includes('filled'));
  await p.$eval('#store', el => { el.value = ''; });

  // Add entry
  await p.click('#addBtn'); await sleep(80);
  ok('inline error for empty amount', (await text('#amountError')) === 'Enter an amount');
  await p.click('#entryCard .type-opt[data-type="C"]');
  ok('income toggle relabels button', (await text('#addBtnLabel')) === 'Add income');
  await p.keyboard.press('ArrowLeft');
  ok('arrow key switches back to expense', (await text('#addBtnLabel')) === 'Add expense');
  await p.type('#store', 'Costco'); await sleep(80);
  ok('store autofill', ((await text('#storeHint')) || '').includes('filled'));
  await p.click('#entryCard .chip[data-offset="0"]');
  await p.type('#amount', '42.10'); await p.click('#addBtn'); await sleep(200);
  ok('adds entry', await p.evaluate(() => budgetData.length) === excelRows + 1);
  ok('unsaved badge', (await text('#unsavedBadge')) === '1');

  // Edit dialog
  const firstRow = await p.$('#budgetTable tbody tr.txn-row');
  const idx = await firstRow.evaluate(r => Number(r.dataset.index));
  await firstRow.click({ offset: { x: 300, y: 12 } }); await sleep(200);
  ok('row opens editor', await vis('#editModal'));
  await shot('edit.png', '#editCard');
  await p.$eval('#editAmount', e => { e.value = ''; }); await p.type('#editAmount', '31.55'); await p.click('#editSave'); await sleep(200);
  ok('editor saves', await p.evaluate(i => budgetData[i]['Amount Total'], idx) === 31.55);
  ok('focus returns after dialog', await p.evaluate(() => document.activeElement && document.activeElement !== document.body));

  // Bulk
  const checks = await p.$$('.row-check'); await checks[0].click(); await checks[1].click(); await sleep(80);
  ok('bulk bar', (await text('#bulkCount')) === '2 selected');
  await p.select('#bulkCategory', 'Travel'); await p.click('#bulkApply'); await sleep(120);
  ok('bulk category', await p.evaluate(() => budgetData.filter(r => r.Category === 'Travel').length) === 2);
  await p.click('#bulkClear');

  // PDF import: credit card statement
  await (await p.$('#pdfInput')).uploadFile(cardPdf);
  await p.waitForFunction(() => document.getElementById('importModal').style.display === 'flex', { timeout: 15000 }).catch(() => {});
  ok('card PDF opens review', await vis('#importModal'));
  const cardRows = await p.$$eval('#importTable tbody tr', trs => trs.map(tr => tr.textContent));
  ok('card PDF: 3 transactions, total line skipped', cardRows.length === 3, cardRows.join(' | '));
  ok('card PDF: bank detected', (await p.$eval('#importBank', s => s.value)) === 'Amex');
  await shot('import.png', '.import-content');
  const before = await p.evaluate(() => budgetData.length);
  await p.click('#importConfirm'); await sleep(200);
  ok('card PDF rows added', await p.evaluate(() => budgetData.length) === before + 3);
  const amex = await p.evaluate(() => budgetData.slice(-3).map(r => ({ s: r['Purchased Store'], k: classify(r).kind })));
  ok('card PDF: payment = transfer, refund = refund', amex[1].k === 'transfer' && amex[2].k === 'refund', JSON.stringify(amex));

  // PDF import: chequing statement (balance decides direction)
  await (await p.$('#pdfInput')).uploadFile(bankPdf);
  await p.waitForFunction(() => document.getElementById('importModal').style.display === 'flex', { timeout: 15000 }).catch(() => {});
  const bankTypes = await p.$$eval('#importTable .imp-type', bs => bs.map(b => b.textContent.trim()[0]));
  ok('chequing PDF: deposit +, bill −', bankTypes.join('') === '+−', bankTypes.join(''));
  ok('chequing PDF: bank detected', (await p.$eval('#importBank', s => s.value)) === 'Scotia Debit');
  await p.click('#importCancel'); await sleep(100);

  // Re-importing the same card statement marks duplicates
  await (await p.$('#pdfInput')).uploadFile(cardPdf);
  await p.waitForFunction(() => document.getElementById('importModal').style.display === 'flex', { timeout: 15000 }).catch(() => {});
  ok('re-import: duplicates unticked', await p.$$eval('.imp-check', cs => cs.every(c => !c.checked)));
  await p.click('#importCancel');

  // Settings
  await p.click('#menuBtn'); await sleep(100); await p.click('[data-action="openSettingsModal"]'); await sleep(150);
  await p.type('#newPersonName', 'Alex'); await p.click('[data-action="addSettingItem"][data-key="people"]'); await sleep(80);
  ok('settings add person', await p.evaluate(() => getSettings().people.includes('Alex')));
  await p.type('#budgetTarget', 'Groceries'); await p.type('#budgetAmount', '0'); await p.click('[data-action="addBudgetSetting"]'); await sleep(80);
  ok('budget 0 rejected', await p.evaluate(() => !('Groceries' in getSettings().budgets)));
  await p.$eval('#budgetAmount', e => { e.value = '150'; }); await p.click('[data-action="addBudgetSetting"]'); await sleep(80);
  await p.type('#recDesc', 'Rent'); await p.type('#recAmount', '1800'); await p.type('#recDay', '31'); await p.click('[data-action="addRecurringSetting"]'); await sleep(80);
  await shot('settings.png', '.settings-content');
  await p.keyboard.press('Escape'); await sleep(100);
  ok('budget card shows status', /On track|At risk|Over budget/.test(await text('#budgetProgressList') || ''));
  await tap('#applyRecurringBtn'); await sleep(120);
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  ok('recurring day 31 clamps', await p.evaluate(d => budgetData.some(r => r.Date === d && r['Purchased Store'] === 'Rent'), `${thisMonth}-${pad(Math.min(31, lastDay))}`));

  // Save: one file per month
  const n = await p.evaluate(() => budgetData.length);
  await tap('#downloadBtn'); await sleep(1500);
  const files = fs.readdirSync(DL);
  let saved = 0;
  files.forEach(f => { const wb = XLSX.read(fs.readFileSync(path.join(DL, f))); saved += XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length; });
  ok('every row saved once', saved === n, `${saved}/${n} in ${files.join(',')}`);
  ok('badge cleared', !(await vis('#unsavedBadge')));

  // Compare months
  await p.click('#menuBtn'); await sleep(100); await p.click('[data-action="openCompareModal"]'); await sleep(150);
  await (await p.$('#compareFilesInput')).uploadFile(excel); await sleep(800);
  ok('compare months summary', await vis('#comparisonSummary'));
  await p.keyboard.press('Escape');

  // Draft restore
  await p.type('#store', 'Draft test'); await p.type('#amount', '5'); await p.click('#addBtn'); await sleep(150);
  const nDraft = await p.evaluate(() => budgetData.length);
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  ok('fresh visit is blank', await p.evaluate(() => budgetData.length) === 0);
  await p.click('#store'); await p.keyboard.type('Wal'); await sleep(120);
  ok('stores are remembered across visits', (await p.$eval('#store', el => el.value)) === 'Walmart');
  await p.keyboard.press('Escape');
  ok('Escape drops the inline completion', (await p.$eval('#store', el => el.value)) === 'Wal');
  await p.$eval('#store', el => { el.value = ''; });
  ok('restore bar', await vis('#draftBanner'));
  await p.click('#draftRestore'); await sleep(300);
  ok('restore', await p.evaluate(() => budgetData.length) === nDraft);

  // Injection
  await p.evaluate(() => { window.__pwned = false; });
  await p.type('#store', '<img src=x onerror="window.__pwned=true">'); await p.type('#amount', '1'); await p.click('#addBtn'); await sleep(250);
  ok('HTML in store name is inert', await p.evaluate(() => window.__pwned === false && !document.querySelector('#budgetTable img')));
  ok('no third-party requests', external.length === 0, external.slice(0, 3).join(', '));
  await shot('desktop.png');

  // Phone
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(200); await p.click('#draftRestore'); await sleep(300);
  ok('phone: + button', await vis('#fab'));
  await p.click('#fab'); await sleep(350);
  ok('phone: sheet opens', await p.$eval('#entryCard', e => e.classList.contains('sheet-open')));
  await p.type('#amount', '9.99'); await p.type('#store', 'Phone add'); await p.click('#addBtn'); await sleep(300);
  ok('phone: add closes sheet', !(await p.$eval('#entryCard', e => e.classList.contains('sheet-open'))));
  const overflow = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1 && !el.closest('.table-container, .modal, .status-message, .category-picker-panel'); }).slice(0, 3).map(el => el.tagName + '.' + el.className));
  ok('phone: nothing overflows', overflow.length === 0, overflow.join(' | '));
  await p.evaluate(() => { document.getElementById('statusMessage').style.display = 'none'; });
  await shot('phone.png');

  ok('no console or CSP errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra && !r.pass ? ' — ' + r.extra : ''}`));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)); process.exit(1); });
