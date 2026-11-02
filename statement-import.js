/* Moneta — bank statement (PDF) import.
   The PDF is read entirely on this device with pdf.js; nothing is uploaded.
   Text lines are matched as "date … description … amount" and shown in a
   review dialog before anything is added. The parsing functions at the top
   are pure so tests.js can check them without a browser. */

const STATEMENT_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';

// One date at the start of `text`. Returns { month, day, year|null, length } or null.
function matchLeadingDate(text) {
  let m;
  if ((m = text.match(new RegExp('^' + MONTH_RE + '\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?(?=\\s|$)', 'i')))) {
    return { month: STATEMENT_MONTHS[m[1].toLowerCase()], day: +m[2], year: m[3] ? +m[3] : null, length: m[0].length };
  }
  if ((m = text.match(new RegExp('^(\\d{1,2})\\s+' + MONTH_RE + '(?:,?\\s+(\\d{4}))?(?=\\s|$)', 'i')))) {
    return { month: STATEMENT_MONTHS[m[2].toLowerCase()], day: +m[1], year: m[3] ? +m[3] : null, length: m[0].length };
  }
  if ((m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?=\s|$)/))) {
    return { month: +m[2], day: +m[3], year: +m[1], length: m[0].length };
  }
  if ((m = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s|$)/))) {
    let a = +m[1], b = +m[2];
    // Month/day unless the first number can't be a month
    const [month, day] = a > 12 ? [b, a] : [a, b];
    let year = m[3] ? +m[3] : null;
    if (year !== null && year < 100) year += 2000;
    return { month, day, year, length: m[0].length };
  }
  return null;
}

// Money like 1,234.56 / -12.00 / $45.10 / (30.00) / 30.00- / 30.00 CR
const MONEY_RE = /(^|\s)(-|−)?\$?\(?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\)?(-|−)?(\s?CR\b)?(?=\s|$)/gi;

function findMoney(text) {
  const out = [];
  let m;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(text))) {
    const cents = Number(m[3].replace(/,/g, '')) * 100 + Number(m[4]);
    const negative = !!(m[2] || m[5] || m[6] || /\(\s*[\d,]+\.\d{2}\s*\)/.test(m[0]));
    out.push({ cents, negative, index: m.index + m[1].length });
  }
  return out;
}

const SKIP_LINE_RE = /\b(opening balance|closing balance|balance forward|previous (statement )?balance|new balance|beginning balance|ending balance|total|sub-?total|minimum payment|payment due|interest rate|credit limit|available credit|amount due|statement balance)\b/i;
const OPENING_RE = /\b(opening balance|balance forward|previous (statement )?balance|beginning balance)\b/i;
const CREDIT_HINT_RE = /\b(deposit|payroll|salary|refund|return|credit|payment received|payment from|payment - thank you|payment thank you|interest paid|e-?transfer from|transfer from|reversal|cashback)\b/i;

