  let budgetData = [];
  let editIndex = -1;              // row open in the edit dialog
  const selectedRows = new Set();  // rows ticked for bulk actions
  let unsavedCount = 0;            // changes since the last open/save
  // The file the data came from: { name, months, handle, workbook }.
  // Saving writes its months back into it; other months get their own files.
  let source = null;

  // Currency display: a generic dollar sign by default, with INR as an option.
  const CURRENCIES = {
    dollar: { symbol: '$', locale: undefined },
    inr: { symbol: '₹', locale: 'en-IN' }
  };

  let activeCurrency = CURRENCIES.dollar;
  let fmtNumber = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function applyCurrencySetting() {
    activeCurrency = CURRENCIES[getSettings().currency] || CURRENCIES.dollar;
    fmtNumber = new Intl.NumberFormat(activeCurrency.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('filterMinAmount').placeholder = `Min ${activeCurrency.symbol}`;
    document.getElementById('filterMaxAmount').placeholder = `Max ${activeCurrency.symbol}`;
    document.getElementById('budgetAmount').placeholder = `Limit ${activeCurrency.symbol}`;
    document.querySelectorAll('.amount-cur').forEach(el => { el.textContent = activeCurrency.symbol; });
    const currencySelect = document.getElementById('currencySelect');
    if (currencySelect) currencySelect.value = getSettings().currency;
  }

  function fmtMoney(v) {
    const n = Number(v) || 0;
    return (n < 0 ? '-' : '') + activeCurrency.symbol + fmtNumber.format(Math.abs(n));
  }

  // Money is summed in integer cents to avoid floating-point drift
  // (0.1 + 0.2 !== 0.3), then converted back to dollars once at the end.
  function toCents(v) {
    return Math.round((Number(v) || 0) * 100);
  }

  function sumCents(rows, field) {
    return rows.reduce((cents, r) => cents + toCents(r[field]), 0);
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  let incomeExpenseChart = null;
  let spendingCategoryChart = null;
  let monthlyOverviewChart = null;
  let creditCardSpendingChart = null;
  let purchasedByTrendChart = null;
  let compareMonthsChart = null;
  let currentSort = { column: null, direction: 'none' }; // none, asc, desc

  // Chart colors, validated for colorblind safety against both app surfaces
  // (#FFFFFF light / #172033 dark). The categorical slots are assigned in this
  // fixed order and never cycled — extra categories fold into "Other".
  const CHART_PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  };

  function chartTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const css = getComputedStyle(document.documentElement);
    const v = name => css.getPropertyValue(name).trim();
    return {
      dark,
      surface: v('--card-bg') || (dark ? '#172033' : '#FFFFFF'),
      ink: v('--text-color') || (dark ? '#CBD5E1' : '#334155'),
      muted: v('--muted-color') || '#64748B',
      grid: dark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(100, 116, 139, 0.15)',
      income: '#059669',
      expense: '#EF4444',
      net: dark ? '#3987e5' : '#2a78d6',
      other: dark ? '#94A3B8' : '#64748B',
      palette: dark ? CHART_PALETTE.dark : CHART_PALETTE.light,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif"
    };
  }

  // Compact money for axis ticks ($1.2K) — full values stay in tooltips
  function fmtMoneyShort(v) {
    const n = Number(v) || 0;
    const abs = Math.abs(n);
    let s;
    if (abs >= 1e6) s = (abs / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    else if (abs >= 1e3) s = (abs / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    else s = Number.isInteger(abs) ? String(abs) : fmtNumber.format(abs);
    return (n < 0 ? '-' : '') + activeCurrency.symbol + s;
  }

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function chartTitle(theme, text) {
    return {
      display: true,
      text,
      color: theme.ink,
      font: { family: theme.fontFamily, size: 15, weight: '600' },
      padding: { bottom: 4 }
    };
  }

  function chartSubtitle(theme, text) {
    return {
      display: true,
      text,
      color: theme.muted,
      font: { family: theme.fontFamily, size: 12 },
      padding: { bottom: 14 }
    };
  }

  function chartLegend(theme, display = true) {
    return {
      display,
      position: 'bottom',
      labels: {
        color: theme.ink,
        usePointStyle: true,
        pointStyle: 'circle',
        boxWidth: 8,
        boxHeight: 8,
        padding: 14,
        font: { family: theme.fontFamily, size: 13 },
        sort: (a, b) => a.datasetIndex - b.datasetIndex
      }
    };
  }

  function chartTooltip(theme, callbacks) {
    return {
      backgroundColor: theme.dark ? '#0B1220' : '#1E293B',
      titleColor: '#F8FAFC',
      bodyColor: '#E2E8F0',
      padding: 10,
      cornerRadius: 8,
      boxPadding: 4,
      usePointStyle: true,
      titleFont: { family: theme.fontFamily, size: 12, weight: '600' },
      bodyFont: { family: theme.fontFamily, size: 12 },
      callbacks
    };
  }

  // Doughnut slices: "Groceries: $412.50 (32.1%)"
  const sliceLabel = (context) => {
    const total = context.dataset.data.reduce((a, b) => a + b, 0);
    const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
    return `${context.label || ''}: ${fmtMoney(context.raw)} (${pct}%)`;
  };

  // Single-series bars (tooltip title already names the bar): "$412.50 (32.1%)"
  const shareLabel = (context) => {
    const total = context.dataset.data.reduce((a, b) => a + b, 0);
    const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
    return `${fmtMoney(context.raw)} (${pct}% of total)`;
  };

  // Value axis: hairline grid, muted compact-money ticks
  function moneyAxis(theme) {
    return {
      beginAtZero: true,
      grid: { color: theme.grid, drawTicks: false },
      border: { display: false },
      ticks: {
        color: theme.muted,
        font: { family: theme.fontFamily, size: 12 },
        callback: value => fmtMoneyShort(value),
        padding: 6,
        maxTicksLimit: 6
      }
    };
  }

  // Category axis: no grid, muted labels
  function labelAxis(theme) {
    return {
      grid: { display: false },
      border: { display: false },
      ticks: { color: theme.muted, font: { family: theme.fontFamily, size: 12 } }
    };
  }

  // Direct value labels at the tips of single-series bars (the money axis is
  // hidden on those charts — the labels carry the values instead)
  const barValuePlugin = {
    id: 'barValues',
    afterDatasetsDraw(chart) {
      const opts = chart.options.plugins.barValues;
      if (!opts || !opts.display) return;
      const horizontal = chart.options.indexAxis === 'y';
      const meta = chart.getDatasetMeta(0);
      const { ctx } = chart;
      ctx.save();
      ctx.fillStyle = opts.color;
      ctx.font = `600 12px ${opts.fontFamily}`;
      meta.data.forEach((bar, i) => {
        const label = fmtMoneyShort(chart.data.datasets[0].data[i]);
        if (horizontal) {
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bar.x + 8, bar.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, bar.x, bar.y - 6);
        }
      });
      ctx.restore();
    }
  };

  // Draws a headline value in the hole of a doughnut chart
  const centerTextPlugin = {
    id: 'centerText',
    afterDatasetsDraw(chart) {
      const opts = chart.options.plugins.centerText;
      if (!opts || !opts.value) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta.data.length) return;
      const { x, y } = meta.data[0];
      const { ctx } = chart;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 20px ${opts.fontFamily}`;
      ctx.fillStyle = opts.color;
      ctx.fillText(opts.value, x, y - 8);
      ctx.font = `500 12px ${opts.fontFamily}`;
      ctx.fillStyle = opts.mutedColor;
      ctx.fillText(opts.label, x, y + 14);
      ctx.restore();
    }
  };

  // Menu Logic
  const menuBtn = document.getElementById('menuBtn');
  const menuOptions = document.getElementById('menuOptions');

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menuOptions.classList.toggle('show');
    menuBtn.setAttribute('aria-expanded', open);
  });

  document.addEventListener('click', () => {
    menuOptions.classList.remove('show');
    menuBtn.setAttribute('aria-expanded', 'false');
  });

  // Escape closes any open modal or the menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
      menuOptions.classList.remove('show');
      menuBtn.setAttribute('aria-expanded', 'false');
      closeCategoryPickers();
      editIndex = -1;
      closeEntrySheet();
    }
  });

  function openReportsHub() {
    document.getElementById('reportsHubModal').style.display = 'flex';
    menuOptions.classList.remove('show');
  }

  function openCompareModal() {
    document.getElementById('compareMonthsModal').style.display = 'flex';
    menuOptions.classList.remove('show');
  }

  function openSettingsModal() {
    populateSettingsUI();
    document.getElementById('settingsModal').style.display = 'flex';
    menuOptions.classList.remove('show');
  }

  // Category groups → sub-categories → keywords. Group order matters:
  // matching walks top to bottom, so broad catch-alls (Shopping) come last.
  const TRANSFER_GROUP = 'Transfers & Savings';
  let categoryCache = null; // rebuilt whenever settings change

  function invalidateCategoryCache() {
    categoryCache = null;
  }

  function getCategoryGroups() {
    if (categoryCache && categoryCache.groups) return categoryCache.groups;
    const groups = {
      'Income': {
        'Income': ['payroll', 'salary', 'deposit', 'income', 'interest', 'intrest', 'cashback', 'rebate']
      },
      // Money moving between your own accounts — never counted as spending or income
      [TRANSFER_GROUP]: {
        'Credit Card Payment': ['credit card', 'card payment', 'payment thank you', 'payment - thank you', 'payment received', 'autopay'],
        'Transfer': ['own account', 'between accounts', 'internal transfer', 'account transfer', 'tfr'],
        'Investment': ['investment', 'stocks', 'etf', 'crypto', 'rrsp', 'tfsa', 'fhsa', 'mutual fund', 'wealthsimple invest', 'questrade']
      },
      'Housing': {
        'Rent': ['rent', 'apartment', 'housing', 'lease'],
        'Home': ['furniture', 'ikea', 'home depot', 'decor', 'renovation', 'repair', 'appliance']
      },
      'Bills & Utilities': {
        'Phone & Internet': ['phone', 'internet', 'wifi', 'mobile', 'rogers', 'bell canada', 'bell mobility', 'telus', 'fido', 'koodo', 'freedom mobile', 'cable tv'],
        'Utilities': ['utility', 'utilities', 'hydro', 'electricity', 'electric bill', 'power bill', 'water', 'gas bill', 'natural gas', 'enbridge', 'heating'],
        'Subscriptions': ['subscription', 'membership', 'prime', 'spotify', 'icloud', 'youtube premium', 'google one', 'disney'],
        'Bills': ['bill', 'bills']
      },
      'Food & Dining': {
        'Groceries': ['grocery', 'groceries', 'market', 'supermarket', 'vegetable', 'fruit', 'food', 'meat', 'butcher', 'no frills', 'freshco', 'food basics', 'sobeys', 'loblaws', 'superstore', 'costco', 'walmart supercentre'],
        'Dining': ['coffee', 'cafe', 'starbucks', 'restaurant', 'dining', 'eats', 'eatery', 'meal', 'bakery', 'tim hortons', 'mcdonald', 'mcdonalds', 'pizza', 'burger', 'kfc', 'chipotle', 'doordash', 'uber eats', 'skip the dishes', 'wendys', 'popeyes', 'taco bell', 'shawarma', 'biryani', 'buffet']
      },
      'Transport & Travel': {
        'Gas': ['gas', 'fuel', 'gas station', 'petro', 'shell', 'esso', 'chevron', 'petrol'],
        'Transit': ['transit', 'bus pass', 'go train', 'via rail', 'metro', 'subway', 'parking', 'presto', 'toll'],
        'Flight': ['flight', 'flights', 'airline', 'air canada', 'westjet'],
        'Travel': ['travel', 'uber', 'lyft', 'taxi', 'hotel', 'airbnb', 'airport', 'ticket', 'trip']
      },
      'Health & Personal': {
        'Health': ['pharmacy', 'doctor', 'dental', 'dentist', 'clinic', 'hospital', 'medic', 'drug mart', 'prescription'],
        'Fitness': ['gym', 'fitness', 'yoga', 'goodlife', 'sport', 'sports'],
        'SPA': ['haircut', 'spa', 'salon', 'barber', 'cosmetics']
      },
      'Financial': {
        'Loans': ['loan', 'loans', 'car loan', 'car payment', 'mortgage', 'emi', 'repayment'],
        'Insurance': ['insurance', 'premium'],
        'Taxes & Fees': ['tax', 'taxes', 'cra', 'fine', 'penalty', 'service charge']
      },
      'Work & Education': {
        'Software': ['software', 'cloud', 'app', 'digital', 'license', 'github', 'domain'],
        'Education': ['tuition', 'course', 'school', 'college', 'university', 'udemy', 'coursera', 'certification', 'exam', 'textbook']
      },
      'Family & Transfers': {
        'India': ['india', 'indian', 'desi', 'rupee', 'inr', 'remit', 'remitly', 'wise transfer'],
        'Kids': ['daycare', 'kids', 'toys', 'baby', 'diaper', 'diapers'],
        'Pets': ['pets', 'vet', 'petsmart', 'pet store', 'pet food'],
        'Gifts & Donations': ['gift', 'gifts', 'donation', 'charity', 'temple', 'church']
      },
      'Entertainment & Shopping': {
        'Movie': ['movie', 'movies', 'cinema', 'netflix', 'entertainment', 'streaming', 'concert', 'game', 'games'],
        'Electronics': ['electronics', 'best buy', 'gadget', 'laptop', 'phone case', 'accessories'],
        'Shopping': ['shop', 'shopping', 'store', 'mall', 'buy', 'retail', 'clothing', 'fashion', 'shoes', 'outlet', 'amazon', 'walmart', 'winners', 'dollarama']
      }
    };
    const custom = getSettings().categories || {};
    if (Object.keys(custom).length) groups['Custom'] = custom;
    categoryCache = { groups, map: null, groupOf: new Map(), storeCat: new Map() };
    return groups;
  }

  // Flat map (sub-category → keywords). Custom entries are inserted first so
  // the user's keywords take matching precedence over the built-ins, and
  // re-applied last so same-named custom categories override default keywords.
  function getCategoryMap() {
    const groups = getCategoryGroups();
    if (categoryCache.map) return categoryCache.map;
    const custom = groups['Custom'] || {};
    const flat = { ...custom };
    for (const [group, subs] of Object.entries(groups)) {
      if (group === 'Custom') continue;
      Object.assign(flat, subs);
    }
    categoryCache.map = Object.assign(flat, custom);
    return categoryCache.map;
  }

  // Which group a sub-category belongs to (e.g. 'Utilities' → 'Bills & Utilities')
  function getCategoryGroup(category) {
    const groups = getCategoryGroups();
    if (categoryCache.groupOf.has(category)) return categoryCache.groupOf.get(category);
    let found = null;
    for (const [group, subs] of Object.entries(groups)) {
      if (Object.prototype.hasOwnProperty.call(subs, category)) { found = group; break; }
    }
    categoryCache.groupOf.set(category, found);
    return found;
  }

  // Manage People and Banks Settings
  function getSettings() {
    const defaultSettings = {
      people: ['Harsha', 'Cherry'],
      banks: ['Scotia Debit', 'Scotia Credit', 'Amex', 'PC', 'Wealthsimple', 'Simplii'],
      budgets: {}, // { "Groceries": 600 }
      recurring: [], // [ {desc, amount, day, payer, bank, type} ]
      categories: {}, // { "Pets": ["vet", "petsmart"] }
      currency: 'dollar' // 'dollar' (generic $) or 'inr' (₹)
    };
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('spendwise_settings')); } catch (e) { /* corrupted — use defaults */ }
    if (!stored || typeof stored !== 'object') return defaultSettings;
    const isPlainObject = v => v && typeof v === 'object' && !Array.isArray(v);
    return {
      people: Array.isArray(stored.people) ? stored.people.map(String) : defaultSettings.people,
      banks: Array.isArray(stored.banks) ? stored.banks.map(String) : defaultSettings.banks,
      budgets: isPlainObject(stored.budgets) ? stored.budgets : {},
      recurring: Array.isArray(stored.recurring) ? stored.recurring.filter(isPlainObject) : [],
      categories: isPlainObject(stored.categories) ? stored.categories : {},
      currency: CURRENCIES[stored.currency] ? stored.currency : defaultSettings.currency
    };
  }

  // Names used as object keys (budgets, categories) must not be able to
  // reach Object.prototype
  function isSafeKey(name) {
    return !['__proto__', 'constructor', 'prototype'].includes(name);
  }

  function saveSettings(settings) {
    localStorage.setItem('spendwise_settings', JSON.stringify(settings));
    invalidateCategoryCache();
  }

  function setCurrencySetting(code) {
    const settings = getSettings();
    settings.currency = code;
    saveSettings(settings);
    applyCurrencySetting();
    renderTable();
    populateSettingsUI();
  }

  function addSettingItem(key, inputId) {
    const input = document.getElementById(inputId);
    const val = input.value.trim();
    if (!val) return;
    
    const settings = getSettings();
    if (!settings[key].includes(val)) {
      settings[key].push(val);
      input.value = '';
      saveSettings(settings);
      populateSettingsUI();
      updateDropdowns();
    }
  }

  function removeSettingItem(key, index) {
    const settings = getSettings();
    settings[key].splice(index, 1);
    saveSettings(settings);
    populateSettingsUI();
    updateDropdowns();
  }

  function addBudgetSetting() {
    const target = document.getElementById('budgetTarget').value.trim();
    const amount = parseFloat(document.getElementById('budgetAmount').value);
    if (!target || !isSafeKey(target)) {
      showStatus('⚠️ Enter a category, group, or store name for the budget.', true);
      return;
    }
    if (!isFinite(amount) || amount <= 0) {
      showStatus('⚠️ Budget limit must be more than zero.', true);
      return;
    }
    const settings = getSettings();
    settings.budgets[target] = amount;
    saveSettings(settings);
    populateSettingsUI();
    renderTable(); // Refresh budget tracking
  }

  function addCategorySetting() {
    const name = document.getElementById('newCategoryName').value.trim();
    const keywords = document.getElementById('newCategoryKeywords').value
      .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (!name || keywords.length === 0 || !isSafeKey(name)) {
      showStatus('⚠️ Enter a category name and at least one keyword.', true);
      return;
    }
    const settings = getSettings();
    settings.categories = settings.categories || {};
    settings.categories[name] = keywords;
    saveSettings(settings);
    document.getElementById('newCategoryName').value = '';
    document.getElementById('newCategoryKeywords').value = '';
    populateSettingsUI();
    populateCategoryDropdown();
    renderTable();
  }

  function removeCategoryByIndex(index) {
    const settings = getSettings();
    const key = Object.keys(settings.categories || {})[index];
    if (key === undefined) return;
    delete settings.categories[key];
    saveSettings(settings);
    populateSettingsUI();
    populateCategoryDropdown();
    renderTable();
  }

  function addRecurringSetting() {
    const desc = document.getElementById('recDesc').value.trim();
    const amount = parseFloat(document.getElementById('recAmount').value);
    const day = parseInt(document.getElementById('recDay').value, 10);
    if (!desc || !isFinite(amount) || amount <= 0 || !(day >= 1 && day <= 31)) {
      showStatus('⚠️ Recurring needs a description, an amount above zero, and a day from 1 to 31.', true);
      return;
    }
    
    const settings = getSettings();
    settings.recurring.push({
      desc, amount, day, 
      payer: document.getElementById('recPayer').value,
      bank: document.getElementById('recBank').value,
      type: document.getElementById('recType').value
    });
    saveSettings(settings);
    populateSettingsUI();
  }

  function populateSettingsUI() {
    const settings = getSettings();
    const pList = document.getElementById('peopleList');
    const bList = document.getElementById('banksList');
    const budList = document.getElementById('budgetsList');
    const recList = document.getElementById('recurringList');
    const catList = document.getElementById('categoriesList');
    
    const chip = (label, attrs) =>
      `<span class="chip-item">${escapeHtml(label)}<button type="button" class="list-remove-btn" aria-label="Remove ${escapeHtml(label)}" ${attrs}><i class="fas fa-times"></i></button></span>`;
    const line = (main, sub, label, attrs) =>
      `<div class="settings-line"><div><strong>${main}</strong>${sub ? `<span>${sub}</span>` : ''}</div>` +
      `<button type="button" class="list-remove-btn" aria-label="Remove ${escapeHtml(label)}" ${attrs}><i class="fas fa-times"></i></button></div>`;
    const empty = text => `<div class="settings-empty">${text}</div>`;

    pList.innerHTML = settings.people.map((p, i) =>
      chip(p, `data-action="removeSettingItem" data-key="people" data-index="${i}"`)).join('') || empty('No people yet.');
    bList.innerHTML = settings.banks.map((b, i) =>
      chip(b, `data-action="removeSettingItem" data-key="banks" data-index="${i}"`)).join('') || empty('No banks yet.');

    budList.innerHTML = Object.entries(settings.budgets).map(([k, v], i) =>
      line(escapeHtml(k), `${fmtMoney(v)} / month`, `budget ${k}`, `data-action="removeBudgetByIndex" data-index="${i}"`)).join('') ||
      empty('No budgets yet.');

    recList.innerHTML = settings.recurring.map((r, i) =>
      line(escapeHtml(r.desc), `${r.type === 'C' ? 'Income' : 'Expense'} ${fmtMoney(r.amount)} · day ${escapeHtml(r.day)} · ${escapeHtml(r.payer || '')}${r.bank ? ' · ' + escapeHtml(r.bank) : ''}`,
        `recurring ${r.desc}`, `data-action="removeRecurring" data-index="${i}"`)).join('') ||
      empty('No recurring transactions yet.');

    catList.innerHTML = Object.entries(settings.categories || {}).map(([name, kws], i) =>
      line(escapeHtml(name), escapeHtml(kws.join(', ')), `category ${name}`, `data-action="removeCategoryByIndex" data-index="${i}"`)).join('') ||
      empty('No custom categories yet.');

    // Budget suggestions: every category and group
    const groups = getCategoryGroups();
    const names = new Set();
    Object.entries(groups).forEach(([g, subs]) => { names.add(g); Object.keys(subs).forEach(c => names.add(c)); });
    document.getElementById('budgetTargets').innerHTML = [...names].sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');

    // Sync dropdowns in recurring form
    document.getElementById('recPayer').innerHTML = settings.people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    document.getElementById('recBank').innerHTML = settings.banks.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');

    document.getElementById('currencySelect').value = CURRENCIES[settings.currency] ? settings.currency : 'dollar';
  }

  function removeBudgetByIndex(index) {
    const settings = getSettings();
    const key = Object.keys(settings.budgets)[index];
    if (key === undefined) return;
    delete settings.budgets[key];
    saveSettings(settings);
    populateSettingsUI();
    renderTable();
  }

  function removeRecurring(index) {
    const settings = getSettings();
    settings.recurring.splice(index, 1);
    saveSettings(settings);
    populateSettingsUI();
  }

  function updateDropdowns() {
    const settings = getSettings();
    const pSelect = document.getElementById('purchasedBy');
    const bSelect = document.getElementById('bank');
    
    const pVal = pSelect.value;
    const bVal = bSelect.value;

    pSelect.innerHTML = settings.people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    bSelect.innerHTML = settings.banks.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
    
    // Restore previous selection if still available
    if (settings.people.includes(pVal)) pSelect.value = pVal;
    if (settings.banks.includes(bVal)) bSelect.value = bVal;
  }

  function resetAllLocalData() {
    if (confirm('Reset all settings (people, banks, budgets, categories, recurring)? Your transaction table is not affected.')) {
      localStorage.removeItem('spendwise_settings');
      localStorage.removeItem('spendwise_data'); // legacy key from older versions
      invalidateCategoryCache();
      populateSettingsUI();
      updateDropdowns();
      populateCategoryDropdown();
      renderTable();
      showStatus('✅ All settings reset to defaults.');
    }
  }

  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('spendwise_theme', newTheme);
    updateThemeUI(newTheme);
    renderDashboard();
  }

  function updateThemeUI(theme) {
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');
    if (theme === 'dark') {
      themeIcon.className = 'fas fa-sun';
      themeText.textContent = 'Light Mode';
      Chart.defaults.color = '#CBD5E1';
      Chart.defaults.borderColor = '#2C3A52';
    } else {
      themeIcon.className = 'fas fa-moon';
      themeText.textContent = 'Dark Mode';
      Chart.defaults.color = '#334155';
      Chart.defaults.borderColor = '#E2E8F0';
    }
  }

  const addBtn = document.getElementById('addBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const uploadFile = document.getElementById('uploadFile');
  const clearBtn = document.getElementById('clearBtn');
  const resetFormBtn = document.getElementById('resetFormBtn');
  const applyRecurringBtn = document.getElementById('applyRecurringBtn');
  const filterStartDate = document.getElementById('filterStartDate');
  const filterEndDate = document.getElementById('filterEndDate');
  const filterMinAmount = document.getElementById('filterMinAmount');
  const filterMaxAmount = document.getElementById('filterMaxAmount');
  const clearFilterBtn = document.getElementById('clearFilterBtn');
  const searchInput = document.getElementById('searchInput');
  const compareFilesInput = document.getElementById('compareFilesInput');
  const statusMessage = document.getElementById('statusMessage');
  
  // Typing filters re-render after a short pause instead of on every keystroke
  const debouncedRender = debounce(() => renderTable(), 200);
  searchInput.addEventListener('input', debouncedRender);
  filterMinAmount.addEventListener('input', debouncedRender);
  filterMaxAmount.addEventListener('input', debouncedRender);
  filterStartDate.addEventListener('change', renderTable);
  filterEndDate.addEventListener('change', renderTable);
  
  resetFormBtn.addEventListener('click', () => {
    resetForm();
    showStatus('🧹 Form cleared');
  });

  clearFilterBtn.addEventListener('click', () => {
    filterStartDate.value = '';
    filterEndDate.value = '';
    filterMinAmount.value = '';
    filterMaxAmount.value = '';
    searchInput.value = '';
    document.getElementById('datePreset').value = 'all';
    renderTable();
    showStatus('🔍 Filters cleared');
  });

  // Chart buttons
  const showIncomeExpense = document.getElementById('showIncomeExpense');
  const showSpendingCategory = document.getElementById('showSpendingCategory');
  const showMonthlyOverview = document.getElementById('showMonthlyOverview');
  const showCreditCardSpending = document.getElementById('showCreditCardSpending');
  const showPurchasedByTrend = document.getElementById('showPurchasedByTrend');
  
  // Modals
  const reportsHubModal = document.getElementById('reportsHubModal');
  const incomeExpenseModal = document.getElementById('incomeExpenseModal');
  const spendingCategoryModal = document.getElementById('spendingCategoryModal');
  const monthlyOverviewModal = document.getElementById('monthlyOverviewModal');
  const creditCardSpendingModal = document.getElementById('creditCardSpendingModal');
  const purchasedByTrendModal = document.getElementById('purchasedByTrendModal');
  const compareMonthsModal = document.getElementById('compareMonthsModal');
  const settingsModal = document.getElementById('settingsModal');
  
  // Close buttons
  const closeReportsHub = document.getElementById('closeReportsHub');
  const closeIncomeExpense = document.getElementById('closeIncomeExpense');
  const closeSpendingCategory = document.getElementById('closeSpendingCategory');
  const closeMonthlyOverview = document.getElementById('closeMonthlyOverview');
  const closeCreditCardSpending = document.getElementById('closeCreditCardSpending');
  const closePurchasedByTrend = document.getElementById('closePurchasedByTrend');
  const closeCompareMonths = document.getElementById('closeCompareMonths');
  const closeSettings = document.getElementById('closeSettings');

  // Sortable table headers
  const sortableHeaders = document.querySelectorAll('th[data-sort]');

  addBtn.addEventListener('click', addEntry);
  downloadBtn.addEventListener('click', downloadExcel);
  uploadFile.addEventListener('change', uploadExcel);
  // Where supported, open the file through the File System Access API so we
  // get a writable handle back; otherwise the plain file input is used.
  if ('showOpenFilePicker' in window) {
    uploadFile.closest('label').addEventListener('click', (e) => {
      e.preventDefault();
      pickAndLinkExcel();
    });
  }
  compareFilesInput.addEventListener('change', uploadMultipleExcel);
  clearBtn.addEventListener('click', clearTable);
  
  // Date-range presets fill the from/to filters in one tap
  const datePreset = document.getElementById('datePreset');
  datePreset.addEventListener('change', () => {
    const preset = datePreset.value;
    if (preset === 'custom') return;
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let start = '', end = '';
    if (preset === 'this-month') { start = fmt(new Date(y, m, 1)); end = fmt(new Date(y, m + 1, 0)); }
    else if (preset === 'last-month') { start = fmt(new Date(y, m - 1, 1)); end = fmt(new Date(y, m, 0)); }
    else if (preset === 'last-3') { start = fmt(new Date(y, m - 2, 1)); end = fmt(new Date(y, m + 1, 0)); }
    else if (preset === 'this-year') { start = `${y}-01-01`; end = `${y}-12-31`; }
    filterStartDate.value = start;
    filterEndDate.value = end;
    renderTable();
  });

  // Typing dates manually means the preset no longer describes the range
  [filterStartDate, filterEndDate].forEach(el =>
    el.addEventListener('input', () => { datePreset.value = 'custom'; }));

  function applyRecurringTransactions() {
    const settings = getSettings();
    if (settings.recurring.length === 0) {
      showStatus('⚠️ No recurring transactions defined in Settings.', true);
      return;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    
    let count = 0;
    let skipped = 0;
    const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
    settings.recurring.forEach(r => {
      const day = String(Math.min(Math.max(parseInt(r.day, 10) || 1, 1), lastDay)).padStart(2, '0');
      const date = `${year}-${month}-${day}`;
      // Skip if this recurring entry was already applied this month
      const exists = budgetData.some(b =>
        b['Date'] === date &&
        b['Purchased Store'] === r.desc &&
        Number(b['Amount Total']) === Number(r.amount)
      );
      if (exists) { skipped++; return; }
      budgetData.push({
        'Date': date,
        'Purchased By': r.payer,
        'Purchased Store': r.desc,
        'Bank Name': r.bank,
        'Debit [D]': r.type === 'D' ? r.amount : '',
        'Credit [C]': r.type === 'C' ? r.amount : '',
        'Amount Total': r.amount
      });
      count++;
    });

    if (count === 0) {
      showStatus('ℹ️ All recurring transactions were already applied this month.');
      return;
    }

    markChanged(count);
    renderTable();
    showStatus(`✅ Applied ${count} recurring transaction${count > 1 ? 's' : ''}${skipped ? ` (${skipped} already present)` : ''}.`);
  }

  applyRecurringBtn.addEventListener('click', () => applyRecurringTransactions());

  // Charts open only when there is data to draw (respecting active filters)
  function openChart(updateFn, modal) {
    if (getFilteredData().length === 0) {
      showStatus('⚠️ No transactions to chart yet. Add entries or clear your filters.', true);
      return;
    }
    updateFn();
    modal.style.display = 'flex';
  }

  showIncomeExpense.addEventListener('click', () => openChart(updateIncomeExpenseChart, incomeExpenseModal));
  showSpendingCategory.addEventListener('click', () => openChart(updateSpendingCategoryChart, spendingCategoryModal));
  showMonthlyOverview.addEventListener('click', () => openChart(updateMonthlyOverviewChart, monthlyOverviewModal));
  showCreditCardSpending.addEventListener('click', () => openChart(updateCreditCardSpendingChart, creditCardSpendingModal));
  showPurchasedByTrend.addEventListener('click', () => openChart(updatePurchasedByTrendChart, purchasedByTrendModal));
  
  // Add event listeners for close buttons
  closeIncomeExpense.addEventListener('click', () => {
    incomeExpenseModal.style.display = 'none';
  });
  
  closeSpendingCategory.addEventListener('click', () => {
    spendingCategoryModal.style.display = 'none';
  });
  
  closeMonthlyOverview.addEventListener('click', () => {
    monthlyOverviewModal.style.display = 'none';
  });
  
  closeCreditCardSpending.addEventListener('click', () => {
    creditCardSpendingModal.style.display = 'none';
  });
  
  closePurchasedByTrend.addEventListener('click', () => {
    purchasedByTrendModal.style.display = 'none';
  });

  closeReportsHub.addEventListener('click', () => {
    reportsHubModal.style.display = 'none';
  });
  
  closeCompareMonths.addEventListener('click', () => {
    compareMonthsModal.style.display = 'none';
  });

  closeSettings.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  // Add event listeners for sortable headers
  sortableHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const column = header.getAttribute('data-sort');
      sortData(column);
    });
  });

  // Close modals when clicking outside
  window.addEventListener('click', (event) => {
    if (event.target === incomeExpenseModal) {
      incomeExpenseModal.style.display = 'none';
    }
    if (event.target === spendingCategoryModal) {
      spendingCategoryModal.style.display = 'none';
    }
    if (event.target === monthlyOverviewModal) {
      monthlyOverviewModal.style.display = 'none';
    }
    if (event.target === creditCardSpendingModal) {
      creditCardSpendingModal.style.display = 'none';
    }
    if (event.target === purchasedByTrendModal) {
      purchasedByTrendModal.style.display = 'none';
    }
    if (event.target === reportsHubModal) {
      reportsHubModal.style.display = 'none';
    }
    if (event.target === compareMonthsModal) {
      compareMonthsModal.style.display = 'none';
    }
    if (event.target === settingsModal) {
      settingsModal.style.display = 'none';
    }
  });

  let statusTimeout = null;
  function showStatus(message, isError = false, undoFn = null) {
    statusMessage.textContent = message;
    if (undoFn) {
      const btn = document.createElement('button');
      btn.className = 'undo-btn';
      btn.textContent = 'Undo';
      btn.addEventListener('click', () => {
        clearTimeout(statusTimeout);
        statusMessage.style.display = 'none';
        undoFn();
      });
      statusMessage.appendChild(btn);
    }
    statusMessage.className = `status-message ${isError ? 'status-error' : 'status-success'}`;
    statusMessage.style.display = 'block';
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      statusMessage.style.display = 'none';
    }, undoFn ? 6000 : 4000);
  }

  // Shows (or clears) the message under a field
  function setFieldError(id, message) {
    const el = document.getElementById(id);
    el.textContent = message || '';
    const field = el.closest('label');
    if (field) field.classList.toggle('has-error', !!message);
  }

  // Reads one of the transaction forms (Add or Edit) into a row object,
  // or returns null after showing what's wrong
  function readEntryForm(f) {
    const date = document.getElementById(f.date).value;
    const amountVal = document.getElementById(f.amount).value;
    const amount = amountVal === '' ? NaN : Number(amountVal);
    let ok = true;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFieldError(f.dateError, 'Pick a date');
      ok = false;
    } else setFieldError(f.dateError, '');

    if (!isFinite(amount) || amount <= 0) {
      setFieldError(f.amountError, amountVal === '' ? 'Enter an amount' : 'Amount must be more than 0');
      ok = false;
    } else if (amount >= 1e9) {
      setFieldError(f.amountError, 'That amount looks too large');
      ok = false;
    } else setFieldError(f.amountError, '');

    if (!ok) {
      document.getElementById(isFinite(amount) && amount > 0 ? f.date : f.amount).focus();
      return null;
    }

    const value = toCents(amount) / 100; // store exactly 2 decimals
    const type = document.getElementById(f.type).value;
    const entry = {
      'Date': date,
      'Purchased By': document.getElementById(f.person).value || '',
      'Purchased Store': document.getElementById(f.store).value.trim(),
      'Bank Name': document.getElementById(f.bank).value || '',
      'Debit [D]': type === 'C' ? '' : value,
      'Credit [C]': type === 'C' ? value : '',
      'Amount Total': value
    };
    const category = document.getElementById(f.category).value;
    if (category) entry['Category'] = category;
    return entry;
  }

  const ADD_FORM = {
    date: 'date', amount: 'amount', type: 'type', person: 'purchasedBy', store: 'store',
    bank: 'bank', category: 'category', dateError: 'dateError', amountError: 'amountError'
  };
  const EDIT_FORM = {
    date: 'editDate', amount: 'editAmount', type: 'editType', person: 'editPerson', store: 'editStore',
    bank: 'editBank', category: 'editCategory', dateError: 'editDateError', amountError: 'editAmountError'
  };

  function confirmIfDuplicate(entry, skipIndex) {
    const i = findDuplicate(budgetData, entry, skipIndex);
    if (i < 0) return true;
    const store = entry['Purchased Store'] || 'this transaction';
    return confirm(`${store} for ${fmtMoney(entry['Amount Total'])} on ${entry['Date']} is already in your list.\n\nAdd it again anyway?`);
  }

  function addEntry() {
    const entry = readEntryForm(ADD_FORM);
    if (!entry || !confirmIfDuplicate(entry, -1)) return;

    budgetData.push(entry);
    rememberLastUsed(entry);
    markChanged();
    dashPinned = null; // jump the overview to the month just added to
    renderTable();
    resetForm();
    if (isPhone()) closeEntrySheet();
    const kind = entry['Credit [C]'] !== '' ? 'Income' : 'Expense';
    showStatus(`✅ ${kind} of ${fmtMoney(entry['Amount Total'])} added`, false, () => {
      const i = budgetData.indexOf(entry);
      if (i > -1) budgetData.splice(i, 1);
      markChanged();
      renderTable();
      showStatus('↩️ Entry removed.');
    });
  }

  // Person and bank stay on what you used last, so repeat entries are quicker
  function rememberLastUsed(entry) {
    try {
      localStorage.setItem('spendwise_last', JSON.stringify({ person: entry['Purchased By'], bank: entry['Bank Name'] }));
    } catch (e) { /* storage unavailable */ }
  }

  function applyLastUsed() {
    let last = null;
    try { last = JSON.parse(localStorage.getItem('spendwise_last')); } catch (e) { /* ignore */ }
    if (!last) return;
    const settings = getSettings();
    if (settings.people.includes(last.person)) document.getElementById('purchasedBy').value = last.person;
    if (settings.banks.includes(last.bank)) document.getElementById('bank').value = last.bank;
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function resetForm() {
    document.getElementById('amount').value = '';
    document.getElementById('store').value = '';
    document.getElementById('category').value = '';
    document.getElementById('date').value = todayStr();
    document.getElementById('storeHint').textContent = '';
    setFieldError('amountError', '');
    setFieldError('dateError', '');
    syncDateChips();
    updateCategoryHint();
  }

  function dateOffsetStr(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Highlights the Today/Yesterday chip that matches the date field
  function syncDateChips() {
    document.querySelectorAll('.date-chips').forEach(group => {
      const value = document.getElementById(group.dataset.target).value;
      group.querySelectorAll('.chip').forEach(chip => {
        chip.classList.toggle('active', value === dateOffsetStr(Number(chip.dataset.offset)));
      });
    });
  }

  function setEntryType(toggle, type) {
    document.getElementById(toggle.dataset.target).value = type;
    toggle.querySelectorAll('.type-opt').forEach(b => b.setAttribute('aria-checked', String(b.dataset.type === type)));
    toggle.parentElement.closest('[data-type]').dataset.type = type;
    if (toggle.dataset.target === 'type') {
      document.getElementById('addBtnLabel').textContent = type === 'C' ? 'Add income' : 'Add expense';
    }
  }

  function isPhone() {
    return window.matchMedia('(max-width: 600px)').matches;
  }

  function openEntrySheet() {
    document.getElementById('entryCard').classList.add('sheet-open');
    document.getElementById('sheetBackdrop').hidden = false;
    document.body.classList.add('sheet-locked');
    setTimeout(() => document.getElementById('amount').focus(), 50);
  }

  function closeEntrySheet() {
    document.getElementById('entryCard').classList.remove('sheet-open');
    document.getElementById('sheetBackdrop').hidden = true;
    document.body.classList.remove('sheet-locked');
  }

  // Store suggestions come from your own history, most used first
  function refreshStoreSuggestions() {
    const stores = new Map();
    budgetData.forEach(r => {
      const name = String(r['Purchased Store'] || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      const cur = stores.get(key) || { name, count: 0 };
      cur.count++;
      stores.set(key, cur);
    });
    document.getElementById('storeSuggestions').innerHTML = [...stores.values()]
      .sort((a, b) => b.count - a.count).slice(0, 300)
      .map(s => `<option value="${escapeHtml(s.name)}"></option>`).join('');
  }

  // Picking a store you've used before fills person, bank, type and category
  // from your most recent entry there
  function autofillFromStore() {
    const name = document.getElementById('store').value.trim().toLowerCase();
    const hint = document.getElementById('storeHint');
    if (!name) { hint.textContent = ''; return; }
    let last = null;
    for (let i = budgetData.length - 1; i >= 0; i--) {
      if (String(budgetData[i]['Purchased Store'] || '').trim().toLowerCase() === name) { last = budgetData[i]; break; }
    }
    if (!last) { hint.textContent = ''; return; }
    const setIfOption = (id, value) => {
      const sel = document.getElementById(id);
      if ([...sel.options].some(o => o.value === value)) sel.value = value;
    };
    setIfOption('purchasedBy', last['Purchased By']);
    setIfOption('bank', last['Bank Name']);
    const isIncome = toCents(last['Credit [C]']) > 0 && !toCents(last['Debit [D]']);
    setEntryType(document.querySelector('#entryCard .type-toggle'), isIncome ? 'C' : 'D');
    const catSel = document.getElementById('category');
    catSel.value = last['Category'] && [...catSel.options].some(o => o.value === last['Category']) ? last['Category'] : '';
    updateCategoryHint();
    hint.textContent = '✓ filled from last time';
  }

  function populateCategoryDropdown() {
    const sel = document.getElementById('category');
    const current = sel.value;
    const groups = getCategoryGroups();

    sel.innerHTML = '<option value="">Auto-detect</option>' +
      Object.entries(groups).map(([group, subs]) =>
        `<optgroup label="${escapeHtml(group)}">` +
        Object.keys(subs).sort((a, b) => a.localeCompare(b))
          .map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') +
        '</optgroup>').join('');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;

    const panelHTML = buildCategoryPanelHTML();
    document.getElementById('categoryPickerPanel').innerHTML = panelHTML;
    document.getElementById('editCategoryPanel').innerHTML = panelHTML;
    document.getElementById('editCategory').innerHTML = sel.innerHTML;
    document.getElementById('bulkCategory').innerHTML =
      '<option value="">Choose category…</option><option value="__auto">Auto-detect</option>' +
      sel.innerHTML.replace('<option value="">Auto-detect</option>', '');
    updateCategoryHint();
  }

  // Shared panel markup for every category picker (Add form and inline edit):
  // search box, Auto-detect, then groups — single-category groups are direct options.
  function buildCategoryPanelHTML() {
    return '<div class="cat-search"><input type="text" placeholder="Search categories..." autocomplete="off"></div>' +
      '<button type="button" class="cat-option cat-option-auto" data-value=""><span>Auto-detect</span></button>' +
      Object.entries(getCategoryGroups()).map(([group, subs]) => {
        const names = Object.keys(subs).sort((a, b) => a.localeCompare(b));
        if (names.length === 1) {
          return `<button type="button" class="cat-option cat-option-single" data-value="${escapeHtml(names[0])}"><i class="fas fa-circle cat-dot"></i><span>${escapeHtml(names[0])}</span></button>`;
        }
        return `<button type="button" class="cat-group"><i class="fas fa-chevron-right"></i><span>${escapeHtml(group)} <span class="cat-count">${names.length}</span></span></button>` +
          `<div class="cat-subs" hidden>` +
          names.map(c => `<button type="button" class="cat-option" data-value="${escapeHtml(c)}"><span>${escapeHtml(c)}</span></button>`).join('') +
          '</div>';
      }).join('');
  }

  // Syncs the picker button label and shows what Auto-detect will pick
  function updateCategoryHint() {
    const hint = document.getElementById('categoryHint');
    const manual = document.getElementById('category').value;
    const store = document.getElementById('store').value.trim();
    hint.textContent = (!manual && store) ? `→ ${categorizeStore(store)}` : '';
    document.getElementById('categoryPickerLabel').textContent = manual || 'Auto-detect';
  }

  function closeCategoryPickers() {
    document.querySelectorAll('.category-picker-panel').forEach(p => { p.hidden = true; });
    document.querySelectorAll('.category-picker-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }

  function openCategoryPanel(wrap) {
    closeCategoryPickers();
    const panel = wrap.querySelector('.category-picker-panel');
    const btn = wrap.querySelector('.category-picker-btn');
    const sel = wrap.querySelector('select');
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');

    // Reset search/filtering, highlight the selection, expand only its group
    const search = panel.querySelector('.cat-search input');
    if (search) search.value = '';
    panel.querySelectorAll('.cat-option, .cat-group').forEach(el => { el.style.display = ''; });
    const currentValue = sel.value;
    panel.querySelectorAll('.cat-option').forEach(o => {
      o.classList.toggle('selected', o.dataset.value === currentValue);
    });
    panel.querySelectorAll('.cat-subs').forEach(subs => {
      const holdsSelection = currentValue && [...subs.querySelectorAll('.cat-option')].some(o => o.dataset.value === currentValue);
      subs.hidden = !holdsSelection;
      subs.previousElementSibling.classList.toggle('open', holdsSelection);
    });
  }

  // Whole-word keyword matching so 'eat' doesn't hit "Great Clips",
  // 'bus' doesn't hit "business", 'car' doesn't hit "card", etc.
  const keywordRegexCache = new Map();
  function keywordMatches(text, keyword) {
    let re = keywordRegexCache.get(keyword);
    if (!re) {
      re = new RegExp('\\b' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      keywordRegexCache.set(keyword, re);
    }
    return re.test(text);
  }

  function categorizeStore(store) {
    const categoryMap = getCategoryMap();
    const storeLower = store.toLowerCase();
    const cached = categoryCache.storeCat.get(storeLower);
    if (cached) return cached;
    let result = 'Other';
    for (const [category, keywords] of Object.entries(categoryMap)) {
      if (keywords.some(keyword => keywordMatches(storeLower, keyword))) {
        result = category;
        break;
      }
    }
    categoryCache.storeCat.set(storeLower, result);
    return result;
  }

  // Manual category on the entry wins; otherwise guess from keywords
  function getCategory(row) {
    return row['Category'] || categorizeStore(row['Purchased Store'] || '');
  }

  function getCategoryBadge(category) {
    const classMap = {
      'Groceries': 'category-groceries',
      'Bills': 'category-bills',
      'Loans': 'category-loans',
      'Rent': 'category-rent',
      'Income': 'category-income',
      'SPA': 'category-spa',
      'Dining': 'category-dining',
      'Phone & Internet': 'category-bills',
      'Utilities': 'category-bills',
      'Credit Card Payment': 'category-loans',
      'Subscriptions': 'category-software',
      'Home': 'category-rent',
      'Software': 'category-software',
      'Flight': 'category-flight',
      'Travel': 'category-travel',
      'Movie': 'category-movie',
      'India': 'category-india',
      'Shopping': 'category-shopping',
      'Other': 'category-other'
    };
    if (classMap[category]) {
      return `<span class="category-badge ${classMap[category]}">${escapeHtml(category)}</span>`;
    }
    // Custom categories get a stable auto-generated color from their name
    let hue = 0;
    for (const ch of category) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="category-badge" style="background-color: hsl(${hue} 70% 88%); color: hsl(${hue} 60% 28%);">${escapeHtml(category)}</span>`;
  }

  function sortData(column) {
    // Reset all sort icons
    sortableHeaders.forEach(header => {
      header.setAttribute('data-sort-direction', 'none');
      header.querySelector('.sort-icon').textContent = '';
    });
    
    const header = document.querySelector(`th[data-sort="${column}"]`);
    
    // Determine new sort direction
    let direction = 'asc';
    if (currentSort.column === column) {
      if (currentSort.direction === 'desc') {
        // Third click: back to the default newest-first, grouped-by-day view
        currentSort = { column: null, direction: 'none' };
        renderTable();
        return;
      }
      direction = 'desc';
    }
    
    // Update current sort
    currentSort = { column, direction };
    header.setAttribute('data-sort-direction', direction);
    
    // Update sort icon
    const sortIcon = header.querySelector('.sort-icon');
    sortIcon.textContent = direction === 'asc' ? '↑' : '↓';

    // Sort the data
    budgetData.sort((a, b) => {
      if (column === 'amount') {
        const nA = Number(a['Amount Total']) || 0;
        const nB = Number(b['Amount Total']) || 0;
        return direction === 'asc' ? nA - nB : nB - nA;
      }

      let valueA = a[column === 'date' ? 'Date' : 'Purchased By'] || '';
      let valueB = b[column === 'date' ? 'Date' : 'Purchased By'] || '';

      if (column === 'date') {
        return direction === 'asc' ? new Date(valueA) - new Date(valueB) : new Date(valueB) - new Date(valueA);
      }

      valueA = valueA.toLowerCase();
      valueB = valueB.toLowerCase();
      if (valueA < valueB) return direction === 'asc' ? -1 : 1;
      if (valueA > valueB) return direction === 'asc' ? 1 : -1;
      return 0;
    });
    
    renderTable();
  }

  function getFilteredData() {
    const searchTerm = searchInput.value.toLowerCase();
    const start = filterStartDate.value;
    const end = filterEndDate.value;
    const minAmount = parseFloat(filterMinAmount.value) || 0;
    const maxAmount = parseFloat(filterMaxAmount.value) || Infinity;

    return budgetData.filter(row => {
      const matchesSearch = (
        (row['Purchased By'] || '').toLowerCase().includes(searchTerm) ||
        (row['Purchased Store'] || '').toLowerCase().includes(searchTerm) ||
        (row['Bank Name'] || '').toLowerCase().includes(searchTerm) ||
        getCategory(row).toLowerCase().includes(searchTerm)
      );

      const rowDate = row['Date'] || '';
      const matchesDate = (!start || rowDate >= start) && (!end || rowDate <= end);

      const rowAmount = Number(row['Amount Total']) || 0;
      const matchesAmount = rowAmount >= minAmount && rowAmount <= maxAmount;

      return matchesSearch && matchesDate && matchesAmount;
    });
  }

  function fmtSigned(cents) {
    return (cents > 0 ? '+' : cents < 0 ? '−' : '') + fmtMoney(Math.abs(cents) / 100);
  }

  function dayLabel(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr ? `Date: ${dateStr}` : 'No date';
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (y !== new Date().getFullYear()) opts.year = 'numeric';
    const label = date.toLocaleDateString(undefined, opts);
    if (dateStr === todayStr()) return `Today · ${label}`;
    if (dateStr === dateOffsetStr(-1)) return `Yesterday · ${label}`;
    return label;
  }

  function shortDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr || '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderTable() {
    const table = document.getElementById('budgetTable');
    const tbody = table.querySelector('tbody');
    const tfoot = table.querySelector('tfoot');

    const filteredData = getFilteredData();
    const filtersActive = searchInput.value !== '' || filterStartDate.value || filterEndDate.value ||
      filterMinAmount.value !== '' || filterMaxAmount.value !== '';

    document.getElementById('rowCount').textContent =
      filtersActive ? `(${filteredData.length} of ${budgetData.length})` : `(${budgetData.length})`;

    // Forget selections for rows that no longer exist
    const live = new Set(budgetData);
    [...selectedRows].forEach(r => { if (!live.has(r)) selectedRows.delete(r); });
    updateBulkBar(filteredData);
    refreshStoreSuggestions();

    if (filteredData.length === 0) {
      table.classList.remove('grouped');
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state">
        <i class="fas ${filtersActive ? 'fa-filter-circle-xmark' : 'fa-receipt'}"></i>
        <div class="empty-title">${filtersActive ? 'No matching transactions' : 'No transactions yet'}</div>
        <div class="empty-hint">${filtersActive ? 'Try adjusting or clearing your filters.' : 'Add your first entry above, or open an Excel file to get started.'}</div>
      </div></td></tr>`;
      tfoot.innerHTML = '';
      updateTotals();
      renderBudgetTracking();
      return;
    }

    const indexOf = new Map(budgetData.map((r, i) => [r, i]));
    // Default view: newest first, latest-added first within a day
    let rows = filteredData;
    if (!currentSort.column) {
      rows = [...filteredData].sort((a, b) =>
        String(b['Date'] || '').localeCompare(String(a['Date'] || '')) || indexOf.get(b) - indexOf.get(a));
    }
    const grouped = !currentSort.column || currentSort.column === 'date';
    table.classList.toggle('grouped', grouped);

    // Day totals follow the same rules as the dashboard (transfers don't count)
    const dayTotals = {};
    if (grouped) rows.forEach(r => {
      const c = classify(r);
      dayTotals[r['Date'] || ''] = (dayTotals[r['Date'] || ''] || 0) + c.income - c.spend;
    });

    let html = '';
    let lastDay = null;
    let spentC = 0;
    let incomeC = 0;
    let transferC = 0;
    rows.forEach(row => {
      const idx = indexOf.get(row);
      const day = row['Date'] || '';
      if (grouped && day !== lastDay) {
        lastDay = day;
        const total = dayTotals[day];
        html += `<tr class="day-row"><td colspan="7"><div class="day-head"><span>${escapeHtml(dayLabel(day))}</span>` +
          `<span class="day-total ${total > 0 ? 'is-income' : ''}">${fmtSigned(total)}</span></div></td></tr>`;
      }
      const c = classify(row);
      spentC += c.spend;
      incomeC += c.income;
      transferC += Math.abs(c.transfer);
      const net = toCents(row['Credit [C]']) - toCents(row['Debit [D]']);
      const amountClass = c.kind === 'transfer' ? 'is-transfer' : net > 0 ? 'is-income' : 'is-expense';
      const kindTag = c.kind === 'transfer' ? '<span class="kind-tag">Transfer · not counted</span>'
        : c.kind === 'refund' ? '<span class="kind-tag refund">Refund</span>' : '';
      const store = row['Purchased Store'] || '';
      const meta = [grouped ? '' : shortDate(day), row['Purchased By'], row['Bank Name']].filter(Boolean).join(' · ');
      const checked = selectedRows.has(row);
      html +=
        `<tr class="txn-row${checked ? ' selected' : ''}" data-index="${idx}" tabindex="0">` +
        `<td class="sel-col"><input type="checkbox" class="row-check" data-index="${idx}"${checked ? ' checked' : ''} aria-label="Select ${escapeHtml(store || 'transaction')}"></td>` +
        `<td class="col-date">${escapeHtml(shortDate(day))}</td>` +
        `<td class="col-txn"><div class="txn-store">${escapeHtml(store || '—')}</div>` +
        `<div class="txn-sub">${getCategoryBadge(getCategory(row))}${kindTag}<span class="txn-meta">${escapeHtml(meta)}</span></div></td>` +
        `<td class="col-person">${escapeHtml(row['Purchased By'] || '')}</td>` +
        `<td class="col-bank">${escapeHtml(row['Bank Name'] || '')}</td>` +
        `<td class="right amount-cell ${amountClass}">${fmtSigned(net)}</td>` +
        `<td class="center col-actions">` +
        `<button type="button" class="icon-btn" data-action="editRow" data-index="${idx}" aria-label="Edit ${escapeHtml(store || 'transaction')}"><i class="fas fa-pen"></i></button>` +
        `<button type="button" class="icon-btn danger" data-action="removeRow" data-index="${idx}" aria-label="Delete ${escapeHtml(store || 'transaction')}"><i class="fas fa-trash"></i></button>` +
        `</td></tr>`;
    });
    tbody.innerHTML = html;

    const n = filteredData.length;
    tfoot.innerHTML = `<tr><td colspan="7"><div class="table-totals">` +
      `<span>${n} transaction${n === 1 ? '' : 's'}</span>` +
      `<span>Spent <strong class="is-expense">${fmtMoney(spentC / 100)}</strong></span>` +
      `<span>Income <strong class="is-income">${fmtMoney(incomeC / 100)}</strong></span>` +
      `<span>Net <strong class="${incomeC - spentC >= 0 ? 'is-income' : 'is-expense'}">${fmtSigned(incomeC - spentC)}</strong></span>` +
      (transferC ? `<span class="totals-transfer">Transfers <strong>${fmtMoney(transferC / 100)}</strong> not counted</span>` : '') +
      `</div></td></tr>`;

    updateTotals();
    renderBudgetTracking();
  }

  function renderBudgetTracking() {
    const settings = getSettings();
    const list = document.getElementById('budgetProgressList');
    const section = document.getElementById('budgetTrackingSection');
    
    if (Object.keys(settings.budgets).length === 0 || budgetData.length === 0) {
      section.style.display = 'none';
      return;
    }
    
    section.style.display = 'block';
    list.innerHTML = '';

    // Budgets are monthly: count the month shown in the overview (or this month for "All time")
    const monthPrefix = dashActive !== 'all' ? dashActive : todayStr().slice(0, 7);
    const monthName = monthLabelOf(monthPrefix, { month: 'long', year: 'numeric' });
    document.getElementById('budgetMonthLabel').textContent = `— ${monthName}`;

    // For the month in progress, project month-end spending from the pace so far
    const isCurrent = monthPrefix === todayStr().slice(0, 7);
    const monthRows = budgetData.filter(r => (r['Date'] || '').startsWith(monthPrefix));
    const [by, bm] = monthPrefix.split('-').map(Number);
    const daysInMonth = new Date(by, bm, 0).getDate();
    const elapsed = isCurrent ? monthCutoffDay(monthRows) : daysInMonth;

    Object.entries(settings.budgets).forEach(([target, limit]) => {
      const spentC = monthRows.reduce((cents, r) => {
        const cat = getCategory(r);
        // A budget can target a sub-category, a whole group (e.g. "Bills & Utilities"), or store text
        const matches = (cat === target || getCategoryGroup(cat) === target ||
          (r['Purchased Store'] || '').toLowerCase().includes(target.toLowerCase()));
        return matches ? cents + spendOf(r) : cents;
      }, 0);
      const limitC = toCents(limit);
      const projectedC = isCurrent ? forecastMonth(spentC, elapsed, daysInMonth) : null;
      const status = budgetStatus(spentC, limitC, projectedC);
      const percent = limitC > 0 ? Math.max(0, Math.min((spentC / limitC) * 100, 100)) : 0;
      const left = limitC - spentC;
      const statusText = { over: 'Over budget', risk: 'At risk', ok: 'On track' }[status];
      const statusIcon = { over: 'fa-circle-exclamation', risk: 'fa-triangle-exclamation', ok: 'fa-circle-check' }[status];
      const detail = left >= 0 ? `${fmtMoney(left / 100)} left` : `${fmtMoney(-left / 100)} over`;
      const forecast = projectedC !== null && status !== 'over'
        ? ` · on pace for ${fmtMoney(projectedC / 100)}` : '';

      const item = document.createElement('div');
      item.className = `budget-item budget-${status}`;
      item.innerHTML = `
        <div class="budget-row">
          <span class="budget-name">${escapeHtml(target)}</span>
          <span class="budget-amounts">${fmtMoney(spentC / 100)} <span>/ ${fmtMoney(limitC / 100)}</span></span>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${percent}%"></div></div>
        <div class="budget-foot">
          <span class="budget-status"><i class="fas ${statusIcon}" aria-hidden="true"></i> ${statusText}</span>
          <span>${detail}${forecast}</span>
        </div>
      `;
      list.appendChild(item);
    });
  }

  // ---- Edit dialog ----
  function openEditor(index) {
    const row = budgetData[index];
    if (!row) return;
    editIndex = index;
    const settings = getSettings();
    // Keep the row's own value selectable even if it was removed from Settings
    const fill = (id, list, current) => {
      const items = (!current || list.includes(current)) ? list : [current, ...list];
      document.getElementById(id).innerHTML = items.map(v =>
        `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
    };
    fill('editPerson', settings.people, row['Purchased By'] || '');
    fill('editBank', settings.banks, row['Bank Name'] || '');

    const debit = toCents(row['Debit [D]']);
    const credit = toCents(row['Credit [C]']);
    const isIncome = credit > debit;
    setEntryType(document.querySelector('#editCard .type-toggle'), isIncome ? 'C' : 'D');
    // Old rows can carry both columns; the dialog edits the net amount
    document.getElementById('editAmount').value = (Math.abs(credit - debit) / 100).toFixed(2);
    document.getElementById('editDate').value = /^\d{4}-\d{2}-\d{2}$/.test(row['Date']) ? row['Date'] : '';
    document.getElementById('editStore').value = row['Purchased Store'] || '';

    const cat = row['Category'] || '';
    const catSel = document.getElementById('editCategory');
    if (cat && ![...catSel.options].some(o => o.value === cat)) {
      catSel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`);
    }
    catSel.value = cat;
    document.getElementById('editCategoryLabel').textContent = cat || `Auto-detect (${categorizeStore(row['Purchased Store'] || '')})`;

    setFieldError('editAmountError', '');
    setFieldError('editDateError', '');
    syncDateChips();
    document.getElementById('editModal').style.display = 'flex';
    setTimeout(() => document.getElementById('editAmount').focus(), 50);
  }

  function closeEditor() {
    editIndex = -1;
    closeCategoryPickers();
    document.getElementById('editModal').style.display = 'none';
  }

  function saveEdit() {
    if (editIndex < 0) return;
    const entry = readEntryForm(EDIT_FORM);
    if (!entry || !confirmIfDuplicate(entry, editIndex)) return;
    const before = budgetData[editIndex];
    const at = editIndex;
    budgetData[at] = entry;
    if (selectedRows.delete(before)) selectedRows.add(entry);
    markChanged();
    closeEditor();
    renderTable();
    // The edited row was redrawn, so put keyboard focus back on its new copy
    const rowEl = document.querySelector(`#budgetTable tr.txn-row[data-index="${at}"]`);
    if (rowEl) rowEl.focus({ preventScroll: true });
    showStatus('✅ Changes saved.', false, () => {
      if (budgetData[at] === entry) budgetData[at] = before;
      markChanged();
      renderTable();
      showStatus('↩️ Edit undone.');
    });
  }

  function duplicateFromEditor() {
    if (editIndex < 0) return;
    const entry = readEntryForm(EDIT_FORM);
    if (!entry) return;
    entry['Date'] = todayStr();
    budgetData.push(entry);
    markChanged();
    closeEditor();
    dashPinned = null;
    renderTable();
    showStatus(`✅ Copied to today: ${entry['Purchased Store'] || 'transaction'} ${fmtMoney(entry['Amount Total'])}`);
  }

  function removeRow(index) {
    const removed = budgetData[index];
    if (!removed) return;
    budgetData.splice(index, 1);
    selectedRows.delete(removed);
    markChanged();
    renderTable();
    showStatus('🗑️ Entry deleted.', false, () => {
      budgetData.splice(Math.min(index, budgetData.length), 0, removed);
      markChanged();
      renderTable();
      showStatus('↩️ Entry restored.');
    });
  }

  // ---- Bulk actions ----
  function updateBulkBar(filteredData) {
    const bar = document.getElementById('bulkBar');
    const count = selectedRows.size;
    bar.hidden = count === 0;
    document.getElementById('bulkCount').textContent = `${count} selected`;
    const all = document.getElementById('selectAll');
    const shown = filteredData || getFilteredData();
    const shownSelected = shown.filter(r => selectedRows.has(r)).length;
    all.checked = shown.length > 0 && shownSelected === shown.length;
    all.indeterminate = shownSelected > 0 && shownSelected < shown.length;
  }

  function bulkSetCategory() {
    const value = document.getElementById('bulkCategory').value;
    if (!value) {
      showStatus('⚠️ Choose a category first.', true);
      return;
    }
    const rows = [...selectedRows];
    const before = rows.map(r => r['Category']);
    rows.forEach(r => {
      if (value === '__auto') delete r['Category'];
      else r['Category'] = value;
    });
    markChanged(rows.length);
    renderTable();
    showStatus(`🏷️ Updated ${rows.length} transaction${rows.length === 1 ? '' : 's'}.`, false, () => {
      rows.forEach((r, i) => {
        if (before[i] === undefined) delete r['Category'];
        else r['Category'] = before[i];
      });
      markChanged();
      renderTable();
      showStatus('↩️ Categories restored.');
    });
  }

  function bulkDelete() {
    const rows = new Set(selectedRows);
    if (!rows.size || !confirm(`Delete ${rows.size} selected transaction${rows.size === 1 ? '' : 's'}?`)) return;
    const snapshot = budgetData;
    budgetData = budgetData.filter(r => !rows.has(r));
    selectedRows.clear();
    markChanged(rows.size);
    renderTable();
    showStatus(`🗑️ Deleted ${rows.size} transaction${rows.size === 1 ? '' : 's'}.`, false, () => {
      budgetData = snapshot;
      markChanged();
      renderTable();
      showStatus('↩️ Transactions restored.');
    });
  }

  // ---- Unsaved changes & draft ----
  const DRAFT_KEY = 'spendwise_draft';
  let pendingDraft = null; // a draft from a previous visit, waiting for Restore/Discard

  function markChanged(n = 1) {
    unsavedCount += n;
    persistDraft();
    updateUnsavedBadge();
  }

  function markSaved() {
    unsavedCount = 0;
    persistDraft();
    updateUnsavedBadge();
  }

  // Unsaved work is kept on this device only (never sent anywhere), so a
  // refresh or closed tab can't lose it. Cleared once the data is saved.
  function persistDraft() {
    try {
      if (unsavedCount > 0 && budgetData.length) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          unsaved: unsavedCount,
          rows: budgetData,
          source: source ? { name: source.name, months: source.months } : null
        }));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch (e) { /* storage full or unavailable — the leave-page warning still protects */ }
  }

  function updateUnsavedBadge() {
    const badge = document.getElementById('unsavedBadge');
    badge.hidden = unsavedCount === 0;
    badge.textContent = unsavedCount > 99 ? '99+' : String(unsavedCount);
    document.getElementById('downloadBtn').setAttribute('aria-label', unsavedCount
      ? `Save to Excel, ${unsavedCount} unsaved change${unsavedCount === 1 ? '' : 's'}`
      : 'Save to Excel');
  }

  function checkForDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { /* corrupted */ }
    if (!draft || !Array.isArray(draft.rows) || !draft.rows.length) {
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
      return;
    }
    pendingDraft = draft;
    const when = new Date(Number(draft.savedAt) || Date.now()).toLocaleString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const changes = Math.max(1, parseInt(draft.unsaved, 10) || 1);
    document.getElementById('draftText').textContent =
      `You have ${changes} unsaved change${changes === 1 ? '' : 's'} from ${when} (${draft.rows.length} transactions).`;
    document.getElementById('draftBanner').hidden = false;
  }

  async function restoreDraft() {
    const draft = pendingDraft;
    if (!draft) return;
    if (unsavedCount > 0 && !confirm('Replace what you have entered now with the restored transactions?')) return;
    // Rows go through the same cleanup as an Excel file
    budgetData = draft.rows.filter(r => r && typeof r === 'object').map(normalizeRow);
    source = null;
    if (draft.source && typeof draft.source.name === 'string' && Array.isArray(draft.source.months)) {
      const handle = await loadSourceHandle();
      source = {
        name: draft.source.name,
        months: draft.source.months.filter(m => /^\d{4}-\d{2}$/.test(m)),
        handle: handle && handle.name === draft.source.name ? handle : null,
        workbook: null
      };
    }
    pendingDraft = null;
    document.getElementById('draftBanner').hidden = true;
    selectedRows.clear();
    dashPinned = null;
    unsavedCount = 0;
    markChanged(Math.max(1, parseInt(draft.unsaved, 10) || 1));
    renderTable();
    showStatus(`↩️ Restored ${budgetData.length} transactions. Save when you're ready.`);
  }

  function discardDraft() {
    pendingDraft = null;
    document.getElementById('draftBanner').hidden = true;
    persistDraft(); // keeps any work from this visit, drops the old draft otherwise
    showStatus('🧹 Old unsaved changes discarded.');
  }

  // The writable file handle (Chrome/Edge) is kept in IndexedDB so Save can
  // still update the same file after a restore
  function idbRequest(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const open = indexedDB.open('moneta', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { open.result.close(); resolve(req ? req.result : null); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  function storeSourceHandle(handle) {
    return idbRequest('readwrite', store => (handle ? store.put(handle, 'source') : store.delete('source'))).catch(() => null);
  }

  function loadSourceHandle() {
    return idbRequest('readonly', store => store.get('source')).catch(() => null);
  }

  function clearTable() {
    if (!budgetData.length) {
      showStatus('ℹ️ There are no transactions to clear.');
      return;
    }
    const warn = unsavedCount ? `\n\n⚠️ ${unsavedCount} change${unsavedCount === 1 ? ' is' : 's are'} not saved to Excel yet.` : '';
    if (!confirm(`🗑️ Clear all ${budgetData.length} transactions from the screen?${warn}`)) return;
    const snapshot = { rows: budgetData, unsaved: unsavedCount, source };
    budgetData = [];
    selectedRows.clear();
    source = null;
    storeSourceHandle(null);
    markSaved();
    renderTable();
    showStatus('✅ All data cleared.', false, () => {
      budgetData = snapshot.rows;
      source = snapshot.source;
      if (source && source.handle) storeSourceHandle(source.handle);
      unsavedCount = 0;
      markChanged(snapshot.unsaved || 0);
      renderTable();
      showStatus('↩️ Transactions restored.');
    });
  }

  // ---- Saving to Excel ----
  const EXPORT_COLUMNS = ['Date', 'Purchased By', 'Purchased Store', 'Bank Name', 'Category', 'Debit [D]', 'Credit [C]', 'Amount Total'];

  function buildSheet(rows) {
    const clean = rows.map(r => Object.fromEntries(EXPORT_COLUMNS.map(c => [c, r[c] ?? ''])));
    const ws = XLSX.utils.json_to_sheet(clean, { header: EXPORT_COLUMNS });
    const widths = EXPORT_COLUMNS.map(col => Math.max(col.length, ...clean.map(row => String(row[col]).length)));
    ws['!cols'] = widths.map(w => ({ wch: Math.min(40, Math.max(10, w + 2)) }));
    return ws;
  }

  // Puts the sheet first in the workbook, keeping any other sheets the user added
  function withDataSheet(workbook, ws) {
    const wb = workbook || XLSX.utils.book_new();
    if (wb.SheetNames.length) wb.Sheets[wb.SheetNames[0]] = ws;
    else XLSX.utils.book_append_sheet(wb, ws, 'Budget Data');
    return wb;
  }

  function monthFileName(key) {
    if (!/^\d{4}-\d{2}$/.test(key)) return 'Expenses.xlsx';
    return `${monthLabelOf(key, { month: 'short' })}-${key.slice(0, 4)}-Expenses.xlsx`;
  }

  async function downloadExcel() {
    if (budgetData.length === 0) {
      showStatus('❌ No data to save yet.', true);
      return;
    }
    if (typeof XLSX === 'undefined') {
      showStatus('❌ Excel library not loaded. Please refresh and try again.', true);
      return;
    }
    try {
      const groups = groupForSave(budgetData, source ? source.months : null, todayStr().slice(0, 7));
      const done = [];
      for (const [key, rows] of groups) {
        const ws = buildSheet(rows);
        if (key === 'source') {
          if (source.handle && await saveToSourceFile(ws)) {
            done.push(`updated ${source.name}`);
            continue;
          }
          const name = source.name.replace(/\.[^.]*$/, '') + '.xlsx';
          XLSX.writeFile(withDataSheet(source.workbook, ws), name);
          done.push(`downloaded ${name}`);
        } else {
          const name = monthFileName(key);
          XLSX.writeFile(withDataSheet(null, ws), name);
          done.push(`downloaded ${name}`);
        }
      }
      markSaved();
      showStatus(`✅ Saved — ${done.join(', ')}`);
    } catch (error) {
      showStatus('❌ Could not save the Excel file: ' + error.message, true);
    }
  }

  // Writes into the file that was opened (Chrome/Edge). Returns false if the
  // user declines access, so the caller falls back to a download.
  async function saveToSourceFile(ws) {
    const { handle } = source;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) !== 'granted' &&
        (await handle.requestPermission(opts)) !== 'granted') {
      return false;
    }
    if (!source.workbook) {
      // After a restore: re-read the file so its other sheets are kept
      source.workbook = XLSX.read(new Uint8Array(await (await handle.getFile()).arrayBuffer()), { type: 'array' });
    }
    const writable = await handle.createWritable();
    await writable.write(XLSX.write(withDataSheet(source.workbook, ws), { bookType: 'xlsx', type: 'array' }));
    await writable.close();
    return true;
  }

  async function pickAndLinkExcel() {
    if (!confirmReplaceUnsaved()) return;
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'Excel files',
          accept: {
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            'application/vnd.ms-excel': ['.xls']
          }
        }]
      });
    } catch (e) {
      return; // picker cancelled
    }
    // Only .xlsx can be written back; .xls files are saved as a new .xlsx
    const writable = /\.xlsx$/i.test(handle.name);
    const ok = await importWorkbook(await handle.getFile(), writable ? handle : null);
    if (ok) storeSourceHandle(writable ? handle : null);
  }

  function confirmReplaceUnsaved() {
    return unsavedCount === 0 ||
      confirm(`You have ${unsavedCount} unsaved change${unsavedCount === 1 ? '' : 's'}. Open another file and lose them?`);
  }

  // Converts any date Excel might hand us (ISO string, Date cell, serial
  // number, or locale string) into the YYYY-MM-DD format the app uses.
  function excelDateToStr(v) {
    if (v === null || v === undefined || v === '') return '';
    const pad = (n) => String(n).padStart(2, '0');
    if (v instanceof Date && !isNaN(v)) {
      return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    }
    if (typeof v === 'number' && isFinite(v)) {
      // Excel serial date: days since 1899-12-30
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const parsed = new Date(s);
    if (!isNaN(parsed)) {
      return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    }
    return s;
  }

  // Accepts rows from any Moneta export — old files without a Category
  // column and files re-saved by Excel included — and normalizes them.
  function normalizeRow(row) {
    const debitRaw = row['Debit [D]'];
    const creditRaw = row['Credit [C]'];
    const debit = (debitRaw === undefined || debitRaw === '') ? '' : (Number(debitRaw) || 0);
    const credit = (creditRaw === undefined || creditRaw === '') ? '' : (Number(creditRaw) || 0);
    let amount = Number(row['Amount Total']);
    if (!isFinite(amount)) amount = (Number(debit) || 0) + (Number(credit) || 0);

    const entry = {
      'Date': excelDateToStr(row['Date']),
      'Purchased By': String(row['Purchased By'] ?? '').trim(),
      'Purchased Store': String(row['Purchased Store'] ?? '').trim(),
      'Bank Name': String(row['Bank Name'] ?? '').trim(),
      'Debit [D]': debit,
      'Credit [C]': credit,
      'Amount Total': amount
    };
    if (row['Category']) entry['Category'] = String(row['Category']).trim();
    return entry;
  }

  function uploadExcel(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !confirmReplaceUnsaved()) return;
    importWorkbook(file, null).then(ok => { if (ok) storeSourceHandle(null); });
  }

  // Loads the first sheet into the table and remembers the file as the save
  // target for its months. Resolves to true on success.
  async function importWorkbook(file, handle) {
    try {
      if (typeof XLSX === 'undefined') throw new Error('Excel library not loaded. Please refresh.');
      if (file.size > 20 * 1024 * 1024) throw new Error('File is larger than 20 MB.');
      const data = new Uint8Array(await file.arrayBuffer());
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = firstSheet ? XLSX.utils.sheet_to_json(firstSheet) : [];
      if (jsonData.length === 0) {
        showStatus('❌ No data found in the Excel file.', true);
        return false;
      }
      budgetData = jsonData.map(normalizeRow);
      source = {
        name: file.name,
        months: [...new Set(budgetData.map(monthKeyOf).filter(Boolean))],
        handle,
        workbook
      };
      selectedRows.clear();
      editIndex = -1;
      dashPinned = null;
      pendingDraft = null;
      document.getElementById('draftBanner').hidden = true;
      markSaved();
      renderTable();
      const dups = countDuplicates(budgetData);
      showStatus(`✅ Opened ${budgetData.length} transaction${budgetData.length > 1 ? 's' : ''} from ${file.name}` +
        (dups ? ` · ⚠️ ${dups} look${dups === 1 ? 's' : ''} like duplicate${dups === 1 ? '' : 's'}` : ''));
      return true;
    } catch (error) {
      showStatus('❌ Error reading Excel file: ' + error.message, true);
      return false;
    }
  }

  async function uploadMultipleExcel(event) {
    // Copy first: clearing the input (so the same files can be picked again) empties its FileList
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (files.length === 0) return;

    const allMonthlyData = {};
    let grandTotalIncome = 0;
    let grandTotalExpense = 0;
    document.getElementById('comparisonSummary').style.display = 'none';

    const filePromises = Array.from(files).map(file => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet);
            
            jsonData.forEach(raw => {
              const row = normalizeRow(raw);
              if (row['Date']) {
                const parts = row['Date'].split('-');
                if (parts.length >= 2) {
                  const sortKey = `${parts[0]}-${parts[1]}`;
                  if (!allMonthlyData[sortKey]) {
                    const displayDate = new Date(parts[0], parts[1] - 1, 1);
                    const label = displayDate.toLocaleString('default', { month: 'short', year: 'numeric' });
                    allMonthlyData[sortKey] = { label, income: 0, expenses: 0 };
                  }
                  const c = classify(row);
                  allMonthlyData[sortKey].income += c.income;
                  allMonthlyData[sortKey].expenses += c.spend;
                }
              }
            });
            resolve();
          } catch (err) { reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      });
    });

    try {
      await Promise.all(filePromises);

      Object.values(allMonthlyData).forEach(m => {
        grandTotalIncome += m.income;   // still in cents here
        grandTotalExpense += m.expenses;
        m.income /= 100;                // dollars for the chart
        m.expenses /= 100;
      });

      document.getElementById('compareTotalIncome').textContent = fmtMoney(grandTotalIncome / 100);
      document.getElementById('compareTotalExpense').textContent = fmtMoney(grandTotalExpense / 100);
      document.getElementById('compareTotalSavings').textContent = fmtMoney((grandTotalIncome - grandTotalExpense) / 100);
      document.getElementById('comparisonSummary').style.display = 'grid';

      updateCompareMonthsChart(allMonthlyData);
      showStatus(`✅ Successfully processed ${files.length} files for comparison.`);
    } catch (error) {
      showStatus('❌ Error processing comparison files: ' + error.message, true);
    }
  }

  function updateCompareMonthsChart(aggregatedData) {
    const ctx = document.getElementById('compareMonthsChart').getContext('2d');
    if (compareMonthsChart) compareMonthsChart.destroy();

    const sortedKeys = Object.keys(aggregatedData).sort();
    const labels = sortedKeys.map(k => aggregatedData[k].label);
    const incomeData = sortedKeys.map(k => aggregatedData[k].income);
    const expensesData = sortedKeys.map(k => aggregatedData[k].expenses);

    const theme = chartTheme();

    compareMonthsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Income',
            data: incomeData,
            backgroundColor: theme.income,
            borderRadius: 4,
            maxBarThickness: 24,
            barPercentage: 0.8,
            categoryPercentage: 0.6
          },
          {
            label: 'Expenses',
            data: expensesData,
            backgroundColor: theme.expense,
            borderRadius: 4,
            maxBarThickness: 24,
            barPercentage: 0.8,
            categoryPercentage: 0.6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: chartLegend(theme),
          tooltip: chartTooltip(theme, {
            label: context => `${context.dataset.label}: ${fmtMoney(context.raw)}`
          })
        },
        scales: {
          x: labelAxis(theme),
          y: moneyAxis(theme)
        }
      }
    });
  }

  function updateTotals() {
    renderDashboard();
  }

  // ---- Pure calculation helpers (covered by tests.js) ----
  function monthKeyOf(row) {
    const k = String(row['Date'] || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(k) ? k : null;
  }

  function monthLabelOf(key, opts = { month: 'short', year: 'numeric' }) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('default', opts);
  }

  function shiftMonth(key, n) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function dayOf(row) {
    return Number(String(row['Date'] || '').slice(8, 10)) || 0;
  }

  // What a row means for your totals, in cents:
  //  - Transfers & Savings (card payments, own-account moves, investing) count as neither
  //  - Income-category credits are income
  //  - everything else is spending; a credit there is a refund and lowers spending
  function classify(row) {
    const debit = toCents(row['Debit [D]']);
    const credit = toCents(row['Credit [C]']);
    const group = getCategoryGroup(getCategory(row));
    if (group === TRANSFER_GROUP) return { spend: 0, income: 0, transfer: credit - debit, kind: 'transfer' };
    if (group === 'Income') return { spend: 0, income: credit - debit, transfer: 0, kind: 'income' };
    return { spend: debit - credit, income: 0, transfer: 0, kind: credit > debit ? 'refund' : 'expense' };
  }

  const spendOf = row => classify(row).spend;
  const incomeOf = row => classify(row).income;

  function periodTotals(rows) {
    let spentC = 0;
    let incomeC = 0;
    rows.forEach(r => {
      const c = classify(r);
      spentC += c.spend;
      incomeC += c.income;
    });
    return {
      spent: spentC / 100,
      income: incomeC / 100,
      net: (incomeC - spentC) / 100,
      rate: incomeC > 0 ? ((incomeC - spentC) / incomeC) * 100 : null
    };
  }

  // Same date, store and amounts = probably the same transaction
  function dupKey(r) {
    return [r['Date'] || '', String(r['Purchased Store'] || '').trim().toLowerCase(),
      toCents(r['Debit [D]']), toCents(r['Credit [C]'])].join('|');
  }

  function findDuplicate(rows, entry, skipIndex = -1) {
    const key = dupKey(entry);
    return rows.findIndex((r, i) => i !== skipIndex && dupKey(r) === key);
  }

  function countDuplicates(rows) {
    const seen = new Set();
    let dups = 0;
    rows.forEach(r => {
      const k = dupKey(r);
      if (seen.has(k)) dups++;
      else seen.add(k);
    });
    return dups;
  }

  // Decides which file each row is saved to. Months that came from the opened
  // file go back to it ('source'); any other month gets its own YYYY-MM file.
  // Rows without a valid date stay with the opened file, or else the newest month.
  function groupForSave(rows, sourceMonths, currentMonth) {
    const own = new Set(sourceMonths || []);
    const months = rows.map(monthKeyOf).filter(Boolean).sort();
    const fallback = sourceMonths ? 'source' : (months[months.length - 1] || currentMonth);
    const groups = new Map();
    rows.forEach(r => {
      const m = monthKeyOf(r);
      const key = m ? (own.has(m) ? 'source' : m) : fallback;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    return groups;
  }
  // Straight-line month-end projection from spending so far
  function forecastMonth(spentC, elapsedDays, daysInMonth) {
    if (!(elapsedDays > 0)) return spentC;
    return Math.round((spentC / Math.min(elapsedDays, daysInMonth)) * daysInMonth);
  }

  function budgetStatus(spentC, limitC, projectedC) {
    if (spentC > limitC) return 'over';
    if (projectedC !== null && projectedC > limitC) return 'risk';
    return 'ok';
  }
  // ---- end pure helpers ----

  // ---- Overview dashboard ----
  // Built from budgetData only (never the table filters), so it always shows
  // the whole file. Old exports work too: every row went through normalizeRow.
  let dashCategoryChart = null;
  let dashPaceChart = null;
  let dashTrendChart = null;
  let dashPinned = null;     // month the user picked; null = follow the latest
  let dashActive = 'all';    // what's on screen: 'YYYY-MM' or 'all'

  // Last day to show for the current month: today, or later if entries are dated ahead
  function monthCutoffDay(rows) {
    return rows.reduce((max, r) => Math.max(max, dayOf(r)), new Date().getDate());
  }

  function dataMonths() {
    return [...new Set(budgetData.map(monthKeyOf).filter(Boolean))].sort().reverse(); // newest first
  }

  function renderDashboard() {
    const months = dataMonths();
    dashActive = (dashPinned === 'all' || months.includes(dashPinned)) ? dashPinned : (months[0] || 'all');

    const sel = document.getElementById('dashPeriod');
    sel.innerHTML = '<option value="all">All time</option>' +
      months.map(k => `<option value="${k}">${escapeHtml(monthLabelOf(k, { month: 'long', year: 'numeric' }))}</option>`).join('');
    sel.value = dashActive;
    const idx = months.indexOf(dashActive);
    document.getElementById('dashPrev').disabled = dashActive === 'all' || idx === months.length - 1;
    document.getElementById('dashNext').disabled = dashActive === 'all' || idx <= 0;

    const isMonth = dashActive !== 'all';
    const rows = isMonth ? budgetData.filter(r => monthKeyOf(r) === dashActive) : budgetData;
    const prevKey = isMonth ? shiftMonth(dashActive, -1) : null;
    const prevRows = prevKey ? budgetData.filter(r => monthKeyOf(r) === prevKey) : [];
    // A month still in progress is compared with the same days of last month,
    // so day 10 isn't measured against a full 30 days
    const cutoff = isMonth && dashActive === todayStr().slice(0, 7) ? monthCutoffDay(rows) : null;
    const prevCompare = cutoff ? prevRows.filter(r => dayOf(r) <= cutoff) : prevRows;
    const prevLabel = prevKey ? monthLabelOf(prevKey, { month: 'short' }) + (cutoff ? ` 1–${cutoff}` : '') : '';
    renderKpis(rows, prevRows.length ? prevCompare : null, prevLabel);

    const empty = budgetData.length === 0;
    document.getElementById('dashEmpty').hidden = !empty;
    document.getElementById('dashCharts').hidden = empty;
    if (empty) return;

    // Redrawn on every table render, so skip animation to avoid flicker
    const theme = chartTheme();
    renderCategoryPanel(rows, theme);
    renderPacePanel(rows, prevRows, prevKey, theme);
    renderTrendPanel(months, theme);
    renderTopStores(rows);
  }

  function renderKpis(rows, prevRows, prevLabel) {
    const cur = periodTotals(rows);
    const prev = prevRows ? periodTotals(prevRows) : null;

    document.getElementById('kpiSpent').textContent = fmtMoney(cur.spent);
    document.getElementById('kpiIncome').textContent = fmtMoney(cur.income);
    const netEl = document.getElementById('kpiNet');
    netEl.textContent = fmtMoney(cur.net);
    netEl.classList.toggle('pos', cur.net > 0);
    netEl.classList.toggle('neg', cur.net < 0);
    document.getElementById('kpiRate').textContent = cur.rate === null ? '—' : `${cur.rate.toFixed(0)}%`;

    setDelta('kpiSpentDelta', cur.spent, prev && prev.spent, prevLabel, 'pct', false);
    setDelta('kpiIncomeDelta', cur.income, prev && prev.income, prevLabel, 'pct', true);
    setDelta('kpiNetDelta', cur.net, prev && prev.net, prevLabel, 'money', true);
    setDelta('kpiRateDelta', cur.rate, prev && prev.rate, prevLabel, 'pts', true);
  }

  // Change vs last month, with an arrow + word so it never relies on color alone
  function setDelta(id, cur, prev, prevLabel, kind, goodWhenUp) {
    const el = document.getElementById(id);
    el.className = 'kpi-delta';
    if (cur === null || prev === null || prev === undefined || (kind === 'pct' && prev === 0)) {
      el.textContent = '';
      return;
    }
    const diff = cur - prev;
    if (Math.abs(diff) < 0.005) {
      el.textContent = `Same as ${prevLabel}`;
      return;
    }
    const text = kind === 'pct' ? `${Math.abs((diff / prev) * 100).toFixed(0)}%`
      : kind === 'pts' ? `${Math.abs(diff).toFixed(0)} pts`
      : fmtMoney(Math.abs(diff));
    const up = diff > 0;
    el.classList.add(up === goodWhenUp ? 'good' : 'bad');
    el.innerHTML = `<i class="fas fa-arrow-${up ? 'up' : 'down'}" aria-hidden="true"></i> ${up ? 'Up' : 'Down'} ${escapeHtml(text)} vs ${escapeHtml(prevLabel)}`;
  }

  function renderCategoryPanel(rows, theme) {
    const totals = {};
    rows.forEach(r => {
      const c = spendOf(r); // refunds come off their category
      if (!c) return;
      const cat = getCategory(r);
      totals[cat] = (totals[cat] || 0) + c;
    });
    const entries = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 7);
    const rest = entries.slice(7);
    if (rest.length) top.push([`Other (${rest.length} more)`, rest.reduce((s, [, v]) => s + v, 0)]);
    const totalC = entries.reduce((s, [, v]) => s + v, 0);

    document.getElementById('dashCategorySub').textContent = entries.length
      ? `${fmtMoney(totalC / 100)} across ${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}`
      : 'No spending in this period';

    if (dashCategoryChart) dashCategoryChart.destroy();
    dashCategoryChart = new Chart(document.getElementById('dashCategoryChart'), {
      type: 'bar',
      plugins: [barValuePlugin],
      data: {
        labels: top.map(([k]) => k),
        datasets: [{
          label: 'Spent',
          data: top.map(([, v]) => v / 100),
          backgroundColor: top.map(([, ], i) => (rest.length && i === top.length - 1) ? theme.other : theme.palette[i]),
          borderRadius: 4,
          maxBarThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 56 } },
        plugins: {
          legend: chartLegend(theme, false),
          tooltip: chartTooltip(theme, { label: shareLabel }),
          barValues: { display: true, color: theme.ink, fontFamily: theme.fontFamily }
        },
        scales: {
          x: { display: false, beginAtZero: true },
          y: labelAxis(theme)
        }
      }
    });
  }

  // Running total of spending by day of month, against the month before
  function renderPacePanel(rows, prevRows, prevKey, theme) {
    const wrap = document.getElementById('dashPaceWrap');
    const sub = document.getElementById('dashPaceSub');
    if (dashPaceChart) { dashPaceChart.destroy(); dashPaceChart = null; }
    if (dashActive === 'all') {
      wrap.hidden = true;
      sub.textContent = 'Pick a month above to see how fast you are spending.';
      return;
    }
    wrap.hidden = false;

    const daysIn = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
    const cumulative = (list, key, upTo) => {
      const perDay = new Array(daysIn(key)).fill(0);
      list.forEach(r => {
        const d = dayOf(r);
        if (d >= 1 && d <= perDay.length) perDay[d - 1] += spendOf(r);
      });
      let run = 0;
      return perDay.slice(0, upTo).map(c => (run += c) / 100);
    };

    const isCurrent = dashActive === todayStr().slice(0, 7);
    const shownDays = isCurrent ? monthCutoffDay(rows) : daysIn(dashActive);
    const curSeries = cumulative(rows, dashActive, shownDays);
    const prevSeries = prevRows.length ? cumulative(prevRows, prevKey, daysIn(prevKey)) : null;
    const labelCount = Math.max(daysIn(dashActive), prevSeries ? prevSeries.length : 0);
    const curName = monthLabelOf(dashActive, { month: 'short' });
    const prevName = monthLabelOf(prevKey, { month: 'short' });

    const spentSoFar = curSeries[curSeries.length - 1] || 0;
    const projection = isCurrent && shownDays < daysIn(dashActive)
      ? ` · on pace for ${fmtMoney(forecastMonth(Math.round(spentSoFar * 100), shownDays, daysIn(dashActive)) / 100)}` : '';
    if (prevSeries) {
      const prevAtSameDay = prevSeries[Math.min(shownDays, prevSeries.length) - 1] || 0;
      const diff = spentSoFar - prevAtSameDay;
      sub.textContent = `By day ${shownDays}: ${fmtMoney(spentSoFar)} vs ${fmtMoney(prevAtSameDay)} in ${prevName}` +
        (Math.abs(diff) >= 0.01 ? ` (${diff > 0 ? fmtMoney(diff) + ' more' : fmtMoney(-diff) + ' less'})` : '') + projection;
    } else {
      sub.textContent = `${fmtMoney(spentSoFar)} spent${isCurrent ? ' so far' : ''}${projection || ` · no ${prevName} data to compare`}`;
    }

    const line = (label, data, color, dashed) => ({
      label, data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      borderDash: dashed ? [6, 4] : [],
      tension: 0.25,
      // Mark where the current month's line ends ("today")
      pointRadius: dashed ? 0 : c => (c.dataIndex === data.length - 1 ? 4 : 0),
      pointHoverRadius: 5,
      pointHoverBorderColor: theme.surface,
      pointHoverBorderWidth: 2
    });
    const datasets = [line(curName, curSeries, theme.palette[0], false)];
    if (prevSeries) datasets.push(line(prevName, prevSeries, theme.other, true));

    dashPaceChart = new Chart(document.getElementById('dashPaceChart'), {
      type: 'line',
      data: { labels: Array.from({ length: labelCount }, (_, i) => i + 1), datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: chartLegend(theme, datasets.length > 1),
          tooltip: chartTooltip(theme, {
            title: items => `Day ${items[0].label}`,
            label: c => `${c.dataset.label}: ${fmtMoney(c.raw)}`
          })
        },
        scales: {
          x: { ...labelAxis(theme), ticks: { ...labelAxis(theme).ticks, maxTicksLimit: 8, maxRotation: 0 } },
          y: moneyAxis(theme)
        }
      }
    });
  }

  // Up to 6 months ending at the selected month (or the latest one)
  function renderTrendPanel(months, theme) {
    if (dashTrendChart) dashTrendChart.destroy();
    const end = dashActive === 'all' ? months[0] : dashActive;
    const keys = end ? Array.from({ length: 6 }, (_, i) => shiftMonth(end, i - 5)) : [];
    const first = keys.findIndex(k => k >= months[months.length - 1]); // trim months before the data starts
    const shown = first > 0 ? keys.slice(first) : keys;
    const sums = Object.fromEntries(shown.map(k => [k, { incomeC: 0, expensesC: 0 }]));
    budgetData.forEach(r => {
      const k = monthKeyOf(r);
      if (sums[k]) {
        const c = classify(r);
        sums[k].incomeC += c.income;
        sums[k].expensesC += c.spend;
      }
    });
    document.getElementById('dashTrendSub').textContent = shown.length > 1
      ? `${monthLabelOf(shown[0])} — ${monthLabelOf(shown[shown.length - 1])}`
      : (shown[0] ? monthLabelOf(shown[0]) : 'No dated transactions');

    const bar = (label, data, color) => ({
      label, data, backgroundColor: color, borderRadius: 4,
      maxBarThickness: 22, barPercentage: 0.9, categoryPercentage: 0.6
    });
    dashTrendChart = new Chart(document.getElementById('dashTrendChart'), {
      type: 'bar',
      data: {
        labels: shown.map(k => monthLabelOf(k, { month: 'short' })),
        datasets: [
          bar('Income', shown.map(k => sums[k].incomeC / 100), theme.income),
          bar('Expenses', shown.map(k => sums[k].expensesC / 100), theme.expense)
        ]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: chartLegend(theme),
          tooltip: chartTooltip(theme, {
            title: items => monthLabelOf(shown[items[0].dataIndex], { month: 'long', year: 'numeric' }),
            label: c => `${c.dataset.label}: ${fmtMoney(c.raw)}`,
            footer: items => {
              const k = shown[items[0].dataIndex];
              return `Net: ${fmtMoney((sums[k].incomeC - sums[k].expensesC) / 100)}`;
            }
          })
        },
        scales: { x: labelAxis(theme), y: moneyAxis(theme) }
      }
    });
  }

  function renderTopStores(rows) {
    const stores = {};
    rows.forEach(r => {
      const c = spendOf(r);
      const name = String(r['Purchased Store'] || '').trim();
      if (!c || !name) return;
      const key = name.toLowerCase();
      if (!stores[key]) stores[key] = { name, cents: 0, count: 0 };
      stores[key].cents += c;
      stores[key].count++;
    });
    const top = Object.values(stores).filter(s => s.cents > 0).sort((a, b) => b.cents - a.cents).slice(0, 5);
    const list = document.getElementById('dashTopStores');
    if (!top.length) {
      list.innerHTML = '<li class="top-empty">No spending in this period</li>';
      return;
    }
    const max = top[0].cents;
    list.innerHTML = top.map(s => `
      <li>
        <div class="top-row">
          <span class="top-name">${escapeHtml(s.name)}</span>
          <span class="top-amount">${fmtMoney(s.cents / 100)}</span>
        </div>
        <div class="top-meta">${s.count} purchase${s.count > 1 ? 's' : ''}</div>
        <div class="top-bar"><span style="width: ${Math.max(2, (s.cents / max) * 100)}%"></span></div>
      </li>`).join('');
  }

  const dashPeriodSelect = document.getElementById('dashPeriod');
  function setDashPeriod(value) {
    dashPinned = value;
    renderDashboard();
    renderBudgetTracking();
  }
  dashPeriodSelect.addEventListener('change', () => setDashPeriod(dashPeriodSelect.value));
  // Prev = older month, Next = newer (the list is newest first)
  document.getElementById('dashPrev').addEventListener('click', () => {
    const months = dataMonths();
    const i = months.indexOf(dashActive);
    if (i > -1 && i < months.length - 1) setDashPeriod(months[i + 1]);
  });
  document.getElementById('dashNext').addEventListener('click', () => {
    const months = dataMonths();
    const i = months.indexOf(dashActive);
    if (i > 0) setDashPeriod(months[i - 1]);
  });

  function updateIncomeExpenseChart() {
    const ctx = document.getElementById('incomeExpenseChart').getContext('2d');
    
    if (incomeExpenseChart) {
      incomeExpenseChart.destroy();
    }
    
    const data = getFilteredData();
    const { spent: totalDebit, income: totalCredit } = periodTotals(data);
    const theme = chartTheme();

    incomeExpenseChart = new Chart(ctx, {
      type: 'doughnut',
      plugins: [centerTextPlugin],
      data: {
        labels: ['Expenses', 'Income'],
        datasets: [{
          data: [totalDebit, totalCredit],
          backgroundColor: [theme.expense, theme.income],
          borderColor: theme.surface,
          borderWidth: 2,
          hoverBorderColor: theme.surface,
          hoverOffset: 8
        }]
      },
      options: {
        cutout: '72%',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 8 },
        plugins: {
          title: chartTitle(theme, 'Total Cashflow Summary'),
          legend: chartLegend(theme),
          tooltip: chartTooltip(theme, { label: sliceLabel }),
          centerText: {
            value: fmtMoney(totalCredit - totalDebit),
            label: 'Net Balance',
            color: theme.ink,
            mutedColor: theme.muted,
            fontFamily: theme.fontFamily
          }
        }
      }
    });
  }

  function updateSpendingCategoryChart() {
    const ctx = document.getElementById('spendingCategoryChart').getContext('2d');
    
    if (spendingCategoryChart) {
      spendingCategoryChart.destroy();
    }
    
    const categoriesC = {};
    getFilteredData().forEach(row => {
      const c = spendOf(row);
      if (c) {
        const category = getCategory(row);
        categoriesC[category] = (categoriesC[category] || 0) + c;
      }
    });

    // Show the top slices only and group the tail so the doughnut stays
    // readable — 7 + "Other" keeps every hue inside the validated palette
    const catEntries = Object.entries(categoriesC).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const topSlices = catEntries.slice(0, 7);
    const restSlices = catEntries.slice(7);
    if (restSlices.length) {
      topSlices.push([`Other (${restSlices.length} more)`, restSlices.reduce((s, [, v]) => s + v, 0)]);
    }
    const theme = chartTheme();
    const sliceColors = topSlices.map(([, ], i) =>
      (restSlices.length && i === topSlices.length - 1) ? theme.other : theme.palette[i]);
    const totalSpentC = catEntries.reduce((s, [, v]) => s + v, 0);

    spendingCategoryChart = new Chart(ctx, {
      type: 'doughnut',
      plugins: [centerTextPlugin],
      data: {
        labels: topSlices.map(([k]) => k),
        datasets: [{
          data: topSlices.map(([, v]) => v / 100),
          backgroundColor: sliceColors,
          borderColor: theme.surface,
          borderWidth: 2,
          hoverBorderColor: theme.surface,
          hoverOffset: 8
        }]
      },
      options: {
        cutout: '72%',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 8 },
        plugins: {
          title: chartTitle(theme, 'Expenditure Breakdown'),
          legend: chartLegend(theme),
          tooltip: chartTooltip(theme, { label: sliceLabel }),
          centerText: {
            value: fmtMoney(totalSpentC / 100),
            label: 'Total Spent',
            color: theme.ink,
            mutedColor: theme.muted,
            fontFamily: theme.fontFamily
          }
        }
      }
    });
  }

  function updateMonthlyOverviewChart() {
    const ctx = document.getElementById('monthlyOverviewChart').getContext('2d');
    
    if (monthlyOverviewChart) {
      monthlyOverviewChart.destroy();
    }
    
    const monthlyData = {};
    const monthLabel = (y, m) => new Date(y, m - 1, 1).toLocaleString('default', { month: 'short', year: 'numeric' });

    getFilteredData().forEach(row => {
      if (row['Date']) {
        const parts = row['Date'].split('-');
        const sortKey = `${parts[0]}-${parts[1]}`; // YYYY-MM

        if (!monthlyData[sortKey]) {
          monthlyData[sortKey] = { label: monthLabel(parts[0], parts[1]), incomeC: 0, expensesC: 0 };
        }

        const c = classify(row);
        monthlyData[sortKey].incomeC += c.income;
        monthlyData[sortKey].expensesC += c.spend;
      }
    });

    // Fill months that had no transactions so the trend axis has no gaps
    const presentKeys = Object.keys(monthlyData).sort();
    if (presentKeys.length > 1) {
      let [y, m] = presentKeys[0].split('-').map(Number);
      const [ey, em] = presentKeys[presentKeys.length - 1].split('-').map(Number);
      while (y < ey || (y === ey && m <= em)) {
        const k = `${y}-${String(m).padStart(2, '0')}`;
        if (!monthlyData[k]) monthlyData[k] = { label: monthLabel(y, m), incomeC: 0, expensesC: 0 };
        m++;
        if (m > 12) { m = 1; y++; }
      }
    }

    const sortedKeys = Object.keys(monthlyData).sort();
    const labels = sortedKeys.map(k => monthlyData[k].label);
    const incomeData = sortedKeys.map(k => monthlyData[k].incomeC / 100);
    const expensesData = sortedKeys.map(k => monthlyData[k].expensesC / 100);
    const netData = sortedKeys.map(k => (monthlyData[k].incomeC - monthlyData[k].expensesC) / 100);
    
    const theme = chartTheme();

    monthlyOverviewChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Income',
            data: incomeData,
            backgroundColor: theme.income,
            borderRadius: 4,
            maxBarThickness: 24,
            barPercentage: 0.95,
            categoryPercentage: 0.5,
            order: 2
          },
          {
            label: 'Expenses',
            data: expensesData,
            backgroundColor: theme.expense,
            borderRadius: 4,
            maxBarThickness: 24,
            barPercentage: 0.95,
            categoryPercentage: 0.5,
            order: 2
          },
          {
            type: 'line',
            label: 'Net Savings',
            data: netData,
            borderColor: theme.net,
            backgroundColor: withAlpha(theme.net, 0.08),
            fill: 'origin',
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: theme.net,
            pointBorderColor: theme.surface,
            pointBorderWidth: 2,
            order: 1
          }
        ]
      },
      options: {
        indexAxis: 'x',
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          title: chartTitle(theme, 'Monthly Financial Trends'),
          subtitle: chartSubtitle(theme, labels.length > 1 ? `${labels[0]} — ${labels[labels.length - 1]}` : labels[0] || ''),
          legend: chartLegend(theme),
          tooltip: chartTooltip(theme, {
            label: context => `${context.dataset.label}: ${fmtMoney(context.raw)}`
          })
        },
        scales: {
          x: labelAxis(theme),
          y: moneyAxis(theme)
        }
      }
    });
  }

  function updateCreditCardSpendingChart() {
    const ctx = document.getElementById('creditCardSpendingChart').getContext('2d');
    
    if (creditCardSpendingChart) {
      creditCardSpendingChart.destroy();
    }
    
    const bankData = {};
    getFilteredData().forEach(row => {
      const c = spendOf(row);
      if (c && row['Bank Name']) {
        const bank = row['Bank Name'];
        bankData[bank] = (bankData[bank] || 0) + c;
      }
    });

    const sortedBanks = Object.fromEntries(
      Object.entries(bankData).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / 100]));
    
    const theme = chartTheme();

    creditCardSpendingChart = new Chart(ctx, {
      type: 'bar',
      plugins: [barValuePlugin],
      data: {
        labels: Object.keys(sortedBanks),
        datasets: [{
          label: 'Spending',
          data: Object.values(sortedBanks),
          backgroundColor: theme.net,
          borderRadius: 4,
          maxBarThickness: 24
        }]
      },
      options: {
        indexAxis: 'y', // Better for reading bank names
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 56 } }, // room for the tip labels
        plugins: {
          title: chartTitle(theme, 'Spending by Bank/Account'),
          subtitle: chartSubtitle(theme, 'Total spent per account'),
          legend: chartLegend(theme, false), // single series — the title says it all
          tooltip: chartTooltip(theme, { label: shareLabel }),
          barValues: { display: true, color: theme.ink, fontFamily: theme.fontFamily }
        },
        scales: {
          // every bar carries its value, so the money axis would be noise
          x: { display: false, beginAtZero: true },
          y: labelAxis(theme)
        }
      }
    });
  }

  function updatePurchasedByTrendChart() {
    const ctx = document.getElementById('purchasedByTrendChart').getContext('2d');
    
    if (purchasedByTrendChart) {
      purchasedByTrendChart.destroy();
    }
    
    const personData = {};
    getFilteredData().forEach(row => {
      const c = spendOf(row);
      if (c && row['Purchased By']) {
        const person = row['Purchased By'] || 'Unknown';
        personData[person] = (personData[person] || 0) + c;
      }
    });

    const sortedPersons = Object.fromEntries(
      Object.entries(personData).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / 100]));
    
    const theme = chartTheme();

    purchasedByTrendChart = new Chart(ctx, {
      type: 'bar',
      plugins: [barValuePlugin],
      data: {
        labels: Object.keys(sortedPersons),
        datasets: [{
          label: 'Total Spent',
          data: Object.values(sortedPersons),
          backgroundColor: theme.net,
          borderRadius: 4,
          maxBarThickness: 24
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 24 } }, // room for the tip labels
        plugins: {
          title: chartTitle(theme, 'Spending Distribution by Person'),
          subtitle: chartSubtitle(theme, 'Total spent per person'),
          legend: chartLegend(theme, false), // single series — the title says it all
          tooltip: chartTooltip(theme, { label: shareLabel }),
          barValues: { display: true, color: theme.ink, fontFamily: theme.fontFamily }
        },
        scales: {
          // every bar carries its value, so the money axis would be noise
          x: labelAxis(theme),
          y: { display: false, beginAtZero: true }
        }
      }
    });
  }

  // Initialize App State
  // Theme: saved preference wins, otherwise follow the system setting
  const savedTheme = localStorage.getItem('spendwise_theme');
  const initialTheme = savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initialTheme);
  updateThemeUI(initialTheme);
  updateDropdowns();
  populateCategoryDropdown();

  // Every visit starts with a blank sheet. Only unsaved work is kept (as a
  // draft on this device) and it is offered back, never loaded on its own.
  // Recurring transactions are only applied with the Recurring button.
  // Older versions persisted transactions under this key; remove any leftovers
  // so devices that ran the old app don't keep stale data around.
  try { localStorage.removeItem('spendwise_data'); } catch (e) { /* storage unavailable */ }
  applyCurrencySetting();

  // Default the date field to today for faster entry
  document.getElementById('date').value = todayStr();

  // Footer copyright year
  document.getElementById('footerYear').textContent = new Date().getFullYear();

  // Live category preview while typing a store name
  document.getElementById('store').addEventListener('input', updateCategoryHint);
  document.getElementById('category').addEventListener('change', updateCategoryHint);

  // Category pickers (Add form and inline edit) share one delegated handler.
  // Each picker is a .cat-wrap holding a hidden select, a button, and a panel.
  document.addEventListener('click', (e) => {
    const pickerBtn = e.target.closest('.category-picker-btn');
    if (pickerBtn) {
      const wrap = pickerBtn.closest('.cat-wrap');
      const panel = wrap.querySelector('.category-picker-panel');
      if (panel.hidden) openCategoryPanel(wrap); else closeCategoryPickers();
      return;
    }

    const panel = e.target.closest('.category-picker-panel');
    if (panel) {
      const groupBtn = e.target.closest('.cat-group');
      if (groupBtn) {
        const subs = groupBtn.nextElementSibling;
        const nowOpen = subs.hidden;
        subs.hidden = !nowOpen;
        groupBtn.classList.toggle('open', nowOpen);
        return;
      }
      const opt = e.target.closest('.cat-option');
      if (opt) {
        const wrap = panel.closest('.cat-wrap');
        const sel = wrap.querySelector('select');
        sel.value = opt.dataset.value;
        sel.dispatchEvent(new Event('change'));
        wrap.querySelector('.category-picker-btn span').textContent = opt.dataset.value || 'Auto-detect';
        closeCategoryPickers();
      }
      return; // clicks inside the panel (e.g. the search box) keep it open
    }

    closeCategoryPickers();
  });

  // Keyboard navigation inside category pickers: arrows move through visible
  // rows, Right/Left expand/collapse groups, Home/End jump, Enter selects.
  function pickerFocusables(panel) {
    return [...panel.querySelectorAll('.cat-option, .cat-group')].filter(el =>
      el.style.display !== 'none' && !el.closest('.cat-subs[hidden]'));
  }

  document.addEventListener('keydown', (e) => {
    const pickerBtn = e.target.closest && e.target.closest('.category-picker-btn');
    if (pickerBtn && e.key === 'ArrowDown') {
      e.preventDefault();
      const wrap = pickerBtn.closest('.cat-wrap');
      const panel = wrap.querySelector('.category-picker-panel');
      if (panel.hidden) openCategoryPanel(wrap);
      const first = pickerFocusables(panel)[0];
      if (first) first.focus();
      return;
    }

    const panel = e.target.closest && e.target.closest('.category-picker-panel');
    if (!panel || panel.hidden) return;

    const items = pickerFocusables(panel);
    const idx = items.indexOf(document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) (items[idx + 1] || items[items.length - 1]).focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) {
        const search = panel.querySelector('.cat-search input');
        if (search) search.focus();
      } else {
        items[idx - 1].focus();
      }
    } else if (e.key === 'ArrowRight' && document.activeElement.classList.contains('cat-group')) {
      e.preventDefault();
      const subs = document.activeElement.nextElementSibling;
      if (subs.hidden) {
        subs.hidden = false;
        document.activeElement.classList.add('open');
      }
    } else if (e.key === 'ArrowLeft') {
      const active = document.activeElement;
      if (active.classList.contains('cat-group') && !active.nextElementSibling.hidden) {
        e.preventDefault();
        active.nextElementSibling.hidden = true;
        active.classList.remove('open');
      } else {
        const subs = active.closest('.cat-subs');
        if (subs) {
          e.preventDefault();
          const groupBtn = subs.previousElementSibling;
          subs.hidden = true;
          groupBtn.classList.remove('open');
          groupBtn.focus();
        }
      }
    } else if (e.key === 'Home' && items.length) {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End' && items.length) {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  });

  // Type to filter categories: matching groups auto-expand, the rest hide
  document.addEventListener('input', (e) => {
    if (!e.target.matches('.cat-search input')) return;
    const panel = e.target.closest('.category-picker-panel');
    const q = e.target.value.trim().toLowerCase();
    panel.querySelectorAll('.cat-option').forEach(o => {
      if (!o.dataset.value) return; // Auto-detect stays visible
      o.style.display = (!q || o.dataset.value.toLowerCase().includes(q)) ? '' : 'none';
    });
    panel.querySelectorAll('.cat-subs').forEach(subs => {
      const groupBtn = subs.previousElementSibling;
      const anyVisible = [...subs.querySelectorAll('.cat-option')].some(o => o.style.display !== 'none');
      subs.hidden = q ? !anyVisible : true;
      groupBtn.classList.toggle('open', !!q && anyVisible);
      groupBtn.style.display = (!q || anyVisible) ? '' : 'none';
    });
  });

  // Clicking the app name starts a brand-new session: clears the form,
  // filters, and all transactions (confirmed, and undoable for a few seconds).
  const appTitle = document.querySelector('h1');
  appTitle.style.cursor = 'pointer';
  appTitle.addEventListener('click', () => {
    resetForm();
    closeCategoryPickers();

    if (budgetData.length === 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showStatus('🧹 Form cleared — ready for entry.');
      return;
    }

    const warn = unsavedCount ? `\n\n⚠️ ${unsavedCount} change${unsavedCount === 1 ? ' is' : 's are'} not saved to Excel yet.` : '';
    if (!confirm(`Start fresh? This clears the form and ALL transactions below so you can begin new data entry.${warn}`)) {
      return;
    }

    const snapshot = { rows: budgetData, unsaved: unsavedCount, source };
    budgetData = [];
    selectedRows.clear();
    source = null;
    storeSourceHandle(null);
    markSaved();

    // Reset every filter too, so the new session is truly blank
    filterStartDate.value = '';
    filterEndDate.value = '';
    filterMinAmount.value = '';
    filterMaxAmount.value = '';
    searchInput.value = '';
    document.getElementById('datePreset').value = 'all';

    renderTable();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showStatus('✨ Fresh start — all transactions cleared.', false, () => {
      budgetData = snapshot.rows;
      source = snapshot.source;
      if (source && source.handle) storeSourceHandle(source.handle);
      unsavedCount = 0;
      markChanged(snapshot.unsaved || 0);
      renderTable();
      showStatus('↩️ Transactions restored.');
    });
  });

  // Press Enter anywhere in the entry form to add the transaction
  // (and in the edit dialog to save it)
  [['#entryCard .entry-grid', addEntry], ['#editGrid', saveEdit]].forEach(([sel, fn]) => {
    document.querySelector(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !['SELECT', 'BUTTON'].includes(e.target.tagName) &&
          !e.target.closest('.category-picker-btn, .category-picker-panel')) {
        e.preventDefault();
        fn();
      }
    });
  });

  // Press Enter in Settings inputs to add the item
  const settingsEnterMap = [
    ['newPersonName', () => addSettingItem('people', 'newPersonName')],
    ['newBankName', () => addSettingItem('banks', 'newBankName')],
    ['budgetTarget', addBudgetSetting],
    ['budgetAmount', addBudgetSetting],
    ['newCategoryName', addCategorySetting],
    ['newCategoryKeywords', addCategorySetting]
  ];
  settingsEnterMap.forEach(([id, fn]) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); fn(); }
    });
  });

  // ---- Buttons and controls ----
  // Every button uses data-action instead of inline onclick, so the page's
  // Content-Security-Policy can block inline scripts entirely.
  const ACTIONS = {
    openReportsHub: () => openReportsHub(),
    openSettingsModal: () => openSettingsModal(),
    openCompareModal: () => openCompareModal(),
    toggleTheme: () => toggleTheme(),
    addSettingItem: el => addSettingItem(el.dataset.key, el.dataset.input),
    removeSettingItem: el => removeSettingItem(el.dataset.key, Number(el.dataset.index)),
    addBudgetSetting: () => addBudgetSetting(),
    removeBudgetByIndex: el => removeBudgetByIndex(Number(el.dataset.index)),
    addCategorySetting: () => addCategorySetting(),
    removeCategoryByIndex: el => removeCategoryByIndex(Number(el.dataset.index)),
    addRecurringSetting: () => addRecurringSetting(),
    removeRecurring: el => removeRecurring(Number(el.dataset.index)),
    resetAllLocalData: () => resetAllLocalData(),
    editRow: el => openEditor(Number(el.dataset.index)),
    removeRow: el => removeRow(Number(el.dataset.index))
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && Object.prototype.hasOwnProperty.call(ACTIONS, el.dataset.action)) {
      e.preventDefault();
      ACTIONS[el.dataset.action](el);
      return;
    }
    const typeOpt = e.target.closest('.type-opt');
    if (typeOpt) {
      setEntryType(typeOpt.closest('.type-toggle'), typeOpt.dataset.type);
      return;
    }
    const chip = e.target.closest('.date-chips .chip');
    if (chip) {
      e.preventDefault();
      const input = document.getElementById(chip.parentElement.dataset.target);
      input.value = dateOffsetStr(Number(chip.dataset.offset));
      syncDateChips();
    }
  });

  document.getElementById('currencySelect').addEventListener('change', (e) => setCurrencySetting(e.target.value));
  ['date', 'editDate'].forEach(id => document.getElementById(id).addEventListener('input', syncDateChips));
  document.getElementById('store').addEventListener('input', autofillFromStore);

  // Phone: the + button opens the add form as a bottom sheet
  document.getElementById('fab').addEventListener('click', openEntrySheet);
  document.getElementById('entryClose').addEventListener('click', closeEntrySheet);
  document.getElementById('sheetBackdrop').addEventListener('click', closeEntrySheet);

  // Edit dialog
  document.getElementById('editSave').addEventListener('click', saveEdit);
  document.getElementById('editCancel').addEventListener('click', closeEditor);
  document.getElementById('editDuplicate').addEventListener('click', duplicateFromEditor);
  document.getElementById('editDelete').addEventListener('click', () => {
    const i = editIndex;
    closeEditor();
    removeRow(i);
  });
  const closeEditBtn = document.getElementById('closeEdit');
  closeEditBtn.addEventListener('click', closeEditor);
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') closeEditor();
  });

  // Table rows: click or Enter opens the editor; checkboxes select
  const tbodyEl = document.querySelector('#budgetTable tbody');
  tbodyEl.addEventListener('click', (e) => {
    if (e.target.closest('button, input, a')) return;
    const tr = e.target.closest('tr.txn-row');
    if (tr) openEditor(Number(tr.dataset.index));
  });
  tbodyEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr.txn-row')) {
      e.preventDefault();
      openEditor(Number(e.target.dataset.index));
    }
  });
  tbodyEl.addEventListener('change', (e) => {
    if (!e.target.matches('.row-check')) return;
    const row = budgetData[Number(e.target.dataset.index)];
    if (!row) return;
    if (e.target.checked) selectedRows.add(row);
    else selectedRows.delete(row);
    e.target.closest('tr').classList.toggle('selected', e.target.checked);
    updateBulkBar();
  });
  document.getElementById('selectAll').addEventListener('change', (e) => {
    getFilteredData().forEach(r => (e.target.checked ? selectedRows.add(r) : selectedRows.delete(r)));
    renderTable();
  });
  document.getElementById('bulkApply').addEventListener('click', bulkSetCategory);
  document.getElementById('bulkDelete').addEventListener('click', bulkDelete);
  document.getElementById('bulkClear').addEventListener('click', () => {
    selectedRows.clear();
    renderTable();
  });

  // Draft restore bar
  document.getElementById('draftRestore').addEventListener('click', restoreDraft);
  document.getElementById('draftDiscard').addEventListener('click', discardDraft);

  // Last line of defence if storage is unavailable: warn before leaving with unsaved work
  window.addEventListener('beforeunload', (e) => {
    if (unsavedCount > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---- Keyboard & screen-reader support for every dialog ----
  // When a dialog opens, focus moves into it and Tab stays inside; when it
  // closes, focus returns to whatever opened it.
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
  const openModal = () => [...document.querySelectorAll('.modal')].find(m => m.style.display === 'flex');
  const focusReturn = new Map();
  new MutationObserver(records => {
    records.forEach(({ target: modal }) => {
      const open = modal.style.display === 'flex';
      if (open && !focusReturn.has(modal)) {
        focusReturn.set(modal, document.activeElement);
        if (!modal.contains(document.activeElement)) {
          setTimeout(() => {
            if (modal.contains(document.activeElement)) return;
            const first = [...modal.querySelectorAll(FOCUSABLE)].find(el => el.offsetParent !== null);
            if (first) first.focus();
          }, 60);
        }
      } else if (!open && focusReturn.has(modal)) {
        const back = focusReturn.get(modal);
        focusReturn.delete(modal);
        if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
      }
    });
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const modal = openModal();
      if (!modal) return;
      const items = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // Close buttons drawn as icons work with Enter/Space too
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.close[role="button"]')) {
      e.preventDefault();
      e.target.click();
      return;
    }
    // Arrow keys move between Expense and Income
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && e.target.matches && e.target.matches('.type-opt')) {
      e.preventDefault();
      const toggle = e.target.closest('.type-toggle');
      const next = e.target.dataset.type === 'D' ? 'C' : 'D';
      setEntryType(toggle, next);
      toggle.querySelector(`.type-opt[data-type="${next}"]`).focus();
    }
  });

  // Only the selected Expense/Income option is in the Tab order (radio-group behaviour)
  const syncTypeTabIndex = () => document.querySelectorAll('.type-opt').forEach(b => {
    b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
  });
  new MutationObserver(syncTypeTabIndex).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
  syncTypeTabIndex();

  // Mirror tooltips as accessible names for icon-only buttons
  document.querySelectorAll('.action-btn[data-tooltip]').forEach(btn => {
    if (!btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', btn.dataset.tooltip);
  });

  applyLastUsed();
  updateUnsavedBadge();
  syncDateChips();
  checkForDraft();
  renderTable();

  // Offline support: the service worker serves the app's own files from cache
  // only when the network is unavailable (it never caches your transactions).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
