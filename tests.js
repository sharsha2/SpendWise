/* Moneta unit tests — run with: node tests.js
   Extracts the pure functions from app.js (no browser needed) and checks
   money precision, date normalization, and category detection. */
const fs = require('fs');
global.XLSX = require('./vendor/xlsx/xlsx.full.min.js');

const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

function extract(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b <= a) throw new Error('could not extract: ' + startMarker);
  return src.slice(a, b);
}

// Settings stub with one custom category to test user-keyword precedence
// No remembered stores in unit tests (learned categories are browser-only)
global.learnedCategory = () => '';
global.getSettings = () => ({
  people: [], banks: [], budgets: {}, recurring: [],
  categories: { 'Lawn Care': ['lawn', 'mowing'] }
});

eval(extract('function toCents', 'function debounce'));                    // toCents, sumCents, escapeHtml
eval(extract('const TRANSFER_GROUP', '// Manage People')
  .replace('const TRANSFER_GROUP', 'var TRANSFER_GROUP').replace('let categoryCache', 'var categoryCache'));           // groups, flat map, group lookup
eval(extract('const keywordRegexCache', 'function getCategoryBadge')
  .replace('const keywordRegexCache', 'var keywordRegexCache'));           // categorizeStore
eval(extract('function excelDateToStr', 'function uploadExcel'));          // date + row normalization
eval(extract('// ---- Pure calculation helpers', '// ---- end pure helpers'));  // months, totals, duplicates, save groups

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + ' — ' + e.message); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || 'value'}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

// ---- Money precision ----
t('toCents avoids float drift (10 × $0.10 = $1.00 exactly)', () => {
  const rows = Array.from({ length: 10 }, () => ({ 'Debit [D]': 0.1 }));
  eq(sumCents(rows, 'Debit [D]'), 100);
});

t('sumCents ignores blanks and bad values', () => {
  eq(sumCents([{ a: '' }, { a: null }, { a: 'x' }, { a: 2.5 }], 'a'), 250);
});

// ---- Date normalization ----
t('ISO date strings pass through', () => eq(excelDateToStr('2026-07-03'), '2026-07-03'));
t('Excel serial numbers convert (46236 → 2026-08-02)', () => eq(excelDateToStr(46236), '2026-08-02'));
t('US-style dates convert (08/21/2026)', () => eq(excelDateToStr('08/21/2026'), '2026-08-21'));
t('empty date stays empty', () => eq(excelDateToStr(''), ''));

// ---- Row normalization (old-file compatibility) ----
t('legacy row without Category keeps all fields', () => {
  const r = normalizeRow({ 'Date': '2026-07-03', 'Purchased By': 'Harsha', 'Purchased Store': 'Tim Hortons', 'Bank Name': 'Amex', 'Debit [D]': 5.5, 'Amount Total': 5.5 });
  eq(r['Date'], '2026-07-03');
  eq(r['Debit [D]'], 5.5);
  eq(r['Credit [C]'], '');
  eq('Category' in r, false, 'no Category key added');
});

t('missing Amount Total is computed from debit+credit', () => {
  eq(normalizeRow({ 'Date': '2026-08-01', 'Debit [D]': 92.13 })['Amount Total'], 92.13);
});

// ---- Category detection ----
const cases = [
  ['Rogers phone bill', 'Phone & Internet'],
  ['Hydro One', 'Utilities'],
  ['Enbridge gas bill', 'Utilities'],
  ['Petro Canada gas', 'Gas'],
  ['Scotia credit card payment', 'Credit Card Payment'],
  ['Spotify', 'Subscriptions'],
  ['No Frills', 'Groceries'],
  ['Tim Hortons', 'Dining'],
  ['Taco Bell', 'Dining'],
  ['Great Clips haircut', 'SPA'],          // 'eat' must not match inside 'Great'
  ['Gift card for mom', 'Gifts & Donations'], // 'car' must not match inside 'card'
  ['Lawn mowing service', 'Lawn Care'],    // custom category wins
  ['Some Unknown Vendor', 'Other']
];
cases.forEach(([store, want]) =>
  t(`categorize "${store}" → ${want}`, () => eq(categorizeStore(store), want)));