function guessBank(text) {
  const t = text.toLowerCase();
  const card = /\b(visa|mastercard|credit card|card ?member|cardholder)\b/.test(t);
  if (/american express|\bamex\b/.test(t)) return 'Amex';
  if (/pc financial|president'?s choice/.test(t)) return 'PC';
  if (/simplii/.test(t)) return 'Simplii';
  if (/wealthsimple/.test(t)) return 'Wealthsimple';
  if (/scotiabank|scotia\b/.test(t)) return card ? 'Scotia Credit' : 'Scotia Debit';
  if (/\brbc\b|royal bank/.test(t)) return 'RBC';
  if (/\btd\b canada|td bank|toronto-dominion/.test(t)) return 'TD';
  if (/\bcibc\b/.test(t)) return 'CIBC';
  if (/\bbmo\b|bank of montreal/.test(t)) return 'BMO';
  if (/tangerine/.test(t)) return 'Tangerine';
  return '';
}

// Statement period, e.g. "Statement period: Oct 3, 2026 to Nov 2, 2026"
function findPeriod(text) {
  const month = MONTH_RE.replace('(', '(?:'); // no capture groups inside the date
  const date = month + '\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}';
  const m = text.match(new RegExp('(' + date + ')\\s*(?:to|-|–|—|through)\\s*(' + date + ')', 'i'));
  if (!m) return null;
  const toIso = s => {
    const d = matchLeadingDate(s.replace(',', ''));
    return d && d.year ? { y: d.year, m: d.month, d: d.day } : null;
  };
  const start = toIso(m[1]);
  const end = toIso(m[2]);
  return start && end ? { start, end } : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function validDay(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= new Date(y, m, 0).getDate();
}

// Picks the year for a date printed without one, using the statement period
function resolveYear(month, period, fallbackYear) {
  if (period) {
    if (period.start.y === period.end.y) return period.end.y;
    // Period crosses New Year: late months belong to the start year
    return month >= period.start.m ? period.start.y : period.end.y;
  }
  return fallbackYear;
}

/**
 * Parses text lines from a statement.
 * Returns { transactions, bank, kind: 'account'|'card', skipped }.
 * Each transaction: { date: 'YYYY-MM-DD', description, cents (>0), type: 'D'|'C', check }
 * (`check` marks rows whose direction was guessed and deserve a look).
 */
const DEBIT_HEAD_RE = /\b(withdrawals?|debits?|paid out|money out|charges|purchases)\b/i;
const CREDIT_HEAD_RE = /\b(deposits?|credits?|paid in|money in|payments)\b/i;

function parseStatementLines(lines, options = {}) {
  // Rows can be plain text or { text, cells } with positions (from the PDF)
  const rows = lines.map(r => (typeof r === 'string'
    ? { text: r.replace(/\s+/g, ' ').trim(), cells: null }
    : { text: r.text, cells: r.cells }));
  const text = rows.map(r => r.text).join('\n');
  const period = findPeriod(text);
  const years = (text.match(/\b20\d{2}\b/g) || []).map(Number);
  const fallbackYear = options.year || (years.length ? Math.max(...years) : new Date().getFullYear());

  const candidates = [];
  let opening = null;
  let skipped = 0;
  let columns = null; // { D: x, C: x } when the statement has Withdrawals / Deposits columns

  const centerOf = (row, index) => {
    if (!row.cells) return null;
    const c = row.cells.find(cell => index >= cell.start && index < cell.end);
    return c ? (c.x + c.right) / 2 : null;
  };

  rows.forEach(row => {
    const line = row.text;
    if (!line) return;
    // A header row naming both columns tells us where withdrawals and deposits sit
    if (row.cells && DEBIT_HEAD_RE.test(line) && CREDIT_HEAD_RE.test(line) && !matchLeadingDate(line)) {
      const d = row.cells.find(c => DEBIT_HEAD_RE.test(c.str));
      const c = row.cells.find(cell => CREDIT_HEAD_RE.test(cell.str));
      if (d && c && d !== c) columns = { D: (d.x + d.right) / 2, C: (c.x + c.right) / 2 };
      return;
    }
    if (OPENING_RE.test(line)) {
      const money = findMoney(line);
      if (money.length && opening === null) {
        const last = money[money.length - 1];
        opening = last.negative ? -last.cents : last.cents;
      }
      return;
    }
    const first = matchLeadingDate(line);
    if (!first) return;
    let rest = line.slice(first.length).trim();
    // Card statements often print a posting date right after the transaction date
    const second = matchLeadingDate(rest);
    if (second) rest = rest.slice(second.length).trim();
    const offset = line.length - rest.length;

    const money = findMoney(rest).map(m => ({ ...m, x: centerOf(row, offset + m.index) }));
    if (!money.length) return;
    const description = rest.slice(0, money[0].index).replace(/\s+/g, ' ').trim();
    if (!description || SKIP_LINE_RE.test(description)) { skipped++; return; }

    const year = first.year || resolveYear(first.month, period, fallbackYear);
    if (!validDay(year, first.month, first.day)) { skipped++; return; }
    candidates.push({
      date: `${year}-${pad2(first.month)}-${pad2(first.day)}`,
      description: description.slice(0, 120),
      money
    });
  });

  const result = (transactions, kind) => ({ transactions, bank: guessBank(text), kind, skipped });

  // 1) Withdrawals / Deposits columns: the column an amount sits in decides
  if (columns) {
    const transactions = candidates.map(c => {
      const placed = c.money.filter(m => m.x !== null);
      const near = placed.length ? placed.reduce((best, m) =>
        Math.min(Math.abs(m.x - columns.D), Math.abs(m.x - columns.C)) <
        Math.min(Math.abs(best.x - columns.D), Math.abs(best.x - columns.C)) ? m : best) : c.money[0];
      const type = near.x === null ? (near.negative ? 'D' : 'C')
        : Math.abs(near.x - columns.D) <= Math.abs(near.x - columns.C) ? 'D' : 'C';
      return { date: c.date, description: c.description, cents: near.cents, type, check: near.x === null };
    });
    return result(transactions, 'account');
  }

  // 2) Bank account statements print a running balance after the amount
  const withBalance = candidates.filter(c => c.money.length >= 2).length;
  const kind = candidates.length && withBalance / candidates.length >= 0.5 ? 'account' : 'card';

  if (kind === 'account') {
    const rowsB = candidates.map(c => {
      const hasBalance = c.money.length >= 2;
      const amt = hasBalance ? c.money[c.money.length - 2] : c.money[0];
      const bal = hasBalance ? c.money[c.money.length - 1] : null;
      return { c, amt, bal: bal ? (bal.negative ? -bal.cents : bal.cents) : null };
    });
    // The balance before a row is the row above it (oldest first) or below it
    // (newest first). Try both and keep the order where the numbers add up.
    const before = (i, newestFirst) => {
      const j = newestFirst ? i + 1 : i - 1;
      if (j < 0 || j >= rowsB.length) return opening;
      return rowsB[j].bal;
    };
    const directions = newestFirst => rowsB.map((r, i) => {
      const prev = before(i, newestFirst);
      if (r.bal === null || prev === null) return null;
      const delta = r.bal - prev;
      return delta === r.amt.cents ? 'C' : delta === -r.amt.cents ? 'D' : null;
    });
    const asc = directions(false);
    const desc = directions(true);
    const score = arr => arr.filter(Boolean).length;
    const dates = candidates.map(c => c.date);
    const sortedDesc = dates.length > 1 && dates[0] > dates[dates.length - 1];
    const chosen = score(desc) > score(asc) || (score(desc) === score(asc) && sortedDesc) ? desc : asc;
    const transactions = rowsB.map((r, i) => {
      let type = chosen[i];
      let check = false;
      if (!type) {
        type = r.amt.negative ? 'D' : CREDIT_HINT_RE.test(r.c.description) ? 'C' : 'D';
        check = true;
      }
      return { date: r.c.date, description: r.c.description, cents: r.amt.cents, type, check };
    });
    return result(transactions, 'account');
  }

  // 3) Card statements: most use "negative = payment/credit", some print
  // purchases as negative instead. Payments and refunds tell us which.
  const last = c => c.money[c.money.length - 1];
  const hinted = candidates.filter(c => CREDIT_HINT_RE.test(c.description));
  const others = candidates.filter(c => !CREDIT_HINT_RE.test(c.description));
  const share = (list, neg) => (list.length ? list.filter(c => last(c).negative === neg).length / list.length : 0);
  const negativeMeansDebit = hinted.length
    ? share(hinted, false) > 0.5 && share(others, true) > 0.5
    : candidates.length >= 3 && share(candidates, true) > 0.5;
  const transactions = candidates.map(c => {
    const amt = last(c);
    const type = negativeMeansDebit ? (amt.negative ? 'D' : 'C') : (amt.negative ? 'C' : 'D');
    return { date: c.date, description: c.description, cents: amt.cents, type, check: false };
  });
  return result(transactions, 'card');
}

// Groups pdf.js text items into rows (top to bottom, left to right). Each row
// keeps its text plus where every piece sits on the page, so columns can be told
// apart: { text, cells: [{ start, end, x, right, str }] } (start/end index text).
function itemsToRows(items) {
  const rows = [];
  items.forEach(it => {
    if (!it.str || !it.str.trim()) return;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str.replace(/\s+/g, ' ').trim(), width: it.width || 0 });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    const cells = [];
    r.parts.forEach(p => {
      if (!p.str) return;
      if (end !== null && p.x - end > 1.5 && !text.endsWith(' ')) text += ' ';
      cells.push({ start: text.length, end: text.length + p.str.length, x: p.x, right: p.x + p.width, str: p.str });
      text += p.str;
      end = p.x + p.width;
    });
    return { text, cells };
  });
}

