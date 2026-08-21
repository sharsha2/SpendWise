/* SpendWise unit tests — run with: node tests.js
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

eval(extract('function toCents', 'function persistData'));                 // toCents, sumCents, escapeHtml
eval(extract('function getCategoryGroups', '// Manage People'));           // groups, flat map, group lookup
eval(extract('const keywordRegexCache', 'function getCategoryBadge')
  .replace('const keywordRegexCache', 'var keywordRegexCache'));           // categorizeStore
eval(extract('function excelDateToStr', 'function uploadExcel'));          // date + row normalization

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