t('no old category name was lost', () => {
  const flat = Object.keys(getCategoryMap());
  const legacy = ['Income', 'Rent', 'SPA', 'Dining', 'Groceries', 'Bills', 'Loans', 'Software', 'Flight', 'Travel', 'Movie', 'India', 'Gas', 'Transit', 'Health', 'Fitness', 'Insurance', 'Education', 'Kids', 'Pets', 'Gifts & Donations', 'Electronics', 'Home', 'Investment', 'Taxes & Fees', 'Shopping'];
  const missing = legacy.filter(c => !flat.includes(c));
  eq(missing.length, 0, 'missing: ' + missing.join(', '));
});

t('sub-category maps to its group', () => eq(getCategoryGroup('Utilities'), 'Bills & Utilities'));

t('escapeHtml neutralizes markup', () =>
  eq(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;'));

// ---- Old Excel files ----
t('old file without Category column loads (serial date, numeric strings)', () => {
  const row = normalizeRow({ 'Date': 46326, 'Purchased By': 'Harsha', 'Purchased Store': ' Costco ', 'Bank Name': 'Amex', 'Debit [D]': '85.5', 'Amount Total': '85.5' });
  eq(row['Date'], '2026-10-31', 'date');
  eq(row['Purchased Store'], 'Costco', 'store trimmed');
  eq(row['Debit [D]'], 85.5, 'debit');
  eq(row['Credit [C]'], '', 'credit');
  eq('Category' in row, false, 'no category key');
});

t('amounts typed as text are read correctly', () => {
  eq(parseAmount('$1,234.56'), 1234.56);
  eq(parseAmount(' 45.10 '), 45.1);
  eq(parseAmount('(25.00)'), -25);
  eq(parseAmount('25.00-'), -25);
  eq(parseAmount('CA$ 12'), 12);
  eq(parseAmount(''), '');
  eq(parseAmount(87.5), 87.5);
  const r = normalizeRow({ 'Date': '2026-11-02', 'Purchased Store': 'Shell', 'Debit [D]': '$1,060.40' });
  eq(r['Debit [D]'], 1060.4, 'text debit kept');
  eq(r['Amount Total'], 1060.4, 'total computed');
});

t('a negative debit becomes a credit (and the other way round)', () => {
  const a = normalizeRow({ 'Date': '2026-11-02', 'Debit [D]': -50 });
  eq(a['Debit [D]'], ''); eq(a['Credit [C]'], 50); eq(a['Amount Total'], 50);
  const b = normalizeRow({ 'Date': '2026-11-02', 'Credit [C]': '(20.00)' });
  eq(b['Debit [D]'], 20); eq(b['Credit [C]'], '');
});

t('total / balance rows in a sheet are not transactions', () => {
  eq(isSummaryRow({ 'Purchased Store': 'Total', 'Debit [D]': 999 }), true);
  eq(isSummaryRow({ 'Purchased Store': 'Grand total', 'Debit [D]': 999 }), true);
  eq(isSummaryRow({ 'Date': '', 'Purchased Store': '', 'Debit [D]': 999 }), true, 'formula row');
  eq(isSummaryRow({ 'Purchased Store': 'Total Wine & More', 'Date': '2026-11-02', 'Debit [D]': 40 }), false, 'dated store named Total is kept');
  eq(isSummaryRow({ 'Purchased Store': 'Costco', 'Debit [D]': 40 }), false, 'undated purchase with a store is kept');
  eq(isSummaryRow({ 'Date': '2026-11-02', 'Purchased Store': 'Costco', 'Debit [D]': 40 }), false);
});

t('every transaction sheet is read; notes sheets and total rows are skipped', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Shopping list'], ['milk']]), 'Notes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { 'Date': '2026-01-05', 'Purchased Store': 'Costco', 'Debit [D]': 100 },
    { 'Date': '2026-01-09', 'Purchased Store': 'Payroll', 'Credit [C]': 4000 }
  ]), 'Jan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { 'Date': '2026-02-03', 'Purchased Store': 'Rogers', 'Debit [D]': 95 },
    { 'Date': '', 'Purchased Store': 'Total', 'Debit [D]': 95 }
  ]), 'Feb');
  const r = readWorkbookRows(wb);
  eq(r.sheets.map(s => s.name).join(','), 'Jan,Feb');
  eq(r.rows.length, 3);
  eq(r.summaryRows, 1);
});