function itemsToLines(items) {
  return itemsToRows(items).map(r => r.text);
}

// ---- Moneta's own PDF report ("All transactions" table) ----
// Reads every column back, so a report made by Moneta can be imported again.
const MONETA_COLUMNS = ['Date', 'Description', 'Category', 'Person', 'Bank', 'Note', 'Amount'];

function parseMonetaReport(rows) {
  const allText = rows.map(r => (typeof r === 'string' ? r : r.text)).join('\n');
  if (!/^MONETA$/m.test(allText) || !/All transactions/.test(allText)) return null;
  const transactions = [];
  let columns = null;
  rows.forEach(row => {
    if (typeof row === 'string' || !row.cells) return;
    const words = row.cells.map(c => c.str);
    if (MONETA_COLUMNS.every(h => words.includes(h))) {
      columns = MONETA_COLUMNS.map(h => {
        const c = row.cells.find(x => x.str === h);
        return { name: h, x: c.x, right: c.right };
      });
      return;
    }
    if (!columns) return;
    const date = matchLeadingDate(row.cells[0] ? row.cells[0].str : '');
    if (!date || !date.year) return;
    // Each piece of text belongs to the column whose header starts at or left of it
    // (Amount is right-aligned, so anything past the Note column is the amount)
    const fields = Object.fromEntries(MONETA_COLUMNS.map(n => [n, []]));
    row.cells.forEach(c => {
      let col = columns[0];
      columns.forEach(h => { if (c.x >= h.x - 4) col = h; });
      if (c.right >= columns[6].right - 6 && /\d/.test(c.str)) col = columns[6];
      fields[col.name].push(c.str);
    });
    const amountText = fields.Amount.join('');
    const money = findMoney(amountText.replace(/^\+/, ''));
    if (!money.length) return;
    // The report marks spending with − and income with +; transfers keep their sign too
    const type = /^[−-]/.test(amountText.trim()) ? 'D' : 'C';
    const description = fields.Description.filter(w => !/^(transfer|refund)$/i.test(w)).join(' ').trim();
    if (!validDay(date.year, date.month, date.day)) return;
    transactions.push({
      date: `${date.year}-${pad2(date.month)}-${pad2(date.day)}`,
      description: description.slice(0, 120) || '—',
      cents: money[0].cents,
      type,
      check: false,
      category: fields.Category.join(' ').trim(),
      person: fields.Person.join(' ').trim(),
      bank: fields.Bank.join(' ').trim(),
      note: fields.Note.join(' ').trim()
    });
  });
  return transactions.length ? { transactions, bank: '', kind: 'moneta', skipped: 0 } : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchLeadingDate, findMoney, parseStatementLines, parseMonetaReport, guessBank, findPeriod, itemsToLines, itemsToRows };
}

