/* Moneta unit tests — run with: node tests.js
   Extracts the pure functions from app.js (no browser needed) and checks
   money precision, date normalization, and category detection. */
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

function extract(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b <= a) throw new Error('could not extract: ' + startMarker);
  return src.slice(a, b);
}

// Settings stub with one custom category to test user-keyword precedence
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