t('a file with unusual headers still opens its first sheet', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ 'Purchased Store': 'Costco', 'Debit [D]': 10 }]), 'Sheet1');
  eq(readWorkbookRows(wb).rows.length, 1);
});

// ---- Dashboard math ----
t('periodTotals: spent, income, net and savings rate in exact cents', () => {
  const rows = [
    { 'Debit [D]': 0.1 }, { 'Debit [D]': 0.2 }, { 'Purchased Store': 'Payroll', 'Credit [C]': 1000 }, { 'Debit [D]': 249.7 }
  ];
  const p = periodTotals(rows);
  eq(p.spent, 250, 'spent');
  eq(p.income, 1000, 'income');
  eq(p.net, 750, 'net');
  eq(p.rate, 75, 'rate');
});

t('periodTotals: no income means no savings rate (not -Infinity)', () =>
  eq(periodTotals([{ 'Debit [D]': 10 }]).rate, null));

t('shiftMonth crosses year boundaries', () => {
  eq(shiftMonth('2026-01', -1), '2025-12');
  eq(shiftMonth('2026-12', 1), '2027-01');
});

t('monthKeyOf ignores bad dates', () => {
  eq(monthKeyOf({ 'Date': '2026-11-05' }), '2026-11');
  eq(monthKeyOf({ 'Date': 'sometime' }), null);
  eq(monthKeyOf({}), null);
});

// ---- Transfers & refunds ----
t('credit card payment is a transfer on both sides (no double counting)', () => {
  const rows = [
    { 'Purchased Store': 'Costco', 'Debit [D]': 100 },                        // bought on Amex
    { 'Purchased Store': 'Amex credit card payment', 'Debit [D]': 100 },      // paid from chequing
    { 'Purchased Store': 'Payment - thank you', 'Credit [C]': 100 }           // seen on the Amex statement
  ];
  const p = periodTotals(rows);
  eq(p.spent, 100, 'spent counted once');
  eq(p.income, 0, 'payment is not income');
});

t('refund lowers spending instead of counting as income', () => {
  const rows = [
    { 'Purchased Store': 'Amazon', 'Debit [D]': 80 },
    { 'Purchased Store': 'Amazon refund', 'Credit [C]': 30 },
    { 'Purchased Store': 'Payroll', 'Credit [C]': 2000 }
  ];
  const p = periodTotals(rows);
  eq(p.spent, 50, 'spent');
  eq(p.income, 2000, 'income');
  eq(classify(rows[1]).kind, 'refund');
});

t('investing (TFSA/RRSP) is savings, not spending', () =>
  eq(classify({ 'Purchased Store': 'TFSA contribution', 'Debit [D]': 500 }).kind, 'transfer'));

t('e-transfer to a person still counts as spending', () =>
  eq(classify({ 'Purchased Store': 'Interac e-Transfer to John', 'Debit [D]': 40 }).spend, 4000));

t('manual Income category on a credit counts as income', () =>
  eq(classify({ 'Purchased Store': 'Sold bike', 'Category': 'Income', 'Credit [C]': 120 }).income, 12000));

