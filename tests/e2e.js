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
  // A hand-made "Total" line at the bottom must not count as a transaction
  const withTotal = rows.concat([{ 'Date': '', 'Purchased By': '', 'Purchased Store': 'Total', 'Bank Name': '', 'Debit [D]': 9999, 'Credit [C]': '', 'Amount Total': 9999 }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withTotal, { cellDates: true }), 'Sheet1');
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
  // Header buttons on desktop, the Menu on phones
  const menu = async (action) => {
    if (await p.$eval('#menuBtn', el => el.offsetParent !== null)) {
      await p.click('#menuBtn'); await sleep(120);
      await p.click(`#menuOptions [data-action="${action}"]`);
    } else {
      await p.click(`.header-actions [data-action="${action}"]`);
    }
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
    await menu(action); await sleep(200);
    ok(`menu ${action} opens`, await vis(modal));
    ok(`menu ${action} moves focus into dialog`, await p.evaluate(m => document.querySelector(m).contains(document.activeElement), modal));
    await p.keyboard.press('Escape'); await sleep(120);
    ok(`menu ${action} closes`, !(await vis(modal)));
  }
  const theme0 = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await menu('toggleTheme'); await sleep(120);
  ok('theme toggles', await p.evaluate(() => document.documentElement.getAttribute('data-theme')) !== theme0);
  await p.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); updateThemeUI('light'); });

  ok('welcome screen on a blank start', await vis('#dashEmpty') && !(await vis('#overviewSection .kpi-grid')));

  ok('one Upload button (no separate Excel/PDF buttons)', await vis('#uploadBtn') && !(await p.$('#uploadMenu')));

  // Open old Excel
  await (await p.$('#uploadFile')).uploadFile(excel); await sleep(700);
  ok('welcome screen gives way to the dashboard', !(await vis('#dashEmpty')) && await vis('#overviewSection .kpi-grid'));
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

  // The single Upload picker routes a PDF to the statement review
  await (await p.$('#uploadAny')).uploadFile(bankPdf);
  await p.waitForFunction(() => document.getElementById('importModal').style.display === 'flex', { timeout: 15000 }).catch(() => {});
  ok('Upload routes a PDF to the statement review', await vis('#importModal'));
  await p.click('#importCancel'); await sleep(100);

  // Settings
  await menu('openSettingsModal'); await sleep(150);
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

  // 3. Learned category: change Walmart to Shopping once, a new Walmart row follows
  const wIdx = await p.evaluate(() => budgetData.findIndex(r => r['Purchased Store'] === 'Walmart'));
  await tap(`[data-action="editRow"][data-index="${wIdx}"]`); await sleep(200);
  await p.select('#editCategory', 'Shopping'); await p.click('#editSave'); await sleep(150);
  ok('learned category applies to new rows', await p.evaluate(() => getCategory({ 'Purchased Store': 'walmart' })) === 'Shopping');

  // 5. Amount search and click-to-filter
  await p.$eval('#searchInput', el => { el.value = '16.99'; el.dispatchEvent(new Event('input')); }); await sleep(350);
  ok('search by amount', await p.evaluate(() => getFilteredData().length > 0 && getFilteredData().every(r => toCents(r['Amount Total']) === 1699)));
  await p.click('#clearFilterBtn'); await sleep(150);
  await tap('#dashTopStores .top-item'); await sleep(300);
  ok('top store click filters table', (await p.$eval('#searchInput', el => el.value)).length > 0 && (await p.$$('#budgetTable tbody tr.txn-row')).length > 0);
  await p.evaluate(() => filterTableTo({ category: 'Groceries' })); await sleep(150);
  ok('category chip shows', await vis('#categoryChip'));
  await p.click('#categoryChipClear'); await sleep(100);
  ok('category chip clears', !(await vis('#categoryChip')));
  await p.click('#clearFilterBtn'); await sleep(100);

  // 4. Settle up appears once two people have spending
  await p.evaluate(() => { budgetData.filter(r => r['Purchased Store'] === 'Costco').forEach(r => { r['Purchased By'] = 'Cherry'; }); renderTable(); });
  ok('settle-up panel shows who pays whom', await vis('#settlePanel') && /pays|even/.test(await text('#settleList') || ''));

  // 7. Split: $40 of a row into Home, totals unchanged
  const sIdx = await p.evaluate(() => budgetData.findIndex(r => toCents(r['Debit [D]']) > 5000 && r['Purchased Store'] === 'Costco'));
  const spentBeforeSplit = await p.evaluate(() => periodTotals(budgetData).spent);
  await tap(`[data-action="editRow"][data-index="${sIdx}"]`); await sleep(200);
  await p.click('#editSplit'); await sleep(80);
  await p.type('#splitAmount', '40'); await p.select('#splitCategory', 'Home'); await p.click('#splitApply'); await sleep(150);
  ok('split makes two rows with the same total', await p.evaluate((i, before) =>
    budgetData[i + 1]['Category'] === 'Home' && toCents(budgetData[i + 1]['Debit [D]']) === 4000 &&
    Math.abs(periodTotals(budgetData).spent - before) < 0.001, sIdx, spentBeforeSplit));

  // 6. Subscriptions found (Netflix appears in two months in the fixture)
  await menu('openSettingsModal'); await sleep(150);
  ok('detected recurring shown', await vis('#recurringDetected') && /Netflix/i.test(await text('#recurringDetectedList') || ''));
  // 9. Currency
  await p.select('#currencySelect', 'eur'); await sleep(100);
  ok('euro currency', (await text('.amount-cur')) === '€');
  await p.select('#currencySelect', 'dollar'); await sleep(100);
  await p.keyboard.press('Escape'); await sleep(100);

  // 8. Year summary + export
  await menu('openReportsHub'); await sleep(100);
  await p.click('#showSpendingCategory'); await sleep(250);
  ok('report chart opens', await vis('#spendingCategoryModal'));
  await p.click('#spendingCategoryModal [data-action="backToReports"]'); await sleep(150);
  ok('"All reports" goes back to the list', await vis('#reportsHubModal') && !(await vis('#spendingCategoryModal')));
  ok('category badges have icons', (await p.$$('#budgetTable .category-badge i')).length > 0);
  await p.click('#showYearSummary'); await sleep(200);
  ok('year summary opens', await vis('#yearModal') && (await p.$$('#yearTable tbody tr')).length > 0);
  await shot('year.png', '.year-content');
  await p.click('#yearExport'); await sleep(1200);
  const summaryFile = fs.readdirSync(DL).find(f => /Summary\.xlsx$/.test(f));
  ok('year summary exports', !!summaryFile);
  if (summaryFile) fs.unlinkSync(path.join(DL, summaryFile));
  await p.keyboard.press('Escape'); await sleep(100);

  // Transactions collapse arrow sits at the far right of its header (like Overview)
  const arrowRight = await p.evaluate(() => {
    const head = document.querySelector('.table-section .table-header').getBoundingClientRect();
    const btn = document.querySelector('[data-collapse="table"]').getBoundingClientRect();
    return head.right - btn.right;
  });
  ok('Transactions arrow is on the right', arrowRight >= 0 && arrowRight < 8, String(arrowRight));

  // Similar names: suggest, merge, and the dashboard groups them
  await p.evaluate(() => {
    budgetData.push(normalizeRow({ 'Date': `${dashActive}-03`, 'Purchased Store': 'House rent', 'Debit [D]': 900, 'Amount Total': 900 }));
    budgetData.push(normalizeRow({ 'Date': `${dashActive}-04`, 'Purchased Store': 'Home rent', 'Debit [D]': 900, 'Amount Total': 900 }));
    renderTable();
  });
  await menu('openReportsHub'); await sleep(100); await p.click('#showYearSummary'); await sleep(250);
  ok('similar names suggested', /House rent/.test(await text('#yearNames') || '') && /Home rent/.test(await text('#yearNames') || ''));
  const pairBtn = await p.evaluateHandle(() => [...document.querySelectorAll('[data-action="mergeSuggestion"]')].find(b => /House rent/.test(b.textContent)));
  await pairBtn.click(); await sleep(250);
  ok('merge saved', await p.evaluate(() => getSettings().aliases['home rent'] === 'House rent'));
  await p.keyboard.press('Escape'); await sleep(100);
  const storeNames = await p.$$eval('#dashTopStores .top-name', els => els.map(e => e.textContent));
  ok('dashboard counts merged names as one', storeNames.filter(n => n === 'House rent').length === 1 && !storeNames.includes('Home rent'), storeNames.join('|'));
  await p.evaluate(() => { budgetData = budgetData.filter(r => !/^(house|home) rent$/i.test(r['Purchased Store'])); renderTable(); });

  // Collapse a section, and it stays collapsed after a reload
  await tap('[data-collapse="entry"]'); await sleep(100);
  ok('collapse hides the add form', !(await vis('#entryCard .controls')));
  ok('collapse state remembered', await p.evaluate(() => JSON.parse(localStorage.getItem('spendwise_collapsed')).entry === true));
  await tap('[data-collapse="entry"]'); await sleep(100);
  ok('expand shows it again', await vis('#entryCard .controls'));

  // Year report from separate monthly files (the list on screen is not changed)
  const monthFiles = [];
  for (const [i, m] of [[0, 'Jan'], [1, 'Feb'], [2, 'Mar']]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { 'Date': `2025-${pad(i + 1)}-01`, 'Purchased By': 'Harsha', 'Purchased Store': 'Payroll', 'Bank Name': 'Scotia Debit', 'Debit [D]': '', 'Credit [C]': 1000, 'Amount Total': 1000 },
      { 'Date': `2025-${pad(i + 1)}-05`, 'Purchased By': 'Harsha', 'Purchased Store': 'Costco', 'Bank Name': 'Amex', 'Debit [D]': 100, 'Credit [C]': '', 'Amount Total': 100 }
    ]), 'Sheet1');
    const f = path.join(TMP, `${m}-2025.xlsx`);
    fs.writeFileSync(f, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    monthFiles.push(f);
  }
  monthFiles.push(monthFiles[1]); // same file twice → counted once
  const listBefore = await p.evaluate(() => budgetData.length);
  await menu('openReportsHub'); await sleep(100); await p.click('#showYearSummary'); await sleep(200);
  await (await p.$('#yearFilesInput')).uploadFile(...monthFiles); await sleep(900);
  ok('year files load without touching the list', await p.evaluate(() => budgetData.length) === listBefore);
  ok('year files: 3 months, duplicates once', /3 of 12 months/.test(await text('#yearMonths') || '') && /6 transactions/.test(await text('#yearSourceTitle') || ''), await text('#yearSourceTitle'));
  await p.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await p.click('#yearPdf'); await sleep(400);
  const report = await p.$eval('#printReport', el => el.textContent.replace(/\s+/g, ' '));
  ok('PDF report opens print with month-by-month figures', await p.evaluate(() => window.__printed === true) &&
    /2025 Annual Report/.test(report) && /January\s*\$1,000\.00\s*\$100\.00\s*\$900\.00\s*90%/.test(report), report.slice(0, 160));
  await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await p.click('#yearUseScreen'); await sleep(100);
  await p.keyboard.press('Escape'); await sleep(100);

  // Notes / tags
  await tap('#store'); await p.keyboard.type('Lake Louise Inn'); await p.keyboard.press('Escape');
  await p.type('#amount', '210'); await p.type('#notes', 'Banff trip');
  await tap('#addBtn'); await sleep(200);
  ok('note saved on the row', await p.evaluate(() => budgetData.some(r => r['Notes'] === 'Banff trip')));
  await tap('.note-chip'); await sleep(200);
  ok('note chip filters the table', (await p.$eval('#searchInput', el => el.value)) === 'Banff trip' && (await p.$$('#budgetTable tbody tr.txn-row')).length === 1);
  await p.click('#clearFilterBtn'); await sleep(150);
  const nChecks = await p.$$('.row-check'); await nChecks[0].click(); await nChecks[1].click(); await sleep(80);
  await p.type('#bulkNote', 'Banff trip'); await p.click('#bulkNoteApply'); await sleep(150);
  ok('bulk tagging', await p.evaluate(() => budgetData.filter(r => r['Notes'] === 'Banff trip').length) >= 2);

  // Monthly PDF report (print is stubbed)
  await p.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
  await tap('#downloadBtn'); await sleep(120);
  ok('Save opens a menu with Excel and PDF', await vis('#saveMenu') && /Excel/.test(await text('#saveMenu') || '') && /PDF report/.test(await text('#saveMenu') || ''));
  await p.click('#savePdfItem'); await sleep(400);
  const monthReport = await p.$eval('#printReport', el => el.textContent.replace(/\s+/g, ' '));
  ok('monthly PDF report', await p.evaluate(() => window.__printed) && /Report/.test(monthReport) && /All transactions/.test(monthReport) && /Banff trip/.test(monthReport), monthReport.slice(0, 120));
  await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // Savings goal
  await menu('openSettingsModal'); await sleep(150);
  await p.type('#goalName', 'Japan trip'); await p.type('#goalTarget', '3000');
  await p.click('[data-action="addGoal"]'); await sleep(120);
  await p.keyboard.press('Escape'); await sleep(100);
  ok('goal panel shows', await vis('#goalsPanel'));
  await p.$eval('#goalsList .goal-add input', el => { el.value = '450'; });
  await tap('#goalsList [data-action="addToGoal"]'); await sleep(150);
  ok('money added to goal', await p.evaluate(() => getSettings().goals[0].saved === 450) && /\$450\.00/.test(await text('#goalsList') || ''));

  // Bill reminder: a bill due in 2 days that isn't recorded yet
  await p.evaluate(() => {
    const s = getSettings();
    const d = new Date(); d.setDate(d.getDate() + 2);
    const sameMonth = d.getMonth() === new Date().getMonth();
    s.recurring.push({ desc: 'Water bill', amount: 42, day: sameMonth ? d.getDate() : new Date().getDate(), payer: 'Harsha', bank: 'Amex', type: 'D' });
    saveSettings(s); renderTable();
  });
  ok('bill reminder shows', /Water bill/.test(await text('#reminders') || ''));
  const rowsBeforeBill = await p.evaluate(() => budgetData.length);
  const addIt = await p.evaluateHandle(() => [...document.querySelectorAll('#reminders .reminder')].find(el => /Water bill/.test(el.textContent)).querySelector('[data-action="recordReminder"]'));
  await addIt.evaluate(el => el.click()); await sleep(150);
  ok('"Add it" records the bill and clears the reminder', await p.evaluate(() => budgetData.length) === rowsBeforeBill + 1 && !/Water bill/.test(await text('#reminders') || ''));

  // Footer brand: "Moneta™" sits together, centred
  ok('footer brand aligned', await p.evaluate(() => getComputedStyle(document.querySelector('.app-footer .brand')).display !== 'inline-flex'));

  // Large lists: first 300 rows drawn, totals still cover every row
  const paged = await p.evaluate(() => {
    const keep = budgetData;
    const many = Array.from({ length: 650 }, (_, i) => normalizeRow({ 'Date': `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`, 'Purchased Store': 'Bulk ' + i, 'Debit [D]': 1, 'Amount Total': 1 }));
    budgetData = many;
    renderTable();
    const first = document.querySelectorAll('#budgetTable tr.txn-row').length;
    const footer = document.querySelector('.table-totals').textContent;
    document.querySelector('[data-action="showMoreRows"]').click();
    const second = document.querySelectorAll('#budgetTable tr.txn-row').length;
    budgetData = keep;
    renderTable();
    return { first, second, footer };
  });
  ok('large lists draw 300 rows, then 300 more', paged.first === 300 && paged.second === 600, JSON.stringify(paged));
  ok('totals include rows not drawn yet', /650 transactions/.test(paged.footer) && /\$650\.00/.test(paged.footer), paged.footer);

  // Save: one file per month
  const n = await p.evaluate(() => budgetData.length);
  await tap('#downloadBtn'); await sleep(120);
  await p.click('#saveExcelItem'); await sleep(1500);
  const files = fs.readdirSync(DL);
  let saved = 0;
  files.forEach(f => { const wb = XLSX.read(fs.readFileSync(path.join(DL, f))); saved += XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]).length; });
  ok('every row saved once', saved === n, `${saved}/${n} in ${files.join(',')}`);
  ok('badge cleared', !(await vis('#unsavedBadge')));

  // A workbook with a sheet per month: all sheets read, and Save puts each month back on its sheet
  {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['My notes'], ['keep this']]), 'Notes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { 'Date': '2026-01-04', 'Purchased By': 'Harsha', 'Purchased Store': 'Costco', 'Bank Name': 'Amex', 'Debit [D]': 120, 'Credit [C]': '', 'Amount Total': 120 },
      { 'Date': '2026-01-15', 'Purchased By': 'Harsha', 'Purchased Store': 'Payroll', 'Bank Name': 'Scotia Debit', 'Debit [D]': '', 'Credit [C]': 4200, 'Amount Total': 4200 }
    ]), 'Jan 2026');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { 'Date': '2026-02-06', 'Purchased By': 'Cherry', 'Purchased Store': 'Rogers', 'Bank Name': 'PC', 'Debit [D]': 95, 'Credit [C]': '', 'Amount Total': 95 }
    ]), 'Feb 2026');
    const multi = path.join(TMP, 'multi.xlsx');
    fs.writeFileSync(multi, XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    await (await p.$('#uploadFile')).uploadFile(multi); await sleep(700);
    ok('every month sheet is read (notes sheet ignored)', await p.evaluate(() => budgetData.length) === 3);
    await p.evaluate(() => {
      budgetData.push(normalizeRow({ 'Date': '2026-02-20', 'Purchased By': 'Harsha', 'Purchased Store': 'Shell', 'Debit [D]': 60, 'Amount Total': 60 }));
      markChanged(); renderTable();
    });
    await tap('#downloadBtn'); await sleep(120);
    await p.click('#saveExcelItem'); await sleep(1500);
    const saved = XLSX.read(fs.readFileSync(path.join(DL, 'multi.xlsx')));
    const count = name => XLSX.utils.sheet_to_json(saved.Sheets[name]).length;
    ok('save keeps the sheet layout: Notes untouched, Jan 2 rows, Feb 2 rows',
      saved.SheetNames.join('|') === 'Notes|Jan 2026|Feb 2026' && count('Jan 2026') === 2 && count('Feb 2026') === 2 &&
      XLSX.utils.sheet_to_json(saved.Sheets['Notes'], { header: 1 })[1][0] === 'keep this', saved.SheetNames.join('|'));
  }

  // Settings → Categories: rename, hide, reset
  await menu('openSettingsModal'); await sleep(150);
  await p.click('#builtinCats [data-action="startCategoryEdit"][data-cat="SPA"]'); await sleep(80);
  await p.$eval('#builtinCats .cat-edit-name', el => { el.value = 'Personal care'; });
  await p.click('#builtinCats [data-action="saveCategoryEdit"][data-cat="SPA"]'); await sleep(150);
  ok('rename a built-in category', await p.evaluate(() => categorizeStore('Great Clips haircut')) === 'Personal care' &&
    await p.evaluate(() => [...document.getElementById('category').options].some(o => o.value === 'Personal care')));
  await p.click('#builtinCats [data-action="toggleCategoryHidden"][data-cat="Movie"]'); await sleep(120);
  ok('hide a category removes it from the picker', await p.evaluate(() => ![...document.getElementById('category').options].some(o => o.value === 'Movie')));
  ok('Income cannot be hidden', !(await p.$('#builtinCats [data-action="toggleCategoryHidden"][data-cat="Income"]')));
  await p.click('#builtinCats [data-action="resetCategoryEdit"][data-cat="SPA"]'); await sleep(120);
  await p.click('#builtinCats [data-action="toggleCategoryHidden"][data-cat="Movie"]'); await sleep(120);
  ok('reset brings the default back', await p.evaluate(() => categorizeStore('Great Clips haircut')) === 'SPA');
  await shot('categories.png', '.settings-content');
  await p.keyboard.press('Escape'); await sleep(100);

  // Compare months
  await menu('openCompareModal'); await sleep(150);
  await (await p.$('#compareFilesInput')).uploadFile(excel); await sleep(800);
  ok('compare months summary', await vis('#comparisonSummary'));
  await p.keyboard.press('Escape');

  // Draft restore
  await p.type('#store', 'Draft test'); await p.type('#amount', '5'); await p.click('#addBtn'); await sleep(150);
  const nDraft = await p.evaluate(() => budgetData.length);
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(300);
  ok('fresh visit is blank', await p.evaluate(() => budgetData.length) === 0);
  ok('restore bar is visible at the top', await p.evaluate(() => scrollY === 0));
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

  // 10. Clear this device removes everything Moneta stored
  await menu('openSettingsModal'); await sleep(150);
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('[data-action="clearDeviceData"]')]);
  ok('clear device wipes stored data', await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('spendwise_')).length === 0));

  ok('no console or CSP errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra && !r.pass ? ' — ' + r.extra : ''}`));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)); process.exit(1); });
