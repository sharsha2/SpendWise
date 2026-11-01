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
const CREDIT_HINT_RE = /\b(deposit|payroll|salary|refund|credit|payment received|payment - thank you|payment thank you|interest paid|e-?transfer from|transfer from|reversal|cashback)\b/i;

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
function parseStatementLines(lines, options = {}) {
  const text = lines.join('\n');
  const period = findPeriod(text);
  const years = (text.match(/\b20\d{2}\b/g) || []).map(Number);
  const fallbackYear = options.year || (years.length ? Math.max(...years) : new Date().getFullYear());

  const candidates = [];
  let opening = null;
  let skipped = 0;

  lines.forEach(raw => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) return;
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

    const money = findMoney(rest);
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

  // Bank account statements print a running balance after the amount
  const withBalance = candidates.filter(c => c.money.length >= 2).length;
  const kind = candidates.length && withBalance / candidates.length >= 0.5 ? 'account' : 'card';

  let balance = opening;
  const transactions = candidates.map(c => {
    if (kind === 'card') {
      const amt = c.money[c.money.length - 1];
      return { date: c.date, description: c.description, cents: amt.cents, type: amt.negative ? 'C' : 'D', check: false };
    }
    const hasBalance = c.money.length >= 2;
    const amt = hasBalance ? c.money[c.money.length - 2] : c.money[0];
    let type = null;
    if (hasBalance) {
      const bal = c.money[c.money.length - 1];
      const newBalance = bal.negative ? -bal.cents : bal.cents;
      if (balance !== null) {
        const delta = newBalance - balance;
        if (delta === amt.cents) type = 'C';
        else if (delta === -amt.cents) type = 'D';
      }
      balance = newBalance;
    } else if (balance !== null) {
      balance = null; // can't follow the balance through rows that don't print it
    }
    let check = false;
    if (!type) {
      type = amt.negative ? 'D' : CREDIT_HINT_RE.test(c.description) ? 'C' : 'D';
      check = true;
    }
    return { date: c.date, description: c.description, cents: amt.cents, type, check };
  });

  return { transactions, bank: guessBank(text), kind, skipped };
}

// Groups pdf.js text items into lines (top to bottom, left to right)
function itemsToLines(items) {
  const rows = [];
  items.forEach(it => {
    if (!it.str || !it.str.trim()) return;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, str: it.str, width: it.width || 0 });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    r.parts.forEach(p => {
      if (end !== null) out += (p.x - end > 1.5) ? ' ' : '';
      out += p.str;
      end = p.x + p.width;
    });
    return out.replace(/\s+/g, ' ').trim();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchLeadingDate, findMoney, parseStatementLines, guessBank, findPeriod, itemsToLines };
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

  async function readPdfLines(file) {
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
      for (let i = 1; i <= Math.min(doc.numPages, 60); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        lines.push(...itemsToLines(content.items));
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
    showStatus('📄 Reading statement…');
    const rows = [];
    const problems = [];
    let bank = '';
    for (const file of list) {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('file is larger than 25 MB');
        const lines = await readPdfLines(file);
        if (lines.join('').replace(/\s/g, '').length < 8) {
          throw new Error('no readable text — it looks like a scanned image');
        }
        const result = parseStatementLines(lines);
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
    importRows = rows;
    importSourceName = list.length === 1 ? list[0].name : `${list.length} statements`;
    openImportReview(matchSettingsBank(bank), problems);
  }

  function buildEntry(r, person, bank) {
    const value = r.cents / 100;
    return {
      'Date': r.date,
      'Purchased By': person,
      'Purchased Store': r.description,
      'Bank Name': bank,
      'Debit [D]': r.type === 'D' ? value : '',
      'Credit [C]': r.type === 'C' ? value : '',
      'Amount Total': value
    };
  }

  function openImportReview(bank, problems) {
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
    renderImportRows();
    document.getElementById('importModal').style.display = 'flex';
  }

  function renderImportRows() {
    const tbody = document.querySelector('#importTable tbody');
    tbody.innerHTML = importRows.map((r, i) => {
      const cat = categorizeStore(r.description);
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