// ---- Duplicates ----
t('duplicate check matches same date/store/amount, ignoring case and spaces', () => {
  const rows = [{ 'Date': '2026-11-01', 'Purchased Store': 'Costco', 'Debit [D]': 85 }];
  eq(findDuplicate(rows, { 'Date': '2026-11-01', 'Purchased Store': ' costco ', 'Debit [D]': 85.0 }), 0);
  eq(findDuplicate(rows, { 'Date': '2026-11-02', 'Purchased Store': 'Costco', 'Debit [D]': 85 }), -1);
  eq(findDuplicate(rows, rows[0], 0), -1, 'editing a row is not its own duplicate');
});

t('countDuplicates counts repeats only', () =>
  eq(countDuplicates([{ 'Date': 'a', 'Debit [D]': 1 }, { 'Date': 'a', 'Debit [D]': 1 }, { 'Date': 'b' }]), 1));

// ---- Saving: one file per month ----
t('save groups: opened file keeps its months, new months get their own file', () => {
  const rows = [
    { 'Date': '2026-10-20' }, { 'Date': '2026-09-02' }, { 'Date': '2026-11-01' }, { 'Date': '' }
  ];
  const g = groupForSave(rows, ['2026-10', '2026-09'], '2026-11');
  eq([...g.keys()].join(','), 'source,2026-11');
  eq(g.get('source').length, 3, 'Oct + Sep + undated stay in the opened file');
  eq(g.get('2026-11').length, 1);
});

t('save groups: nothing opened → one file per month, undated join the newest', () => {
  const g = groupForSave([{ 'Date': '2026-10-20' }, { 'Date': '2026-11-01' }, { 'Date': 'x' }], null, '2026-12');
  eq(g.get('2026-10').length, 1);
  eq(g.get('2026-11').length, 2);
});

t('save groups: every row is saved exactly once', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ 'Date': `2026-${String((i % 12) + 1).padStart(2, '0')}-10` }));
  const g = groupForSave(rows, ['2026-03'], '2026-11');
  eq([...g.values()].reduce((n, list) => n + list.length, 0), 50);
});

// ---- Store autocomplete ranking ----
t('autocomplete: starts-with beats word match beats contains; your stores first', () => {
  const entries = [
    { name: 'Discount Store', count: 9, mine: true },
    { name: 'Costco', count: 3, mine: true },
    { name: 'The Cosmetics Shop', count: 5, mine: true },
    { name: 'Cost Plus', count: 0, mine: false }
  ];
  eq(rankStoreSuggestions('cos', entries, 6).map(e => e.name).join(','), 'Costco,The Cosmetics Shop,Cost Plus');
});

t('autocomplete: more-used store wins a tie; exact match and empty query give nothing new', () => {
  const entries = [{ name: 'Tim Hortons', count: 2, mine: true }, { name: 'Tims Pizza', count: 7, mine: true }];
  eq(rankStoreSuggestions('tim', entries, 6)[0].name, 'Tims Pizza');
  eq(rankStoreSuggestions('tim hortons', entries, 6).length, 0);
  eq(rankStoreSuggestions('  ', entries, 6).length, 0);
});

// ---- Settle up ----
t('settle up: two people', () => {
  const t1 = settleUp({ Harsha: 30000, Cherry: 10000 });
  eq(t1.length, 1); eq(t1[0].from, 'Cherry'); eq(t1[0].to, 'Harsha'); eq(t1[0].cents, 10000);
});

t('settle up: three people, cents balance exactly', () => {
  const paid = { A: 10001, B: 0, C: 0 };
  const tr = settleUp(paid);
  const net = { A: paid.A, B: 0, C: 0 };
  tr.forEach(x => { net[x.from] += x.cents; net[x.to] -= x.cents; });
  const vals = Object.values(net);
  eq(Math.max(...vals) - Math.min(...vals) <= 1, true, 'shares within 1 cent');
  eq(tr.reduce((s, x) => s + x.cents, 0), 6667, 'total moved');
});

t('settle up: already even → nothing to pay', () => eq(settleUp({ A: 500, B: 500 }).length, 0));