/* ---------------- Browser UI ---------------- */
if (typeof document !== 'undefined') {
  let pdfjsPromise = null;
  let importRows = [];     // parsed rows shown in the review dialog
  let importSourceName = '';

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then(lib => {
        lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
        return lib;
      });
    }
    return pdfjsPromise;
  }

  // Toast with a progress bar that stays up until the import finishes
  function showProgress(text, fraction) {
    const box = document.getElementById('statusMessage');
    clearTimeout(statusTimeout);
    box.textContent = text;
    const bar = document.createElement('div');
    bar.className = 'status-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(4, Math.round(fraction * 100))}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
    box.className = 'status-message status-success';
    box.style.display = 'block';
  }

  async function readPdfLines(file, onPage) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,   // never compile code from the PDF
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Statements often use non-embedded fonts (Helvetica, Arial); these files let pdf.js read them
      standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', location.href).href
    });
    task.onPassword = (update, reason) => {
      const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'Wrong password. ' : '';
      const pw = prompt(`${again}"${file.name}" is password protected. Enter the PDF password:`);
      if (pw === null) task.destroy();
      else update(pw);
    };
    const doc = await task.promise;
    const lines = [];
    try {
      const pages = Math.min(doc.numPages, 60);
      for (let i = 1; i <= pages; i++) {
        if (onPage) onPage(i, pages);
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        lines.push(...itemsToRows(content.items));
      }
    } finally {
      await task.destroy();
    }
    return lines;
  }

  function matchSettingsBank(guess) {
    if (!guess) return '';
    const banks = getSettings().banks;
    const g = guess.toLowerCase();
    return banks.find(b => b.toLowerCase() === g) ||
      banks.find(b => b.toLowerCase().includes(g.split(' ')[0])) || guess;
  }

  async function importStatementFiles(files) {
    const list = [...files].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!list.length) return;
    const rows = [];
    const problems = [];
    let bank = '';
    let fromReport = false;
    for (const [fi, file] of list.entries()) {
      const label = list.length > 1 ? `📄 Statement ${fi + 1} of ${list.length}` : '📄 Reading statement';
      showProgress(`${label}…`, fi / list.length);
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('file is larger than 25 MB');
        const lines = await readPdfLines(file, (page, pages) =>
          showProgress(`${label} — page ${page} of ${pages}`, (fi + page / pages) / list.length));
        if (lines.map(l => l.text).join('').replace(/\s/g, '').length < 8) {
          throw new Error('no readable text — it looks like a scanned image');
        }
        // A report made by Moneta is read column by column; anything else is a bank statement
        const result = parseMonetaReport(lines) || parseStatementLines(lines);
        if (result.kind === 'moneta') fromReport = true;
        if (!result.transactions.length) throw new Error('no transactions found in a format Moneta recognises');
        bank = bank || result.bank;
        result.transactions.forEach(t => rows.push({ ...t, include: true, file: file.name }));
      } catch (e) {
        if (e && e.name === 'PasswordException') problems.push(`${file.name}: password not entered`);
        else problems.push(`${file.name}: ${e.message || e}`);
      }
    }
    if (!rows.length) {
      showStatus(`❌ Couldn't import: ${problems.join('; ')}`, true);
      return;
    }
    document.getElementById('statusMessage').style.display = 'none';
    importRows = rows;
    importSourceName = list.length === 1 ? list[0].name : `${list.length} statements`;
    openImportReview(matchSettingsBank(bank), problems, fromReport);
  }

  // Rows from a Moneta report bring their own person, bank, category and note;
  // bank statement rows take the person and bank chosen in the dialog
  function buildEntry(r, person, bank) {
    const value = r.cents / 100;
    const entry = {
      'Date': r.date,
      'Purchased By': r.person || person,
      'Purchased Store': r.description,
      'Bank Name': r.bank || bank,
      'Debit [D]': r.type === 'D' ? value : '',
      'Credit [C]': r.type === 'C' ? value : '',
      'Amount Total': value
    };
    if (r.category) entry['Category'] = r.category;
    if (r.note) entry['Notes'] = r.note.slice(0, 200);
    return entry;
  }

  function openImportReview(bank, problems, fromReport) {
    const settings = getSettings();
    const bankSel = document.getElementById('importBank');
    const banks = bank && !settings.banks.includes(bank) ? [bank, ...settings.banks] : settings.banks;
    bankSel.innerHTML = banks.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    if (bank) bankSel.value = bank;
    const personSel = document.getElementById('importPerson');
    personSel.innerHTML = settings.people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    const last = document.getElementById('purchasedBy').value;
    if (settings.people.includes(last)) personSel.value = last;

    // Rows already in the list start unticked
    importRows.forEach(r => {
      r.duplicate = findDuplicate(budgetData, buildEntry(r, '', '')) > -1;
      r.include = !r.duplicate;
    });
    document.getElementById('importProblems').textContent = problems.length ? `⚠️ Skipped: ${problems.join('; ')}` : '';
    document.getElementById('importReportNote').hidden = !fromReport;
    document.getElementById('importTitle').textContent = fromReport ? 'Review Moneta report' : 'Review statement';
    renderImportRows();
    document.getElementById('importModal').style.display = 'flex';
  }

  function renderImportRows() {
    const tbody = document.querySelector('#importTable tbody');
    tbody.innerHTML = importRows.map((r, i) => {
      const cat = r.category ? canonicalCategory(r.category) : getCategory({ 'Purchased Store': r.description });
      const kind = classify(buildEntry(r, '', '')).kind;
      const tag = r.duplicate ? '<span class="kind-tag">Already in list</span>'
        : r.check ? '<span class="kind-tag check">Check type</span>'
        : kind === 'transfer' ? '<span class="kind-tag">Transfer · not counted</span>'
        : kind === 'refund' ? '<span class="kind-tag refund">Refund</span>' : '';
      const amountClass = kind === 'transfer' ? 'is-transfer' : r.type === 'C' ? 'is-income' : 'is-expense';
      return `<tr class="${r.include ? '' : 'excluded'}">` +
        `<td class="sel-col"><input type="checkbox" class="imp-check" data-i="${i}"${r.include ? ' checked' : ''} aria-label="Include ${escapeHtml(r.description)}"></td>` +
        `<td class="nowrap">${escapeHtml(shortDate(r.date))}</td>` +
        `<td><input type="text" class="imp-desc" data-i="${i}" value="${escapeHtml(r.description)}" maxlength="120" aria-label="Description"><div class="txn-sub">${getCategoryBadge(cat)}${tag}</div></td>` +
        `<td class="right"><button type="button" class="imp-type ${amountClass}" data-i="${i}" aria-label="Switch expense or income">${r.type === 'C' ? '+' : '−'}${fmtMoney(r.cents / 100)}</button></td>` +
        `</tr>`;
    }).join('');
    const chosen = importRows.filter(r => r.include);
    let spentC = 0;
    let incomeC = 0;
    chosen.forEach(r => { if (r.type === 'C') incomeC += r.cents; else spentC += r.cents; });
    document.getElementById('importSummary').textContent =
      `${importRows.length} found in ${importSourceName} · ${chosen.length} selected · ` +
      `out ${fmtMoney(spentC / 100)} · in ${fmtMoney(incomeC / 100)}`;
    document.getElementById('importConfirm').innerHTML =
      `<i class="fas fa-check"></i> Add ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`;
    document.getElementById('importConfirm').disabled = chosen.length === 0;
    const all = document.getElementById('importAll');
    all.checked = chosen.length === importRows.length;
    all.indeterminate = chosen.length > 0 && chosen.length < importRows.length;
  }

  function closeImportReview() {
    document.getElementById('importModal').style.display = 'none';
    importRows = [];
  }

  function confirmImport() {
    const person = document.getElementById('importPerson').value;
    const bank = document.getElementById('importBank').value;
    const entries = importRows.filter(r => r.include).map(r => buildEntry(r, person, bank));
    if (!entries.length) return;
    budgetData.push(...entries);
    rememberStores(entries);
    markChanged(entries.length);
    dashPinned = null;
    closeImportReview();
    renderTable();
    showStatus(`✅ Added ${entries.length} transaction${entries.length === 1 ? '' : 's'} from your statement. Save to keep them.`, false, () => {
      const added = new Set(entries);
      budgetData = budgetData.filter(r => !added.has(r));
      markChanged();
      renderTable();
      showStatus('↩️ Import undone.');
    });
  }

  // The main Upload button (app.js) hands PDFs to this
  window.importStatementFiles = importStatementFiles;

  const pdfInput = document.getElementById('pdfInput');
  pdfInput.addEventListener('change', () => {
    // Copy first: clearing the input also empties its live FileList
    const files = [...(pdfInput.files || [])];
    pdfInput.value = '';
    if (files.length) importStatementFiles(files);
  });

  const importTbody = document.querySelector('#importTable tbody');
  importTbody.addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    if (!importRows[i]) return;
    if (e.target.matches('.imp-check')) {
      importRows[i].include = e.target.checked;
      renderImportRows();
    } else if (e.target.matches('.imp-desc')) {
      importRows[i].description = e.target.value.trim().slice(0, 120) || importRows[i].description;
      renderImportRows();
    }
  });
  importTbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.imp-type');
    if (!btn) return;
    const r = importRows[Number(btn.dataset.i)];
    r.type = r.type === 'C' ? 'D' : 'C';
    r.check = false;
    renderImportRows();
  });
  document.getElementById('importAll').addEventListener('change', (e) => {
    importRows.forEach(r => { r.include = e.target.checked; });
    renderImportRows();
  });
  document.getElementById('importFlip').addEventListener('click', () => {
    importRows.forEach(r => { r.type = r.type === 'C' ? 'D' : 'C'; r.check = false; });
    renderImportRows();
  });
  document.getElementById('importConfirm').addEventListener('click', confirmImport);
  document.getElementById('importCancel').addEventListener('click', closeImportReview);
  document.getElementById('closeImport').addEventListener('click', closeImportReview);
  document.getElementById('importModal').addEventListener('click', (e) => {
    if (e.target.id === 'importModal') closeImportReview();
  });
}