// ---- Subscription detection ----
t('detects monthly charges with steady amounts, ignores one-offs and transfers', () => {
  const rows = [
    { 'Date': '2026-09-03', 'Purchased Store': 'Netflix', 'Debit [D]': 16.99 },
    { 'Date': '2026-10-03', 'Purchased Store': 'Netflix', 'Debit [D]': 16.99 },
    { 'Date': '2026-11-03', 'Purchased Store': 'netflix', 'Debit [D]': 17.49 },
    { 'Date': '2026-10-10', 'Purchased Store': 'Best Buy', 'Debit [D]': 600 },
    { 'Date': '2026-11-10', 'Purchased Store': 'Best Buy', 'Debit [D]': 40 },       // not steady
    { 'Date': '2026-10-01', 'Purchased Store': 'TFSA contribution', 'Debit [D]': 500 },
    { 'Date': '2026-11-01', 'Purchased Store': 'TFSA contribution', 'Debit [D]': 500 } // transfer
  ];
  const found = detectRecurring(rows, []);
  eq(found.length, 1);
  eq(found[0].desc, 'netflix');
  eq(found[0].months, 3);
  eq(found[0].day, 3);
  eq(found[0].amount, 16.99);
});

t('already-recurring stores are not suggested again', () => {
  const rows = [{ 'Date': '2026-10-03', 'Purchased Store': 'Rogers', 'Debit [D]': 95 }, { 'Date': '2026-11-03', 'Purchased Store': 'Rogers', 'Debit [D]': 95 }];
  eq(detectRecurring(rows, [{ desc: 'rogers' }]).length, 0);
});

// ---- Year summary ----
t('year summary: per-category months, refunds subtracted, transfers excluded', () => {
  const rows = [
    { 'Date': '2026-01-05', 'Purchased Store': 'Costco', 'Debit [D]': 100 },
    { 'Date': '2026-01-20', 'Purchased Store': 'Costco refund', 'Credit [C]': 20 },
    { 'Date': '2026-03-01', 'Purchased Store': 'Payroll', 'Credit [C]': 3000 },
    { 'Date': '2026-03-02', 'Purchased Store': 'Amex credit card payment', 'Debit [D]': 500 },
    { 'Date': '2025-12-31', 'Purchased Store': 'Costco', 'Debit [D]': 999 }
  ];
  const y = yearSummary(rows, '2026');
  eq(y.categories.length, 1);
  eq(y.categories[0].name, 'Groceries');
  eq(y.categories[0].months[0], 8000, 'Jan net of refund');
  eq(y.spent[2], 0, 'card payment not spending');
  eq(y.income[2], 300000);
  eq(y.net[0], -8000);
});

// ---- Name cleanup ----
t('nameKey ignores case, punctuation and store numbers', () => {
  eq(nameKey('COSTCO #512'), 'costco');
  eq(nameKey('Costco 512'), 'costco');
  eq(nameKey('  Tim  Hortons. '), 'tim hortons');
  eq(nameKey('7-Eleven'), 'eleven'); // digits-only token dropped; still one key for every branch
});

t('similar names are suggested; different ones are not', () => {
  const n = (name, count = 1) => ({ key: nameKey(name), name, count });
  const pairs = findSimilarNames([n('House rent', 5), n('Home rent', 3), n('Netflix'), n('Rogers'), n('Shell'), n('Shell Gas')], new Set());
  const ids = pairs.map(p => p.id);
  eq(ids.includes('home rent|house rent'), true, 'house/home rent');
  eq(ids.includes('shell|shell gas'), true, 'shell / shell gas');
  eq(ids.some(id => id.includes('netflix')), false, 'netflix not paired');
});

t('a pair you marked "not the same" is not suggested again', () => {
  const n = name => ({ key: nameKey(name), name, count: 1 });
  eq(findSimilarNames([n('House rent'), n('Home rent')], new Set(['home rent|house rent'])).length, 0);
});

// ---- Notes, goals, reminders ----
t('notes column is optional: old files load, new files keep the note', () => {
  eq('Notes' in normalizeRow({ 'Date': '2026-11-01', 'Debit [D]': 5 }), false);
  eq(normalizeRow({ 'Date': '2026-11-01', 'Debit [D]': 5, 'Notes': '  Banff   trip ' })['Notes'], 'Banff trip');
});

t('goal plan: amount left and per-month need, this month included', () => {
  const p = goalPlan({ target: 3000, saved: 600, by: '2027-04' }, '2026-11');
  eq(p.leftC, 240000);
  eq(p.monthsLeft, 6);          // Nov..Apr
  eq(p.perMonthC, 40000);       // $400 a month
  eq(Math.round(p.pct), 20);
  eq(goalPlan({ target: 100, saved: 100, by: '' }, '2026-11').done, true);
});

t('reminders: bills due within 5 days or overdue, unless recorded or dismissed', () => {
  const rec = [
    { desc: 'Rent', amount: 1800, day: 30, type: 'D' },
    { desc: 'Rogers', amount: 95, day: 7, type: 'D' },
    { desc: 'Netflix', amount: 16.99, day: 3, type: 'D' },
    { desc: 'Payroll', amount: 4200, day: 1, type: 'C' }
  ];
  const rows = [{ 'Date': '2026-11-03', 'Purchased Store': 'NETFLIX', 'Debit [D]': 16.99 }];
  const due = dueReminders(rec, rows, '2026-11-26', 5, new Set());
  eq(due.map(d => d.rec.desc).join(','), 'Rogers,Rent', 'overdue first; recorded and income skipped');
  eq(due[0].overdue, true);
  eq(due[1].daysUntil, 4);
  eq(dueReminders(rec, rows, '2026-11-26', 5, new Set(['rogers|2026-11'])).length, 1, 'dismissed');
  eq(dueReminders([{ desc: 'Rent', amount: 1, day: 31, type: 'D' }], [], '2026-11-28', 5, new Set())[0].date, '2026-11-30', 'day 31 → last day');
});

// ---- Editing built-in categories ----
t('renamed, re-keyworded and hidden categories apply everywhere; locked ones stay', () => {
  const original = global.getSettings;
  const base = original();
  global.getSettings = () => ({ ...base, categoryEdits: {
    'SPA': { name: 'Personal care', formerNames: ['Beauty'] },
    'Movie': { hidden: true },
    'Income': { hidden: true },                    // locked: must stay
    'Fitness': { keywords: ['climbing gym'] }
  } });
  invalidateCategoryCache();
  try {
    eq(categorizeStore('Great Clips haircut'), 'Personal care', 'renamed category matches');
    eq(getCategory({ 'Category': 'SPA' }), 'Personal care', 'old name in a file maps to the new one');
    eq(getCategory({ 'Category': 'Beauty' }), 'Personal care', 'an earlier rename maps too');
    eq(Object.keys(getCategoryMap()).includes('Movie'), false, 'hidden category gone');
    eq(categorizeStore('Netflix') === 'Movie', false, 'its stores match something else');
    eq(categorizeStore('Payroll'), 'Income', 'Income cannot be hidden');
    eq(categorizeStore('Downtown Climbing Gym'), 'Fitness', 'new keyword works');
    eq(categorizeStore('Goodlife'), 'Other', 'old keyword replaced');
  } finally {
    global.getSettings = original;
    invalidateCategoryCache();
  }
});

// ---- Budgets ----
t('forecast projects month-end spend from pace', () => {
  eq(forecastMonth(30000, 10, 30), 90000);   // $300 by day 10 → $900
  eq(forecastMonth(30000, 30, 30), 30000);   // finished month = actual
  eq(forecastMonth(0, 0, 30), 0);
});

t('budget status: over, at risk, on track', () => {
  eq(budgetStatus(70000, 60000, 90000), 'over');
  eq(budgetStatus(30000, 60000, 90000), 'risk');
  eq(budgetStatus(30000, 60000, 50000), 'ok');
  eq(budgetStatus(30000, 60000, null), 'ok');
});

// ---- Bank statement PDF parsing ----
const stmt = require('./statement-import.js');

t('card statement: purchases, payment, refund (CR) and totals skipped', () => {
  const r = stmt.parseStatementLines([
    'American Express Cobalt Card',
    'Statement period: Oct 3, 2026 to Nov 2, 2026',
    'Oct 3 Oct 4 COSTCO WHOLESALE W512 TORONTO 85.20',
    'Oct 7 Oct 8 PAYMENT RECEIVED - THANK YOU -500.00',
    'Oct 15 Oct 16 AMAZON.CA REFUND 23.99 CR',
    'Nov 1 Nov 2 NETFLIX.COM 16.99',
    'Nov 2 Total new charges 102.19'
  ]);
  eq(r.bank, 'Amex', 'bank');
  eq(r.kind, 'card', 'kind');
  eq(r.transactions.length, 4, 'count');
  eq(r.transactions[0].date, '2026-10-03');
  eq(r.transactions[0].cents, 8520);
  eq(r.transactions[0].type, 'D');
  eq(r.transactions[1].type, 'C', 'payment is a credit');
  eq(r.transactions[2].type, 'C', 'CR is a credit');
  eq(r.transactions[3].description, 'NETFLIX.COM');
});

t('card statement: trailing minus and parentheses are credits', () => {
  const r = stmt.parseStatementLines(['Scotiabank Scene+ Visa', 'Oct 10 Oct 11 PAYMENT FROM *****1234 400.00-', 'Oct 12 Oct 13 RETURN (19.99)']);
  eq(r.bank, 'Scotia Credit');
  eq(r.transactions.map(x => x.type).join(''), 'CC');
});

t('dates without a year cross New Year using the statement period', () => {
  const r = stmt.parseStatementLines(['Statement period: Dec 15, 2026 to Jan 14, 2027', 'Dec 20 STORE A 10.00', 'Jan 5 STORE B 5.00']);
  eq(r.transactions[0].date, '2026-12-20');
  eq(r.transactions[1].date, '2027-01-05');
});

t('chequing statement: running balance decides withdrawal vs deposit', () => {
  const r = stmt.parseStatementLines([
    'Scotiabank Basic Bank Account',
    'Opening balance 1,000.00',
    '2026-10-01 PAYROLL DEPOSIT 2,000.00 3,000.00',
    '2026-10-02 MISC PAYMENT 1,800.00 1,200.00',
    '2026-10-05 GROCERY STORE 50.25 1,149.75'
  ]);
  eq(r.kind, 'account');
  eq(r.bank, 'Scotia Debit');
  eq(r.transactions.map(x => x.type).join(''), 'CDD');
  eq(r.transactions.some(x => x.check), false, 'no guesses needed');
  eq(r.transactions[2].cents, 5025);
});

t('other date styles: "05 Oct 2026" and 10/05/2026', () => {
  const r = stmt.parseStatementLines(['05 Oct 2026 TIM HORTONS 4.50', '10/06/2026 SHELL 60.00']);
  eq(r.transactions[0].date, '2026-10-05');
  eq(r.transactions[1].date, '2026-10-06');
});

t('impossible dates and lines without amounts are ignored', () => {
  const r = stmt.parseStatementLines(['Feb 30 2026 STORE 1.00', 'Oct 3 Just some text', 'Oct 4 2026 REAL STORE 2.00']);
  eq(r.transactions.length, 1);
  eq(r.transactions[0].description, 'REAL STORE');
});

t('pdf text items are rebuilt into lines in reading order', () => {
  const item = (str, x, y, width) => ({ str, transform: [1, 0, 0, 1, x, y], width });
  const lines = stmt.itemsToLines([
    item('85.20', 400, 700, 30), item('Oct 3', 20, 700, 30), item('COSTCO', 80, 700.8, 40),
    item('Header', 20, 760, 40)
  ]);
  eq(lines.join(' | '), 'Header | Oct 3 COSTCO 85.20');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
