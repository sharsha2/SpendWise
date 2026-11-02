  let budgetData = [];
  let editIndex = -1;              // row open in the edit dialog
  const selectedRows = new Set();  // rows ticked for bulk actions
  let unsavedCount = 0;            // changes since the last open/save
  let sampleMode = false;          // sample data on screen: never saved as a draft
  const SAMPLE_SAVE_MESSAGE = "ℹ️ This is sample data, so it can't be saved. Upload your own Excel file or bank PDF to save.";
  // The file the data came from: { name, months, handle, workbook }.
  // Saving writes its months back into it; other months get their own files.
  let source = null;

  // Currency display: a generic dollar sign by default, with INR as an option.
  // Display only — amounts are never converted between currencies
  const CURRENCIES = {
    dollar: { symbol: '$', locale: undefined },
    usd: { symbol: 'US$', locale: 'en-US' },
    eur: { symbol: '€', locale: 'en-IE' },
    gbp: { symbol: '£', locale: 'en-GB' },
    aud: { symbol: 'A$', locale: 'en-AU' },
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

  function seriesColors(theme, count) {
    return Array.from({ length: count }, (_, i) => theme.palette[i] || theme.other);
  }

  function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
    if (typeof aliasCache !== 'undefined') aliasCache = null; // merged names live in settings too
  }

  // Categories whose meaning the totals depend on can be renamed but not hidden
  const LOCKED_GROUPS = new Set(['Income', TRANSFER_GROUP]);

  function defaultCategoryGroups() {
    return {
      'Income': {
        'Income': ['payroll', 'salary', 'deposit', 'income', 'interest', 'intrest', 'cashback', 'rebate',
          // money back from the government is income, not a refund of spending
          'tax refund', 'tax return', 'cra refund', 'gst credit', 'hst credit', 'gst/hst', 'climate action', 'carbon rebate',
          'child benefit', 'ccb', 'canada fed', 'ei payment', 'cerb']
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
  }

  // Built-in categories with your edits applied (renamed, new keywords, hidden),
  // plus your custom categories
  function getCategoryGroups() {
    if (categoryCache && categoryCache.groups) return categoryCache.groups;
    const settings = getSettings();
    const edits = settings.categoryEdits || {};
    const renames = {};   // any earlier name → current name
    const originals = {}; // current name → built-in name (keeps icons and colours)
    const groups = {};
    for (const [group, subs] of Object.entries(defaultCategoryGroups())) {
      const out = {};
      for (const [name, keywords] of Object.entries(subs)) {
        const e = edits[name];
        if (e && e.hidden && !LOCKED_GROUPS.has(group)) continue;
        const shown = e && e.name ? e.name : name;
        if (shown !== name) {
          originals[shown] = name;
          renames[name] = shown;
          (e.formerNames || []).forEach(n => { if (n !== shown) renames[n] = shown; });
        }
        out[shown] = e && Array.isArray(e.keywords) && e.keywords.length ? e.keywords : keywords;
      }
      groups[group] = out;
    }
    const custom = settings.categories || {};
    if (Object.keys(custom).length) groups['Custom'] = custom;
    categoryCache = { groups, map: null, groupOf: new Map(), storeCat: new Map(), renames, originals };
    return groups;
  }

  // A category name from a file or an older version → what it's called now
  function canonicalCategory(name) {
    getCategoryGroups();
    return categoryCache.renames[name] || name;
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
      aliases: {},    // { "home rent": "House rent" }
      notSame: [],    // ["home rent|house rent"] — pairs not to suggest again
      goals: [],      // [{ id, name, target, saved, by: 'YYYY-MM' }]
      categoryEdits: {}, // { "SPA": { name: "Personal care", keywords: [...], hidden: false, formerNames: [] } }
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
      currency: CURRENCIES[stored.currency] ? stored.currency : defaultSettings.currency,
      // Merged names: { nameKey of a variant: 'Name to show' } and pairs you said differ
      aliases: isPlainObject(stored.aliases)
        ? Object.fromEntries(Object.entries(stored.aliases).filter(([k, v]) => isSafeKey(k) && typeof v === 'string'))
        : {},
      notSame: Array.isArray(stored.notSame) ? stored.notSame.filter(x => typeof x === 'string') : [],
      categoryEdits: isPlainObject(stored.categoryEdits)
        ? Object.fromEntries(Object.entries(stored.categoryEdits).filter(([k, v]) => isSafeKey(k) && isPlainObject(v)))
        : {},
      goals: Array.isArray(stored.goals)
        ? stored.goals.filter(g => isPlainObject(g) && typeof g.name === 'string' && isFinite(Number(g.target)))
        : []
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

  // ---- Built-in categories: rename, change keywords, hide ----
  let editingCategory = null; // built-in name being edited inline

  function shownNameOf(original) {
    const e = getSettings().categoryEdits[original];
    return e && e.name ? e.name : original;
  }

  function allCategoryNames() {
    return Object.values(getCategoryGroups()).flatMap(subs => Object.keys(subs));
  }

  function renderBuiltinCategories() {
    const edits = getSettings().categoryEdits;
    const host = document.getElementById('builtinCats');
    host.innerHTML = Object.entries(defaultCategoryGroups()).map(([group, subs]) =>
      `<div class="cat-edit-group"><div class="cat-edit-group-name">${escapeHtml(group)}</div>` +
      Object.entries(subs).map(([orig, defaults]) => {
        const e = edits[orig] || {};
        const shown = e.name || orig;
        const keywords = Array.isArray(e.keywords) && e.keywords.length ? e.keywords : defaults;
        const locked = LOCKED_GROUPS.has(group);
        const changed = !!(e.name || (e.keywords && e.keywords.length) || e.hidden);
        const id = escapeHtml(orig);
        if (editingCategory === orig) {
          return `<div class="cat-edit-row editing" data-cat="${id}">
            <input type="text" class="cat-edit-name" value="${escapeHtml(shown)}" maxlength="40" aria-label="Category name">
            <input type="text" class="cat-edit-keywords" value="${escapeHtml(keywords.join(', '))}" aria-label="Keywords, comma separated">
            <span class="cat-edit-actions">
              <button type="button" class="pill-btn primary" data-action="saveCategoryEdit" data-cat="${id}">Save</button>
              <button type="button" class="pill-btn ghost" data-action="cancelCategoryEdit">Cancel</button>
            </span></div>`;
        }
        return `<div class="cat-edit-row${e.hidden ? ' is-hidden' : ''}" data-cat="${id}">
          <div class="cat-edit-text">${getCategoryBadge(shown)}${shown !== orig ? `<span class="cat-was">was ${id}</span>` : ''}${e.hidden ? '<span class="cat-was">hidden</span>' : ''}
            <span class="cat-keywords">${escapeHtml(keywords.join(', '))}</span></div>
          <span class="cat-edit-actions">
            <button type="button" class="pill-btn ghost" data-action="startCategoryEdit" data-cat="${id}"><i class="fas fa-pen"></i> Edit</button>
            ${locked ? '<span class="cat-lock" title=""><i class="fas fa-lock" aria-hidden="true"></i> Needed for totals</span>'
              : `<button type="button" class="pill-btn ghost" data-action="toggleCategoryHidden" data-cat="${id}">${e.hidden ? '<i class="fas fa-eye"></i> Show' : '<i class="fas fa-eye-slash"></i> Hide'}</button>`}
            ${changed ? `<button type="button" class="pill-btn ghost" data-action="resetCategoryEdit" data-cat="${id}">Reset</button>` : ''}
          </span></div>`;
      }).join('') + '</div>').join('');
  }

  // Renaming updates the rows on screen, budgets and remembered stores, so the
  // next save uses the new name everywhere
  function applyCategoryRename(oldName, newName) {
    if (oldName === newName) return 0;
    let changed = 0;
    budgetData.forEach(r => { if (r['Category'] === oldName) { r['Category'] = newName; changed++; } });
    const settings = getSettings();
    if (Object.prototype.hasOwnProperty.call(settings.budgets, oldName)) {
      settings.budgets[newName] = settings.budgets[oldName];
      delete settings.budgets[oldName];
      saveSettings(settings);
    }
    const mem = loadStoreMemory();
    let memChanged = false;
    Object.values(mem).forEach(m => { if (m.category === oldName) { m.category = newName; memChanged = true; } });
    if (memChanged) { try { localStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch (e) { /* ignore */ } }
    if (changed) markChanged(changed);
    return changed;
  }

  function saveCategoryEdit(orig) {
    const row = document.querySelector(`#builtinCats .cat-edit-row[data-cat="${CSS.escape(orig)}"]`);
    if (!row) return;
    const name = row.querySelector('.cat-edit-name').value.replace(/\s+/g, ' ').trim();
    const keywords = row.querySelector('.cat-edit-keywords').value.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const before = shownNameOf(orig);
    if (!name || !isSafeKey(name)) { showStatus('⚠️ Give the category a name.', true); return; }
    if (name !== before && allCategoryNames().some(n => n.toLowerCase() === name.toLowerCase())) {
      showStatus(`⚠️ There's already a category called “${name}”.`, true);
      return;
    }
    if (!keywords.length) { showStatus('⚠️ Keep at least one keyword so matching stores are found.', true); return; }
    const settings = getSettings();
    const defaults = defaultCategoryGroups();
    const defaultKeywords = Object.values(defaults).map(subs => subs[orig]).find(Boolean) || [];
    const e = settings.categoryEdits[orig] || {};
    e.name = name !== orig ? name : undefined;
    e.keywords = keywords.join('|') === defaultKeywords.join('|') ? undefined : keywords;
    if (before !== name) e.formerNames = [...new Set([...(e.formerNames || []), before].filter(n => n !== name))];
    settings.categoryEdits[orig] = JSON.parse(JSON.stringify(e)); // drops undefined fields
    if (!Object.keys(settings.categoryEdits[orig]).length) delete settings.categoryEdits[orig];
    saveSettings(settings);
    const moved = applyCategoryRename(before, name);
    editingCategory = null;
    afterCategoriesChanged(before !== name
      ? `🏷️ “${before}” is now “${name}”${moved ? ` (${moved} transaction${moved === 1 ? '' : 's'} updated)` : ''}`
      : `🏷️ Keywords for “${name}” saved`);
  }

  function toggleCategoryHidden(orig) {
    const settings = getSettings();
    const e = settings.categoryEdits[orig] || {};
    e.hidden = !e.hidden;
    if (!e.hidden) delete e.hidden;
    settings.categoryEdits[orig] = e;
    if (!Object.keys(e).length) delete settings.categoryEdits[orig];
    saveSettings(settings);
    afterCategoriesChanged(e.hidden ? `🙈 “${shownNameOf(orig)}” hidden — its stores now match other categories` : `👁️ “${shownNameOf(orig)}” shown again`);
  }

  function resetCategoryEdit(orig) {
    const before = shownNameOf(orig);
    const settings = getSettings();
    const formerNames = (settings.categoryEdits[orig] && settings.categoryEdits[orig].formerNames) || [];
    delete settings.categoryEdits[orig];
    // Keep mapping names you used before, so older files still find the category
    if (before !== orig || formerNames.length) {
      settings.categoryEdits[orig] = { formerNames: [...new Set([...formerNames, before].filter(n => n !== orig))] };
    }
    saveSettings(settings);
    applyCategoryRename(before, orig);
    afterCategoriesChanged(`↩️ “${orig}” is back to its default`);
  }

  function afterCategoriesChanged(message) {
    populateCategoryDropdown();
    populateSettingsUI();
    renderTable();
    showStatus(message);
  }

  let detectedRecurring = [];

  function addDetectedRecurring(index) {
    const r = detectedRecurring[index];
    if (!r) return;
    const settings = getSettings();
    settings.recurring.push({
      desc: r.desc, amount: r.amount, day: r.day,
      payer: settings.people.includes(r.payer) ? r.payer : (settings.people[0] || ''),
      bank: settings.banks.includes(r.bank) ? r.bank : (settings.banks[0] || ''),
      type: r.type
    });
    saveSettings(settings);
    populateSettingsUI();
    showStatus(`🔁 ${r.desc} added to recurring.`);
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

    // Recurring suggestions found in the current transactions
    detectedRecurring = detectRecurring(budgetData, settings.recurring);
    const detectedBox = document.getElementById('recurringDetected');
    detectedBox.hidden = !detectedRecurring.length;
    document.getElementById('recurringDetectedList').innerHTML = detectedRecurring.map((r, i) =>
      `<div class="settings-line"><div><strong>${escapeHtml(r.desc)}</strong>` +
      `<span>${r.type === 'C' ? 'Income' : 'Expense'} ${fmtMoney(r.amount)} · around day ${r.day} · seen in ${r.months} months</span></div>` +
      `<button type="button" class="pill-btn ghost" data-action="addDetectedRecurring" data-index="${i}"><i class="fas fa-plus"></i> Add</button></div>`).join('');

    renderBuiltinCategories();

    // Savings goals
    document.getElementById('goalsSettingsList').innerHTML = settings.goals.map(g =>
      line(escapeHtml(g.name), `${fmtMoney(g.saved)} of ${fmtMoney(g.target)}${g.by ? ' · by ' + escapeHtml(monthLabelOf(g.by, { month: 'short', year: 'numeric' })) : ''}`,
        `goal ${g.name}`, `data-action="removeGoal" data-id="${escapeHtml(g.id)}"`)).join('') ||
      empty('No goals yet.');

    // Merged names
    const aliasList = document.getElementById('aliasList');
    aliasList.innerHTML = Object.entries(settings.aliases).map(([k, v]) =>
      line(escapeHtml(k), `shown as “${escapeHtml(v)}”`, `merge ${k}`, `data-action="removeAlias" data-key="${escapeHtml(k)}"`)).join('') ||
      empty('Nothing merged yet. Year summary suggests names that look alike.');

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
      forgetStores();
      invalidateCategoryCache();
      populateSettingsUI();
      updateDropdowns();
      populateCategoryDropdown();
      renderTable();
      showStatus('✅ All settings reset to defaults.');
    }
  }

  // Removes everything Moneta stores in this browser: settings, remembered
  // stores, unsaved draft, linked file, theme and the offline cache.
  async function clearDeviceData() {
    const warn = unsavedCount ? `\n\n⚠️ ${unsavedCount} unsaved change${unsavedCount === 1 ? ' is' : 's are'} not saved to Excel yet and will be lost.` : '';
    if (!confirm(`Remove all Moneta data from this browser?\n\nSettings, remembered stores, the unsaved draft and the offline copy are deleted. Your Excel files are not touched.${warn}`)) return;
    try {
      Object.keys(localStorage).filter(k => k.startsWith('spendwise_')).forEach(k => localStorage.removeItem(k));
    } catch (e) { /* storage unavailable */ }
    try { indexedDB.deleteDatabase('moneta'); } catch (e) { /* ignore */ }
    try {
      if ('caches' in window) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
      if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
    } catch (e) { /* ignore */ }
    unsavedCount = 0; // nothing left to protect, so leave without the warning
    location.reload();
  }

  // ---- Motion helpers ----
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Runs a DOM change as a View Transition where the browser supports it
  function withViewTransition(update, className) {
    if (!document.startViewTransition || prefersReducedMotion()) { update(); return; }
    if (className) document.documentElement.classList.add(className);
    const t = document.startViewTransition(update);
    t.finished.finally(() => { if (className) document.documentElement.classList.remove(className); });
  }

  // A number glides to its new value — only when the value really changed
  function setAnimatedNumber(el, value, format) {
    const from = typeof el._value === 'number' ? el._value : null;
    el._value = value;
    if (from === null || from === value || prefersReducedMotion() || document.hidden) {
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    const duration = 560;
    cancelAnimationFrame(el._raf);
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = format(from + (value - from) * eased);
      if (t < 1) el._raf = requestAnimationFrame(step);
      else el.textContent = format(value);
    };
    el._raf = requestAnimationFrame(step);
  }

  // New data arrived: the dashboard settles in, tiles first then panels
  function revealDashboard() {
    if (prefersReducedMotion()) return;
    const section = document.getElementById('overviewSection');
    [...section.querySelectorAll('.kpi'), ...section.querySelectorAll('.dash-panel:not([hidden])')]
      .forEach((el, i) => el.style.setProperty('--i', String(i)));
    section.classList.remove('revealing');
    void section.offsetWidth; // restart the animation
    section.classList.add('revealing');
    clearTimeout(section._revealTimer);
    section._revealTimer = setTimeout(() => section.classList.remove('revealing'), 1400);
  }

  function toggleTheme(origin) {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    // The new theme spreads out from the button that was pressed
    if (origin && origin.getBoundingClientRect) {
      const r = origin.getBoundingClientRect();
      document.documentElement.style.setProperty('--vt-x', `${r.left + r.width / 2}px`);
      document.documentElement.style.setProperty('--vt-y', `${r.top + r.height / 2}px`);
    }
    withViewTransition(() => {
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('spendwise_theme', newTheme);
      updateThemeUI(newTheme);
      renderDashboard();
    }, 'theme-transition');
  }

  function updateThemeUI(theme) {
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');
    const topIcon = document.getElementById('themeIconTop');
    const topBtn = document.getElementById('themeToggleTop');
    topIcon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    topBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    if (theme === 'dark') {
      themeIcon.className = 'fas fa-sun';
      themeText.textContent = 'Light mode';
      Chart.defaults.color = '#CBD5E1';
      Chart.defaults.borderColor = '#2C3A52';
    } else {
      themeIcon.className = 'fas fa-moon';
      themeText.textContent = 'Dark mode';
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
    categoryFilter = '';
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
  uploadFile.addEventListener('change', uploadExcel);
  // Small drop-down menus (Upload ▾ and Save ▾)
  function setupMenu(buttonId, menuId, onOpen) {
    const btn = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
    const close = (focusButton) => {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (focusButton) btn.focus();
    };
    const open = () => {
      document.querySelectorAll('.pop-menu').forEach(m => { if (m !== menu) m.hidden = true; });
      if (onOpen) onOpen();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      items()[0].focus();
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) open(); else close(false);
    });
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[role="menuitem"]')) close(false);
    });
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) close(false); });
  }

  setupMenu('downloadBtn', 'saveMenu', () => {
    // Sample data: both options stay visible but explain why they're unavailable
    document.getElementById('saveMenu').classList.toggle('is-sample', sampleMode);
    ['saveExcelItem', 'savePdfItem'].forEach(id => document.getElementById(id).setAttribute('aria-disabled', String(sampleMode)));
    document.getElementById('saveSampleHint').hidden = !sampleMode;
    const month = reportMonth();
    document.getElementById('savePdfHint').textContent = month
      ? `Summary of ${monthLabelOf(month, { month: 'long', year: 'numeric' })} to keep or share`
      : 'Add transactions first';
  });
  document.getElementById('uploadBtn').addEventListener('click', chooseUploadFiles);
  document.getElementById('uploadAny').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])]; // copy before clearing the input
    e.target.value = '';
    if (files.length) routeUploads(files);
  });
  document.getElementById('saveExcelItem').addEventListener('click', downloadExcel);
  document.getElementById('savePdfItem').addEventListener('click', downloadMonthPdf);
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
    el.addEventListener('input', () => { datePreset.value = 'custom'; syncFilterUI(); }));

  // Filters panel: date chips drive the preset; the button shows how many are on
  const filterPanel = document.getElementById('filterPanel');
  const filtersToggle = document.getElementById('filtersToggle');
  function setFilterPanel(open) {
    filterPanel.hidden = !open;
    filtersToggle.setAttribute('aria-expanded', String(open));
  }
  filtersToggle.addEventListener('click', () => setFilterPanel(filterPanel.hidden));
  filterPanel.querySelectorAll('[data-preset]').forEach(chip => chip.addEventListener('click', () => {
    datePreset.value = chip.dataset.preset;
    if (chip.dataset.preset === 'custom') { syncFilterUI(); filterStartDate.focus(); return; }
    datePreset.dispatchEvent(new Event('change'));
  }));

  function activeFilterCount() {
    return (filterStartDate.value || filterEndDate.value ? 1 : 0) +
      (filterMinAmount.value !== '' || filterMaxAmount.value !== '' ? 1 : 0);
  }

  function syncFilterUI() {
    const n = activeFilterCount();
    const badge = document.getElementById('filterCount');
    badge.hidden = n === 0;
    badge.textContent = String(n);
    filtersToggle.classList.toggle('has-filters', n > 0);
    filterPanel.querySelectorAll('[data-preset]').forEach(chip =>
      chip.classList.toggle('active', chip.dataset.preset === datePreset.value));
    // A filter set from the dashboard opens the panel so it can be seen and changed
    if (n > 0 && filterPanel.hidden && syncFilterUI.autoOpen) setFilterPanel(true);
  }

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
    // Show first: a chart drawn inside a hidden pop-up gets the wrong size
    modal.style.display = 'flex';
    updateFn();
  }

  showIncomeExpense.addEventListener('click', () => openChart(updateIncomeExpenseChart, incomeExpenseModal));
  showSpendingCategory.addEventListener('click', () => openChart(updateSpendingCategoryChart, spendingCategoryModal));
  showMonthlyOverview.addEventListener('click', () => openChart(updateMonthlyOverviewChart, monthlyOverviewModal));
  showCreditCardSpending.addEventListener('click', () => openChart(updateCreditCardSpendingChart, creditCardSpendingModal));
  showPurchasedByTrend.addEventListener('click', () => openChart(updatePurchasedByTrendChart, purchasedByTrendModal));

  // ---- Year summary ----
  const MONTH_SHORT = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('default', { month: 'short' }));

  // The year report can use the on-screen transactions or a set of monthly
  // files loaded just for the report (they never replace your list)
  let yearRows = null;
  let yearFileNames = [];
  const yearData = () => yearRows || budgetData;

  function yearsIn(rows) {
    return [...new Set(rows.map(monthKeyOf).filter(Boolean).map(k => k.slice(0, 4)))].sort().reverse();
  }

  function fillYearSelect(preferred) {
    const years = yearsIn(yearData());
    const sel = document.getElementById('yearSelect');
    const pick = years.includes(preferred) ? preferred : years.includes(sel.value) ? sel.value : years[0];
    sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (pick) sel.value = pick;
    sel.disabled = !years.length;
    ['yearExport', 'yearPdf'].forEach(id => { document.getElementById(id).disabled = !years.length; });
  }

  function updateYearSource(extra = '') {
    const title = document.getElementById('yearSourceTitle');
    const detail = document.getElementById('yearSourceDetail');
    document.getElementById('yearUseScreen').hidden = !yearRows;
    if (yearRows) {
      title.textContent = `${yearFileNames.length} file${yearFileNames.length === 1 ? '' : 's'} loaded · ${yearRows.length} transactions`;
      detail.textContent = extra || 'Only this report uses them — your transaction list is unchanged.';
    } else {
      title.textContent = budgetData.length ? `Using the ${budgetData.length} transactions on screen` : 'No transactions on screen';
      detail.textContent = 'Load your monthly Excel files (all 12 if you have them) to build the full year.';
    }
  }

  function openYearSummary() {
    fillYearSelect();
    updateYearSource();
    renderYearSummary();
    reportsHubModal.style.display = 'none';
    document.getElementById('yearModal').style.display = 'flex';
  }

  // Rows from one file of either kind: Excel (every transaction sheet) or PDF
  // (bank statement or Moneta report)
  async function rowsFromFile(file) {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      if (typeof window.readStatementRows !== 'function') throw new Error('PDF reader not loaded');
      return window.readStatementRows(file);
    }
    if (typeof XLSX === 'undefined') throw new Error('Excel library not loaded');
    if (file.size > 20 * 1024 * 1024) throw new Error('larger than 20 MB');
    return readWorkbookRows(XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })).rows;
  }

  // Several files at once. A transaction already seen in an earlier file (an
  // Excel file and a PDF of the same month, overlapping exports) counts once.
  async function rowsFromFiles(files) {
    const rows = [];
    const seenBefore = new Set();
    const problems = [];
    const used = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const fileRows = await rowsFromFile(file);
        const keysHere = new Set();
        fileRows.forEach(r => {
          const k = dupKey(r);
          if (seenBefore.has(k)) { skipped++; return; }
          keysHere.add(k);
          rows.push(r);
        });
        keysHere.forEach(k => seenBefore.add(k));
        used.push(file.name);
      } catch (e) {
        problems.push(`${file.name} (${e.message})`);
      }
    }
    return { rows, skipped, problems, used };
  }

  // Reads every chosen file; a transaction already seen in an earlier file
  // (e.g. two overlapping exports) is counted once
  async function loadYearFiles(fileList) {
    const files = [...fileList].sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) return;
    showStatus(`📂 Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    const { rows, skipped, problems, used } = await rowsFromFiles(files);
    if (!rows.length) {
      showStatus(`❌ No transactions found${problems.length ? ': ' + problems.join(', ') : ''}`, true);
      return;
    }
    yearRows = markExcessRefunds(rows);
    yearFileNames = used;
    // Default to the year most of the rows belong to
    const counts = {};
    rows.forEach(r => { const k = monthKeyOf(r); if (k) counts[k.slice(0, 4)] = (counts[k.slice(0, 4)] || 0) + 1; });
    const busiest = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    fillYearSelect(busiest);
    const notes = [];
    if (skipped) notes.push(`${skipped} duplicate${skipped === 1 ? '' : 's'} across files counted once`);
    if (problems.length) notes.push(`couldn't read ${problems.join(', ')}`);
    updateYearSource(notes.length ? notes.join(' · ') : '');
    renderYearSummary();
  }

  function renderYearSummary() {
    const year = document.getElementById('yearSelect').value;
    const months = document.getElementById('yearMonths');
    if (!year) {
      months.innerHTML = '';
      document.getElementById('yearTable').innerHTML = '<tbody><tr><td class="muted">No dated transactions yet — load your monthly files above.</td></tr></tbody>';
      return;
    }
    const y = yearSummary(yearData(), year);
    renderNameSuggestions(yearData().filter(r => (monthKeyOf(r) || '').startsWith(year + '-')), 'yearNames');
    // Which months have data (missing months stand out before you export)
    const present = new Set(yearData().map(monthKeyOf).filter(k => k && k.startsWith(year + '-')).map(k => Number(k.slice(5)) - 1));
    months.innerHTML = MONTH_SHORT.map((m, i) =>
      `<span class="month-chip ${present.has(i) ? 'has' : 'missing'}" title="">${present.has(i) ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${m}</span>`).join('') +
      `<span class="month-count">${present.size} of 12 months</span>`;
    const cell = c => (c ? fmtMoney(c / 100) : '<span class="muted">–</span>');
    const row = (label, months, cls = '') =>
      `<tr class="${cls}"><th scope="row">${label}</th>${months.map(c => `<td class="right">${cell(c)}</td>`).join('')}` +
      `<td class="right total">${cell(months.reduce((a, b) => a + b, 0))}</td></tr>`;
    document.getElementById('yearTable').innerHTML =
      `<thead><tr><th>Category</th>${MONTH_SHORT.map(m => `<th class="right">${m}</th>`).join('')}<th class="right">Total</th></tr></thead><tbody>` +
      (y.categories.length ? y.categories.map(c => row(escapeHtml(c.name), c.months)).join('') : '<tr><td colspan="14" class="muted">No spending this year.</td></tr>') +
      `</tbody><tfoot>${row('Spent', y.spent, 'sum')}${row('Income', y.income, 'sum')}${row('Net', y.net, 'sum net')}</tfoot>`;
  }

  function exportYearSummary() {
    const year = document.getElementById('yearSelect').value;
    const y = yearSummary(yearData(), year);
    const toRow = (label, months) => {
      const out = { Category: label };
      MONTH_SHORT.forEach((m, i) => { out[m] = months[i] / 100; });
      out.Total = months.reduce((a, b) => a + b, 0) / 100;
      return out;
    };
    const rows = [...y.categories.map(c => toRow(c.name, c.months)), {}, toRow('Spent', y.spent), toRow('Income', y.income), toRow('Net', y.net)];
    const ws = XLSX.utils.json_to_sheet(rows, { header: ['Category', ...MONTH_SHORT, 'Total'] });
    ws['!cols'] = [{ wch: 24 }, ...MONTH_SHORT.map(() => ({ wch: 11 })), { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Summary ${year}`);
    XLSX.writeFile(wb, `Moneta-${year}-Summary.xlsx`);
    showStatus(`✅ Downloaded Moneta-${year}-Summary.xlsx`);
  }

  // ---- Annual PDF report (printed by the browser: choose "Save as PDF") ----
  const REPORT_INK = { text: '#1E293B', muted: '#64748B', grid: '#E2E8F0', income: '#047857', expense: '#DC2626', net: '#2a78d6' };

  // Renders a chart off-screen (always light colours) and returns it as an image
  function chartImage(config, width, height) {
    const canvas = document.createElement('canvas');
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = width;
    canvas.height = height;
    config.options = Object.assign({ responsive: false, animation: false, devicePixelRatio: 2 }, config.options);
    const chart = new Chart(canvas, config);
    const url = canvas.toDataURL('image/png');
    chart.destroy();
    return url;
  }

  function buildAnnualReport(year) {
    const rows = yearData().filter(r => (monthKeyOf(r) || '').startsWith(year + '-'));
    const y = yearSummary(rows, year);
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    const spentC = sum(y.spent);
    const incomeC = sum(y.income);
    const monthsWithData = y.spent.map((v, i) => (v || y.income[i] ? i : -1)).filter(i => i >= 0);
    const avgSpendC = monthsWithData.length ? Math.round(spentC / monthsWithData.length) : 0;
    const money = c => fmtMoney(c / 100);
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

    // Highlights
    const best = monthsWithData.slice().sort((a, b) => y.net[b] - y.net[a])[0];
    const priciest = monthsWithData.slice().sort((a, b) => y.spent[b] - y.spent[a])[0];
    let biggest = null;
    rows.forEach(r => { const c = spendOf(r); if (c > 0 && (!biggest || c > biggest.c)) biggest = { c, r }; });
    const stores = {};
    rows.forEach(r => {
      const c = spendOf(r);
      if (!c) return;
      const name = displayName(r['Purchased Store']) || '(no description)';
      const key = nameKey(name) || name.toLowerCase();
      stores[key] = stores[key] || { name, c: 0, n: 0 };
      stores[key].c += c;
      stores[key].n++;
    });
    const topStores = Object.values(stores).filter(s => s.c > 0).sort((a, b) => b.c - a.c).slice(0, 10);

    // Per person: spending by month and category, plus income
    const persons = {};
    const personOf = r => String(r['Purchased By'] || '').trim() || 'Unassigned';
    rows.forEach(r => {
      const c = classify(r);
      if (!c.spend && !c.income) return;
      const who = personOf(r);
      const p = persons[who] = persons[who] || { name: who, spent: 0, income: 0, months: new Array(12).fill(0), cats: {} };
      p.income += c.income;
      if (c.spend) {
        p.spent += c.spend;
        p.months[Number(monthKeyOf(r).slice(5, 7)) - 1] += c.spend;
        const cat = getCategory(r);
        p.cats[cat] = (p.cats[cat] || 0) + c.spend;
      }
    });
    const personList = Object.values(persons).sort((a, b) => b.spent - a.spent);
    const topCatsOf = p => Object.entries(p.cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([n, v]) => `${escapeHtml(n)} ${money(v)}`).join(' · ') || '—';

    // Where the money came from, and each month's top spending category
    const sources = {};
    rows.forEach(r => {
      const c = incomeOf(r);
      if (!c) return;
      const name = displayName(r['Purchased Store']) || 'Income';
      const key = nameKey(name) || name.toLowerCase();
      sources[key] = sources[key] || { name, c: 0, months: new Set() };
      sources[key].c += c;
      sources[key].months.add(monthKeyOf(r));
    });
    const incomeSources = Object.values(sources).filter(s => s.c > 0).sort((a, b) => b.c - a.c);
    const topCatOfMonth = MONTH_SHORT.map((_, i) => {
      const best = y.categories.filter(c => c.months[i] > 0).sort((a, b) => b.months[i] - a.months[i])[0];
      return best ? best.name : '';
    });

    const light = { palette: CHART_PALETTE.light, other: '#64748B' };
    const tick = { color: REPORT_INK.muted, font: { size: 11 } };
    const monthlyImg = chartImage({
      type: 'bar',
      data: {
        labels: MONTH_SHORT,
        datasets: [
          { label: 'Income', data: y.income.map(c => c / 100), backgroundColor: REPORT_INK.income, borderRadius: 3, maxBarThickness: 18 },
          { label: 'Spent', data: y.spent.map(c => c / 100), backgroundColor: REPORT_INK.expense, borderRadius: 3, maxBarThickness: 18 }
        ]
      },
      options: {
        plugins: { legend: { labels: { color: REPORT_INK.text, boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false }, ticks: tick },
          y: { beginAtZero: true, grid: { color: REPORT_INK.grid }, border: { display: false }, ticks: { ...tick, callback: v => fmtMoneyShort(v) } }
        }
      }
    }, 700, 240);

    const topCats = y.categories.slice(0, 8);
    const restC = sum(y.categories.slice(8).map(c => c.total));
    const catLabels = topCats.map(c => c.name).concat(restC ? [`Other (${y.categories.length - 8} more)`] : []);
    const catValues = topCats.map(c => c.total / 100).concat(restC ? [restC / 100] : []);
    const categoryImg = catValues.length ? chartImage({
      type: 'bar',
      data: { labels: catLabels, datasets: [{ data: catValues, backgroundColor: catLabels.map((_, i) => (restC && i === catLabels.length - 1) ? light.other : (light.palette[i] || light.other)), borderRadius: 3, maxBarThickness: 16 }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: REPORT_INK.grid }, border: { display: false }, ticks: { ...tick, callback: v => fmtMoneyShort(v) } },
          y: { grid: { display: false }, ticks: { ...tick, color: REPORT_INK.text } }
        }
      }
    }, 700, Math.max(140, catLabels.length * 26 + 30)) : '';

    const kpi = (label, value, cls = '') => `<div class="rp-kpi"><span>${label}</span><strong class="${cls}">${value}</strong></div>`;
    const cell = c => (c ? money(c) : '–');
    // 14-column grids use whole dollars so they fit an A4 page
    const whole = c => {
      const v = Math.round(c / 100);
      return (v < 0 ? '−' : '') + activeCurrency.symbol + new Intl.NumberFormat(activeCurrency.locale).format(Math.abs(v));
    };
    const cellW = c => (c ? whole(c) : '–');
    const sourceText = yearRows
      ? `${yearFileNames.length} file${yearFileNames.length === 1 ? '' : 's'}: ${yearFileNames.map(escapeHtml).join(', ')}`
      : 'Transactions on screen';
    const missing = MONTH_SHORT.filter((_, i) => !monthsWithData.includes(i));

    document.getElementById('printReport').innerHTML = `
      <div class="rp">
        <header class="rp-head">
          <div><div class="rp-brand">Moneta</div><h1>${escapeHtml(year)} Annual Report</h1></div>
          <div class="rp-meta">Generated ${escapeHtml(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}<br>${monthsWithData.length} of 12 months${missing.length && missing.length < 12 ? ` · missing ${escapeHtml(missing.join(', '))}` : ''}</div>
        </header>
        <p class="rp-source">Source: ${sourceText}</p>

        <section class="rp-kpis">
          ${kpi('Income', money(incomeC), 'inc')}
          ${kpi('Spent', money(spentC), 'exp')}
          ${kpi('Saved', money(incomeC - spentC), incomeC - spentC >= 0 ? 'inc' : 'exp')}
          ${kpi('Savings rate', incomeC ? `${Math.round(((incomeC - spentC) / incomeC) * 100)}%` : '—')}
          ${kpi('Avg. monthly spend', money(avgSpendC))}
        </section>

        <section class="rp-block">
          <h2>Income and spending by month</h2>
          <img src="${monthlyImg}" alt="Monthly income and spending, ${escapeHtml(year)}">
        </section>

        <section class="rp-block">
          <h2>Month by month</h2>
          <table class="rp-table rp-months">
            <thead><tr><th>Month</th><th>Income</th><th>Spent</th><th>Saved</th><th>Savings rate</th><th>Top category</th></tr></thead>
            <tbody>${MONTH_SHORT.map((m, i) => monthsWithData.includes(i)
              ? `<tr><td>${new Date(Number(year), i, 1).toLocaleString('default', { month: 'long' })}</td><td class="inc">${money(y.income[i])}</td><td class="exp">${money(y.spent[i])}</td>` +
                `<td class="${y.net[i] >= 0 ? 'inc' : 'exp'}">${y.net[i] < 0 ? '−' : ''}${money(Math.abs(y.net[i]))}</td>` +
                `<td>${y.income[i] ? `${Math.round((y.net[i] / y.income[i]) * 100)}%` : '—'}</td><td>${escapeHtml(topCatOfMonth[i] || '—')}</td></tr>`
              : `<tr class="rp-missing"><td>${new Date(Number(year), i, 1).toLocaleString('default', { month: 'long' })}</td><td colspan="5">No data</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Year</td><td class="inc">${money(incomeC)}</td><td class="exp">${money(spentC)}</td>` +
              `<td class="${incomeC - spentC >= 0 ? 'inc' : 'exp'}">${incomeC - spentC < 0 ? '−' : ''}${money(Math.abs(incomeC - spentC))}</td>` +
              `<td>${incomeC ? `${Math.round(((incomeC - spentC) / incomeC) * 100)}%` : '—'}</td><td>${escapeHtml(y.categories[0] ? y.categories[0].name : '—')}</td></tr></tfoot>
          </table>
        </section>

        ${incomeSources.length ? `
        <section class="rp-block">
          <h2>Income sources</h2>
          <table class="rp-table">
            <thead><tr><th>Source</th><th>Total</th><th>Share</th><th>Months</th></tr></thead>
            <tbody>${incomeSources.map(s => `<tr><td>${escapeHtml(s.name)}</td><td class="inc">${money(s.c)}</td><td>${pct(s.c, incomeC)}</td><td>${s.months.size}</td></tr>`).join('')}</tbody>
          </table>
        </section>` : ''}

        <section class="rp-highlights">
          ${best !== undefined ? `<div><span>Best month</span><strong>${MONTH_SHORT[best]}</strong><em>saved ${money(y.net[best])}</em></div>` : ''}
          ${priciest !== undefined ? `<div><span>Highest spending</span><strong>${MONTH_SHORT[priciest]}</strong><em>${money(y.spent[priciest])}</em></div>` : ''}
          ${y.categories[0] ? `<div><span>Top category</span><strong>${escapeHtml(y.categories[0].name)}</strong><em>${pct(y.categories[0].total, spentC)} of spending</em></div>` : ''}
          ${biggest ? `<div><span>Largest purchase</span><strong>${escapeHtml(biggest.r['Purchased Store'] || '—')}</strong><em>${money(biggest.c)} · ${escapeHtml(shortDate(biggest.r['Date']))}</em></div>` : ''}
        </section>

        ${categoryImg ? `<section class="rp-block"><h2>Where the money went</h2><img src="${categoryImg}" alt="Spending by category"></section>` : ''}

        <section class="rp-block rp-two">
          <div>
            <h2>Categories</h2>
            <table class="rp-table">
              <thead><tr><th>Category</th><th>Total</th><th>Share</th><th>Per month</th></tr></thead>
              <tbody>${y.categories.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${money(c.total)}</td><td>${pct(c.total, spentC)}</td><td>${money(Math.round(c.total / Math.max(1, monthsWithData.length)))}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <div>
            <h2>Top stores</h2>
            <table class="rp-table">
              <thead><tr><th>Store</th><th>Total</th><th>Visits</th></tr></thead>
              <tbody>${topStores.map(s => `<tr><td>${escapeHtml(s.name)}</td><td>${money(s.c)}</td><td>${s.n}</td></tr>`).join('')}</tbody>
            </table>

          </div>
        </section>

        ${notesSummary(rows).length ? `
        <section class="rp-block">
          <h2>Notes &amp; tags</h2>
          <table class="rp-table">
            <thead><tr><th>Note / tag</th><th>Spent</th><th>Transactions</th></tr></thead>
            <tbody>${notesSummary(rows).map(t => `<tr><td>${escapeHtml(t.name)}</td><td>${money(t.c)}</td><td>${t.n}</td></tr>`).join('')}</tbody>
          </table>
        </section>` : ''}

        ${personList.length ? `
        <section class="rp-block rp-break">
          <h2>People</h2>
          <table class="rp-table">
            <thead><tr><th>Person</th><th>Spent</th><th>Share of spending</th><th>Avg. per month</th><th>Income</th><th>Top categories</th></tr></thead>
            <tbody>${personList.map(p => `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td class="exp">${money(p.spent)}</td><td>${pct(p.spent, spentC)}</td>` +
              `<td>${money(Math.round(p.spent / Math.max(1, monthsWithData.length)))}</td><td class="inc">${p.income ? money(p.income) : '–'}</td><td class="rp-wrap">${topCatsOf(p)}</td></tr>`).join('')}</tbody>
          </table>
        </section>
        <section class="rp-block">
          <h2>Spending by person and month</h2>
          <table class="rp-table rp-grid">
            <thead><tr><th>Person</th>${MONTH_SHORT.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody>${personList.map(p => `<tr><td>${escapeHtml(p.name)}</td>${p.months.map(v => `<td>${cellW(v)}</td>`).join('')}<td><strong>${whole(p.spent)}</strong></td></tr>`).join('')}</tbody>
          </table>
        </section>` : ''}

        <section class="rp-block${personList.length ? '' : ' rp-break'}">
          <h2>Category by month</h2>
          <table class="rp-table rp-grid">
            <thead><tr><th>Category</th>${MONTH_SHORT.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody>${y.categories.map(c => `<tr><td>${escapeHtml(c.name)}</td>${c.months.map(v => `<td>${cellW(v)}</td>`).join('')}<td><strong>${whole(c.total)}</strong></td></tr>`).join('')}</tbody>
            <tfoot>
              <tr><td>Spent</td>${y.spent.map(v => `<td>${cellW(v)}</td>`).join('')}<td>${whole(spentC)}</td></tr>
              <tr><td>Income</td>${y.income.map(v => `<td>${cellW(v)}</td>`).join('')}<td>${whole(incomeC)}</td></tr>
              <tr><td>Net</td>${y.net.map(v => `<td>${cellW(v)}</td>`).join('')}<td>${whole(incomeC - spentC)}</td></tr>
            </tfoot>
          </table>
          <p class="rp-note">Month grids are rounded to whole dollars; every other figure is exact to the cent. Refunds are subtracted from their category. Credit card payments, transfers between your accounts and investing are not counted as spending or income.</p>
        </section>
      </div>`;
  }

  // Opens the print dialog showing only #printReport ("Save as PDF" there)
  function printReport(title) {
    const previousTitle = document.title;
    document.title = title; // becomes the suggested PDF file name
    document.body.classList.add('print-report');
    const done = () => {
      document.body.classList.remove('print-report');
      document.title = previousTitle;
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    // Let the report images load before the print dialog opens
    setTimeout(() => window.print(), 150);
    showStatus('🖨️ In the print window choose "Save as PDF" as the destination.');
  }

  function downloadYearPdf() {
    const year = document.getElementById('yearSelect').value;
    if (!year) return;
    buildAnnualReport(year);
    printReport(`Moneta ${year} Annual Report`);
  }

  // Spending grouped by note/tag (e.g. "Banff trip"), biggest first
  function notesSummary(rows) {
    const tags = {};
    rows.forEach(r => {
      const note = String(r['Notes'] || '').trim();
      const c = spendOf(r);
      if (!note || !c) return;
      const key = nameKey(note) || note.toLowerCase();
      tags[key] = tags[key] || { name: note, c: 0, n: 0 };
      tags[key].c += c;
      tags[key].n++;
    });
    return Object.values(tags).filter(t => t.c > 0).sort((a, b) => b.c - a.c);
  }

  // ---- Monthly PDF report ----
  function buildMonthlyReport(month) {
    const rows = budgetData.filter(r => monthKeyOf(r) === month);
    const prevKey = shiftMonth(month, -1);
    const prevRows = budgetData.filter(r => monthKeyOf(r) === prevKey);
    const cur = periodTotals(rows);
    const prev = prevRows.length ? periodTotals(prevRows) : null;
    const money = v => fmtMoney(v);
    const moneyC = c => fmtMoney(c / 100);
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
    const monthName = monthLabelOf(month, { month: 'long', year: 'numeric' });
    const prevName = monthLabelOf(prevKey, { month: 'long' });
    const change = (now, before, goodUp) => {
      if (before === null || before === undefined || Math.abs(now - before) < 0.005) return '';
      const up = now > before;
      return `<em class="${up === goodUp ? 'inc' : 'exp'}">${up ? '▲' : '▼'} ${money(Math.abs(now - before))} vs ${escapeHtml(prevName)}</em>`;
    };

    // Category totals now and last month
    const catNow = {};
    const catPrev = {};
    rows.forEach(r => { const c = spendOf(r); if (c) catNow[getCategory(r)] = (catNow[getCategory(r)] || 0) + c; });
    prevRows.forEach(r => { const c = spendOf(r); if (c) catPrev[getCategory(r)] = (catPrev[getCategory(r)] || 0) + c; });
    const cats = Object.entries(catNow).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const spentC = Math.round(cur.spent * 100);

    // Daily spending chart (light colours, whatever the app theme)
    const [yy, mm] = month.split('-').map(Number);
    const days = new Date(yy, mm, 0).getDate();
    const perDay = new Array(days).fill(0);
    rows.forEach(r => { const d = dayOf(r); if (d >= 1 && d <= days) perDay[d - 1] += spendOf(r); });
    const tick = { color: REPORT_INK.muted, font: { size: 10 } };
    const dailyImg = chartImage({
      type: 'bar',
      data: { labels: perDay.map((_, i) => i + 1), datasets: [{ data: perDay.map(c => Math.max(0, c) / 100), backgroundColor: REPORT_INK.expense, borderRadius: 2, maxBarThickness: 14 }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { ...tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } },
          y: { beginAtZero: true, grid: { color: REPORT_INK.grid }, border: { display: false }, ticks: { ...tick, callback: v => fmtMoneyShort(v) } }
        }
      }
    }, 700, 200);
    const topCats = cats.slice(0, 8);
    const catImg = topCats.length ? chartImage({
      type: 'bar',
      data: { labels: topCats.map(([n]) => n), datasets: [{ data: topCats.map(([, v]) => v / 100), backgroundColor: topCats.map((_, i) => CHART_PALETTE.light[i] || '#64748B'), borderRadius: 3, maxBarThickness: 16 }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: REPORT_INK.grid }, border: { display: false }, ticks: { ...tick, callback: v => fmtMoneyShort(v) } },
          y: { grid: { display: false }, ticks: { ...tick, color: REPORT_INK.text } }
        }
      }
    }, 700, topCats.length * 26 + 30) : '';

    // People, stores, income, notes, budgets
    const people = {};
    rows.forEach(r => {
      const c = classify(r);
      if (!c.spend && !c.income) return;
      const who = String(r['Purchased By'] || '').trim() || 'Unassigned';
      people[who] = people[who] || { spent: 0, income: 0 };
      people[who].spent += c.spend;
      people[who].income += c.income;
    });
    const personRows = Object.entries(people).sort((a, b) => b[1].spent - a[1].spent);
    const paid = Object.fromEntries(personRows.filter(([n, p]) => n !== 'Unassigned' && p.spent).map(([n, p]) => [n, p.spent]));
    const transfers = settleUp(paid);
    const stores = {};
    const sources = {};
    rows.forEach(r => {
      const name = displayName(r['Purchased Store']) || '(no description)';
      const key = nameKey(name) || name.toLowerCase();
      const c = classify(r);
      if (c.spend) { stores[key] = stores[key] || { name, c: 0, n: 0 }; stores[key].c += c.spend; stores[key].n++; }
      if (c.income) { sources[key] = sources[key] || { name, c: 0 }; sources[key].c += c.income; }
    });
    const topStores = Object.values(stores).filter(x => x.c > 0).sort((a, b) => b.c - a.c).slice(0, 8);
    const incomeSources = Object.values(sources).filter(x => x.c > 0).sort((a, b) => b.c - a.c);
    const tags = notesSummary(rows);
    const settings = getSettings();
    const budgets = Object.entries(settings.budgets).map(([target, limit]) => {
      const usedC = rows.reduce((c, r) => {
        const cat = getCategory(r);
        const hit = cat === target || getCategoryGroup(cat) === target || (r['Purchased Store'] || '').toLowerCase().includes(target.toLowerCase());
        return hit ? c + spendOf(r) : c;
      }, 0);
      return { target, usedC, limitC: toCents(limit) };
    });

    const kpi = (label, value, cls, extra = '') => `<div class="rp-kpi"><span>${label}</span><strong class="${cls || ''}">${value}</strong>${extra}</div>`;
    const sorted = rows.slice().sort((a, b) => String(a['Date']).localeCompare(String(b['Date'])));
    const sourceText = source ? `Transactions on screen (opened from ${escapeHtml(source.name)})` : 'Transactions on screen';

    document.getElementById('printReport').innerHTML = `
      <div class="rp">
        <header class="rp-head">
          <div><div class="rp-brand">Moneta</div><h1>${escapeHtml(monthName)} Report</h1></div>
          <div class="rp-meta">Generated ${escapeHtml(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}<br>${rows.length} transactions</div>
        </header>
        <p class="rp-source">Source: ${sourceText}</p>

        <section class="rp-kpis">
          ${kpi('Income', money(cur.income), 'inc', change(cur.income, prev && prev.income, true))}
          ${kpi('Spent', money(cur.spent), 'exp', change(cur.spent, prev && prev.spent, false))}
          ${kpi('Saved', money(cur.net), cur.net >= 0 ? 'inc' : 'exp', change(cur.net, prev && prev.net, true))}
          ${kpi('Savings rate', cur.rate === null ? '—' : `${Math.round(cur.rate)}%`)}
          ${kpi('Avg. per day', money(cur.spent / days))}
        </section>

        <section class="rp-block"><h2>Spending by day</h2><img src="${dailyImg}" alt="Spending each day of ${escapeHtml(monthName)}"></section>
        ${catImg ? `<section class="rp-block"><h2>Where the money went</h2><img src="${catImg}" alt="Spending by category"></section>` : ''}

        <section class="rp-block rp-two">
          <div>
            <h2>Categories</h2>
            <table class="rp-table">
              <thead><tr><th>Category</th><th>Spent</th><th>Share</th><th>vs ${escapeHtml(prevName)}</th></tr></thead>
              <tbody>${cats.map(([n, v]) => {
                const before = catPrev[n] || 0;
                const diff = v - before;
                const cmp = !prev ? '—' : !before ? 'new' : `${diff > 0 ? '▲' : diff < 0 ? '▼' : ''} ${moneyC(Math.abs(diff))}`;
                return `<tr><td>${escapeHtml(n)}</td><td>${moneyC(v)}</td><td>${pct(v, spentC)}</td><td class="${diff > 0 ? 'exp' : 'inc'}">${cmp}</td></tr>`;
              }).join('') || '<tr><td colspan="4">No spending</td></tr>'}</tbody>
            </table>
            ${budgets.length ? `
            <h2>Budgets</h2>
            <table class="rp-table">
              <thead><tr><th>Budget</th><th>Spent</th><th>Limit</th><th>Status</th></tr></thead>
              <tbody>${budgets.map(b => `<tr><td>${escapeHtml(b.target)}</td><td>${moneyC(b.usedC)}</td><td>${moneyC(b.limitC)}</td>` +
                `<td class="${b.usedC > b.limitC ? 'exp' : 'inc'}">${b.usedC > b.limitC ? `Over by ${moneyC(b.usedC - b.limitC)}` : `${moneyC(b.limitC - b.usedC)} left`}</td></tr>`).join('')}</tbody>
            </table>` : ''}
          </div>
          <div>
            <h2>Top stores</h2>
            <table class="rp-table">
              <thead><tr><th>Store</th><th>Spent</th><th>Visits</th></tr></thead>
              <tbody>${topStores.map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${moneyC(x.c)}</td><td>${x.n}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody>
            </table>
            ${incomeSources.length ? `
            <h2>Income</h2>
            <table class="rp-table">
              <thead><tr><th>Source</th><th>Amount</th></tr></thead>
              <tbody>${incomeSources.map(x => `<tr><td>${escapeHtml(x.name)}</td><td class="inc">${moneyC(x.c)}</td></tr>`).join('')}</tbody>
            </table>` : ''}
          </div>
        </section>

        ${personRows.length ? `
        <section class="rp-block">
          <h2>People</h2>
          <table class="rp-table">
            <thead><tr><th>Person</th><th>Spent</th><th>Share of spending</th><th>Income</th></tr></thead>
            <tbody>${personRows.map(([n, p]) => `<tr><td><strong>${escapeHtml(n)}</strong></td><td class="exp">${moneyC(p.spent)}</td><td>${pct(p.spent, spentC)}</td><td class="inc">${p.income ? moneyC(p.income) : '–'}</td></tr>`).join('')}</tbody>
          </table>
          ${transfers.length ? `<p class="rp-note">To share spending equally: ${transfers.map(t => `${escapeHtml(t.from)} pays ${escapeHtml(t.to)} ${moneyC(t.cents)}`).join('; ')}.</p>` : ''}
        </section>` : ''}

        ${tags.length ? `
        <section class="rp-block">
          <h2>Notes &amp; tags</h2>
          <table class="rp-table">
            <thead><tr><th>Note / tag</th><th>Spent</th><th>Transactions</th></tr></thead>
            <tbody>${tags.map(t => `<tr><td>${escapeHtml(t.name)}</td><td>${moneyC(t.c)}</td><td>${t.n}</td></tr>`).join('')}</tbody>
          </table>
        </section>` : ''}

        <section class="rp-block rp-break">
          <h2>All transactions</h2>
          <table class="rp-table rp-list">
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Person</th><th>Bank</th><th>Note</th><th>Amount</th></tr></thead>
            <tbody>${sorted.map(r => {
              const c = classify(r);
              const net = toCents(r['Credit [C]']) - toCents(r['Debit [D]']);
              const cls = c.kind === 'transfer' ? '' : net > 0 ? 'inc' : 'exp';
              return `<tr><td>${escapeHtml(shortDate(r['Date']))}</td><td>${escapeHtml(r['Purchased Store'] || '—')}${c.kind === 'transfer' ? ' <span class="rp-tag">transfer</span>' : c.kind === 'refund' ? ' <span class="rp-tag">refund</span>' : ''}</td>` +
                `<td>${escapeHtml(getCategory(r))}</td><td>${escapeHtml(r['Purchased By'] || '')}</td><td>${escapeHtml(r['Bank Name'] || '')}</td><td>${escapeHtml(r['Notes'] || '')}</td>` +
                `<td class="${cls}">${net > 0 ? '+' : net < 0 ? '−' : ''}${moneyC(Math.abs(net))}</td></tr>`;
            }).join('')}</tbody>
          </table>
          <p class="rp-note">Refunds are subtracted from their category. Credit card payments, transfers between your accounts and investing are listed but not counted as spending or income.</p>
        </section>
      </div>`;
  }

  // The month shown in the overview (or the newest month when "All time" is selected)
  function reportMonth() {
    return dashActive !== 'all' ? dashActive : (dataMonths()[0] || null);
  }

  function downloadMonthPdf() {
    if (sampleMode) { showStatus(SAMPLE_SAVE_MESSAGE); return; }
    const month = reportMonth();
    if (!month) {
      showStatus('⚠️ Add or open transactions first — the report needs a month with data.', true);
      return;
    }
    buildMonthlyReport(month);
    printReport(`Moneta ${monthLabelOf(month, { month: 'long', year: 'numeric' })} Report`);
  }

  document.getElementById('showYearSummary').addEventListener('click', openYearSummary);
  document.getElementById('yearPdf').addEventListener('click', downloadYearPdf);
  document.getElementById('yearFilesInput').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    loadYearFiles(files);
  });
  document.getElementById('yearUseScreen').addEventListener('click', () => {
    yearRows = null;
    yearFileNames = [];
    fillYearSelect();
    updateYearSource();
    renderYearSummary();
  });
  document.getElementById('yearSelect').addEventListener('change', renderYearSummary);
  document.getElementById('yearExport').addEventListener('click', exportYearSummary);
  document.getElementById('closeYear').addEventListener('click', () => { document.getElementById('yearModal').style.display = 'none'; });
  document.getElementById('yearModal').addEventListener('click', (e) => {
    if (e.target.id === 'yearModal') e.target.style.display = 'none';
  });
  
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
    const note = document.getElementById(f.notes).value.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (note) entry['Notes'] = note;
    return entry;
  }

  const ADD_FORM = {
    date: 'date', amount: 'amount', type: 'type', person: 'purchasedBy', store: 'store',
    bank: 'bank', category: 'category', notes: 'notes', dateError: 'dateError', amountError: 'amountError'
  };
  const EDIT_FORM = {
    date: 'editDate', amount: 'editAmount', type: 'editType', person: 'editPerson', store: 'editStore',
    bank: 'editBank', category: 'editCategory', notes: 'editNotes', dateError: 'editDateError', amountError: 'editAmountError'
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
    rememberStores([entry]);
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
    document.getElementById('notes').value = '';
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
    document.getElementById('entryCard').classList.remove('collapsed');
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

  // ---- Merged names (reports group "Home rent" with "House rent", etc.) ----
  // Your data is never rewritten; this only changes how names are grouped and shown.
  let aliasCache = null;
  function displayName(name) {
    const clean = String(name || '').trim();
    if (!aliasCache) aliasCache = getSettings().aliases;
    return aliasCache[nameKey(clean)] || clean;
  }

  const groupKeyOf = name => nameKey(displayName(name));

  // Distinct names in rows after merging, most used first
  function distinctNames(rows) {
    const map = new Map();
    rows.forEach(r => {
      const raw = String(r['Purchased Store'] || '').trim();
      if (!raw) return;
      const key = groupKeyOf(raw);
      if (!key) return;
      const cur = map.get(key) || { key, name: displayName(raw), count: 0 };
      cur.count++;
      map.set(key, cur);
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  function mergeNames(fromName, toName) {
    const settings = getSettings();
    const toKey = nameKey(toName);
    settings.aliases[nameKey(fromName)] = toName;
    // Anything already merged into the old name follows it
    Object.keys(settings.aliases).forEach(k => {
      if (nameKey(settings.aliases[k]) === nameKey(fromName)) settings.aliases[k] = toName;
    });
    delete settings.aliases[toKey]; // the kept name shows as itself
    saveSettings(settings);
    afterNamesChanged(`🔗 "${fromName}" now counts as "${toName}"`);
  }

  function markNotSame(id) {
    const settings = getSettings();
    if (!settings.notSame.includes(id)) settings.notSame.push(id);
    saveSettings(settings);
    afterNamesChanged('👍 Kept separate');
  }

  function removeAlias(key) {
    const settings = getSettings();
    delete settings.aliases[key];
    saveSettings(settings);
    afterNamesChanged('↩️ Names unmerged');
  }

  function afterNamesChanged(message) {
    renderTable();
    if (document.getElementById('yearModal').style.display === 'flex') renderYearSummary();
    if (document.getElementById('settingsModal').style.display === 'flex') populateSettingsUI();
    showStatus(message);
  }

  // Suggestions panel (used in Year summary)
  let nameSuggestions = [];
  function renderNameSuggestions(rows, hostId) {
    const host = document.getElementById(hostId);
    const settings = getSettings();
    nameSuggestions = findSimilarNames(distinctNames(rows), new Set(settings.notSame));
    host.hidden = !nameSuggestions.length;
    if (!nameSuggestions.length) return;
    host.innerHTML = `<div class="names-title"><i class="fas fa-link" aria-hidden="true"></i> These look like the same thing — merge them?</div>` +
      nameSuggestions.map((p, i) =>
        `<div class="names-row"><span class="names-pair"><strong>${escapeHtml(p.a.name)}</strong> <em>(${p.a.count})</em> · <strong>${escapeHtml(p.b.name)}</strong> <em>(${p.b.count})</em></span>` +
        `<span class="names-actions">` +
        `<button type="button" class="pill-btn ghost" data-action="mergeSuggestion" data-index="${i}" data-keep="a">Use “${escapeHtml(p.a.name)}”</button>` +
        `<button type="button" class="pill-btn ghost" data-action="mergeSuggestion" data-index="${i}" data-keep="b">Use “${escapeHtml(p.b.name)}”</button>` +
        `<button type="button" class="pill-btn ghost" data-action="notSameSuggestion" data-index="${i}">Not the same</button>` +
        `</span></div>`).join('');
  }

  // Quick category chips: your most-used categories, one tap each
  const QUICK_DEFAULTS = ['Groceries', 'Dining', 'Gas', 'Shopping', 'Bills', 'Rent'];
  function renderQuickCats() {
    const host = document.getElementById('quickCats');
    if (!host) return;
    const counts = {};
    budgetData.forEach(r => {
      if (classify(r).kind !== 'expense') return;
      const c = getCategory(r);
      if (c && c !== 'Other') counts[c] = (counts[c] || 0) + 1;
    });
    const valid = new Set(allCategoryNames());
    const picks = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    QUICK_DEFAULTS.map(canonicalCategory).forEach(c => { if (!picks.includes(c)) picks.push(c); });
    const shown = picks.filter(c => valid.has(c)).slice(0, 6);
    const current = document.getElementById('category').value;
    host.innerHTML = shown.map(c =>
      `<button type="button" class="chip quick-cat${c === current ? ' active' : ''}" data-cat="${escapeHtml(c)}" aria-pressed="${c === current}">${escapeHtml(c)}</button>`).join('') +
      '<button type="button" class="chip quick-more" id="quickMore">More…</button>';
  }

  // Notes you've used before, newest first, offered while typing a note
  function refreshNoteSuggestions() {
    const seen = new Set();
    const notes = [];
    for (let i = budgetData.length - 1; i >= 0 && notes.length < 50; i--) {
      const n = budgetData[i]['Notes'];
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); notes.push(n); }
    }
    document.getElementById('noteSuggestions').innerHTML = notes.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  // Tag the selected rows with one note (empty removes notes)
  function bulkSetNote() {
    const note = document.getElementById('bulkNote').value.replace(/\s+/g, ' ').trim().slice(0, 200);
    const rows = [...selectedRows];
    if (!rows.length) return;
    const before = rows.map(r => r['Notes']);
    rows.forEach(r => { if (note) r['Notes'] = note; else delete r['Notes']; });
    markChanged(rows.length);
    document.getElementById('bulkNote').value = '';
    renderTable();
    showStatus(note ? `🏷️ Tagged ${rows.length} with “${note}”` : `🏷️ Removed notes from ${rows.length}`, false, () => {
      rows.forEach((r, i) => { if (before[i] === undefined) delete r['Notes']; else r['Notes'] = before[i]; });
      markChanged();
      renderTable();
      showStatus('↩️ Notes restored.');
    });
  }

  // ---- Store memory & autocomplete ----
  // Every store you use is remembered on this device (never uploaded) with what
  // you picked last time, so typing a few letters can complete it and fill the rest.
  const STORE_KEY = 'spendwise_stores';
  const STORE_LIMIT = 800;
  let storeMemory = null;

  function loadStoreMemory() {
    if (storeMemory) return storeMemory;
    storeMemory = {};
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.entries(raw).forEach(([k, v]) => {
          if (isSafeKey(k) && v && typeof v.name === 'string') storeMemory[k] = v;
        });
      }
    } catch (e) { /* corrupted — start fresh */ }
    return storeMemory;
  }

  // Learns from rows (added, edited, opened or imported). Later rows win.
  function rememberStores(rows) {
    const mem = loadStoreMemory();
    let changed = false;
    rows.forEach(r => {
      const name = String(r['Purchased Store'] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const key = name.toLowerCase();
      if (!name || !isSafeKey(key)) return;
      const prev = mem[key];
      mem[key] = {
        name,
        count: (prev ? prev.count : 0) + 1,
        used: Date.now(),
        person: r['Purchased By'] || '',
        bank: r['Bank Name'] || '',
        category: r['Category'] || (prev ? prev.category : '') || '',
        type: toCents(r['Credit [C]']) > toCents(r['Debit [D]']) ? 'C' : 'D'
      };
      changed = true;
    });
    if (!changed) return;
    const keys = Object.keys(mem);
    if (keys.length > STORE_LIMIT) {
      keys.sort((a, b) => (mem[a].used || 0) - (mem[b].used || 0))
        .slice(0, keys.length - STORE_LIMIT).forEach(k => delete mem[k]);
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch (e) { /* storage full */ }
  }

  function learnedCategory(store) {
    const key = String(store || '').trim().toLowerCase();
    if (!key) return '';
    const m = loadStoreMemory()[key];
    if (!m || !m.category) return '';
    const cat = canonicalCategory(m.category);
    return getCategoryGroup(cat) ? cat : '';
  }

  function forgetLearnedCategory(rows) {
    const mem = loadStoreMemory();
    rows.forEach(r => {
      const m = mem[String(r['Purchased Store'] || '').trim().toLowerCase()];
      if (m) m.category = '';
    });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(mem)); } catch (e) { /* storage full */ }
  }

  function forgetStores() {
    storeMemory = {};
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  // Common store names offered before you've used them yourself
  const COMMON_STORES = [
    'Costco', 'Walmart', 'No Frills', 'FreshCo', 'Food Basics', 'Sobeys', 'Loblaws', 'Real Canadian Superstore',
    'Metro', 'Farm Boy', 'T&T Supermarket', 'Shoppers Drug Mart', 'Rexall', 'Dollarama', 'Winners', 'Canadian Tire',
    'Home Depot', 'IKEA', 'Best Buy', 'Amazon', 'Apple', 'Tim Hortons', 'Starbucks', "McDonald's", 'KFC', "Wendy's",
    'Popeyes', 'Taco Bell', 'Chipotle', 'Subway', 'A&W', 'Pizza Pizza', "Domino's", 'Uber Eats', 'DoorDash',
    'SkipTheDishes', 'Uber', 'Lyft', 'Presto', 'GO Transit', 'VIA Rail', 'Air Canada', 'WestJet', 'Airbnb',
    'Shell', 'Esso', 'Petro-Canada', 'Pioneer', 'Rogers', 'Bell', 'Telus', 'Fido', 'Koodo', 'Freedom Mobile',
    'Virgin Plus', 'Hydro One', 'Enbridge', 'Toronto Hydro', 'Netflix', 'Spotify', 'Disney+', 'Crave',
    'YouTube Premium', 'iCloud', 'Google One', 'Amazon Prime', 'GoodLife Fitness', 'PetSmart', 'Wealthsimple',
    'Questrade', 'Remitly', 'Wise', 'Udemy', 'Coursera', 'Cineplex', 'Payroll', 'Rent'
  ];

  // Suggestions for the add form: your stores first, then common ones
  function storeSuggestionsFor(query) {
    const mem = loadStoreMemory();
    const entries = Object.values(mem).map(v => ({ name: v.name, count: v.count || 1, used: v.used || 0, mine: true }));
    const seen = new Set(entries.map(e => e.name.toLowerCase()));
    budgetData.forEach(r => {
      const name = String(r['Purchased Store'] || '').trim();
      if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); entries.push({ name, count: 1, used: 0, mine: true }); }
    });
    if (query.trim().length >= 2) {
      COMMON_STORES.forEach(name => {
        if (!seen.has(name.toLowerCase())) entries.push({ name, count: 0, used: 0, mine: false });
      });
    }
    return rankStoreSuggestions(query, entries, 6);
  }

  // What we last used at a store: the newest row in the table, else memory
  function lastUseOf(storeName) {
    const key = storeName.trim().toLowerCase();
    if (!key) return null;
    for (let i = budgetData.length - 1; i >= 0; i--) {
      const r = budgetData[i];
      if (String(r['Purchased Store'] || '').trim().toLowerCase() === key) {
        return {
          person: r['Purchased By'], bank: r['Bank Name'], category: r['Category'] || '',
          type: toCents(r['Credit [C]']) > toCents(r['Debit [D]']) ? 'C' : 'D'
        };
      }
    }
    const m = loadStoreMemory()[key];
    return m ? { person: m.person, bank: m.bank, category: m.category, type: m.type } : null;
  }

  // Picking a store you've used before fills person, bank, type and category
  function autofillFromStore() {
    const hint = document.getElementById('storeHint');
    const last = lastUseOf(document.getElementById('store').value);
    if (!last) { hint.textContent = ''; return; }
    const setIfOption = (id, value) => {
      const sel = document.getElementById(id);
      if (value && [...sel.options].some(o => o.value === value)) sel.value = value;
    };
    setIfOption('purchasedBy', last.person);
    setIfOption('bank', last.bank);
    setEntryType(document.querySelector('#entryCard .type-toggle'), last.type === 'C' ? 'C' : 'D');
    const catSel = document.getElementById('category');
    catSel.value = last.category && [...catSel.options].some(o => o.value === last.category) ? last.category : '';
    updateCategoryHint();
    hint.textContent = '✓ filled from last time';
  }

  // Combobox: inline completion while typing + a list of matches.
  // ↑/↓ move, Enter/Tab accept, Esc closes. onAccept runs after a pick.
  function attachStoreAutocomplete(input, onAccept) {
    const list = document.createElement('ul');
    list.className = 'ac-list';
    list.id = input.id + 'Suggestions';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    input.insertAdjacentElement('afterend', list);
    input.parentElement.classList.add('ac-host');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'both');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);

    // Inline completion fights with phone keyboards' own suggestions
    const inline = !window.matchMedia('(pointer: coarse)').matches;
    let items = [];
    let active = -1;
    let typed = '';

    const close = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };

    const highlight = (name) => {
      const i = name.toLowerCase().indexOf(typed.toLowerCase());
      if (!typed || i < 0) return escapeHtml(name);
      return escapeHtml(name.slice(0, i)) + '<mark>' + escapeHtml(name.slice(i, i + typed.length)) + '</mark>' + escapeHtml(name.slice(i + typed.length));
    };

    const render = () => {
      if (!items.length) { close(); return; }
      list.innerHTML = items.map((it, i) =>
        `<li role="option" id="${list.id}-${i}" class="ac-item${i === active ? ' active' : ''}" aria-selected="${i === active}" data-i="${i}">` +
        `<span class="ac-name">${highlight(it.name)}</span>${it.mine ? '' : '<span class="ac-tag">suggested</span>'}</li>`).join('');
      // Open just below the input (the label also holds a title above it)
      list.style.top = `${input.offsetTop + input.offsetHeight + 4}px`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };

    const accept = (name) => {
      input.value = name;
      input.setSelectionRange(name.length, name.length);
      close();
      if (onAccept) onAccept(name);
    };

    input.addEventListener('input', (e) => {
      typed = input.value;
      if (!typed.trim()) { items = []; close(); if (onAccept) onAccept(''); return; }
      items = storeSuggestionsFor(typed);
      active = -1;
      // Complete inline only while adding letters at the end, never on delete
      const top = items[0];
      if (inline && top && !e.isComposing && e.inputType && e.inputType.startsWith('insert') &&
          input.selectionEnd === typed.length && top.name.toLowerCase().startsWith(typed.toLowerCase()) &&
          top.name.length > typed.length) {
        input.value = typed + top.name.slice(typed.length);
        input.setSelectionRange(typed.length, top.name.length);
        active = 0;
      }
      render();
      // An exact match fills the rest straight away
      if (lastUseOf(input.value) && input.selectionStart === input.selectionEnd && onAccept) onAccept(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (list.hidden) {
        if (e.key === 'ArrowDown' && input.value.trim()) {
          typed = input.value;
          items = storeSuggestionsFor(typed);
          active = items.length ? 0 : -1;
          render();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = e.key === 'ArrowDown' ? Math.min(active + 1, items.length - 1) : Math.max(active - 1, 0);
        input.value = items[active].name;
        render();
      } else if (e.key === 'Enter' || (e.key === 'Tab' && active >= 0 && !e.shiftKey)) {
        if (active >= 0 || input.selectionStart !== input.selectionEnd) {
          e.preventDefault();
          e.stopPropagation(); // first Enter picks the store; the next one adds
          accept(active >= 0 ? items[active].name : input.value);
        } else {
          close();
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (input.selectionStart !== input.selectionEnd) input.value = typed; // drop the inline part
        close();
      }
    });

    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('.ac-item');
      if (!li) return;
      e.preventDefault(); // keep focus in the input
      accept(items[Number(li.dataset.i)].name);
    });

    input.addEventListener('blur', () => setTimeout(close, 120));
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
    document.getElementById('splitCategory').innerHTML =
      '<option value="">Choose category…</option>' + sel.innerHTML.replace('<option value="">Auto-detect</option>', '');
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
    hint.textContent = (!manual && store) ? `→ ${getCategory({ 'Purchased Store': store })}` : '';
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

  // Manual category on the entry wins; then what you chose for this store
  // before (learned from your corrections); then keyword matching
  function getCategory(row) {
    return (row['Category'] && canonicalCategory(row['Category'])) || learnedCategory(row['Purchased Store']) || categorizeStore(row['Purchased Store'] || '');
  }

  const CATEGORY_ICONS = {
    'Income': 'sack-dollar', 'Rent': 'house', 'Home': 'couch', 'Phone & Internet': 'wifi', 'Utilities': 'bolt',
    'Subscriptions': 'repeat', 'Bills': 'file-invoice-dollar', 'Groceries': 'cart-shopping', 'Dining': 'utensils',
    'Gas': 'gas-pump', 'Transit': 'bus', 'Flight': 'plane', 'Travel': 'suitcase-rolling', 'Health': 'kit-medical',
    'Fitness': 'dumbbell', 'SPA': 'spa', 'Loans': 'landmark', 'Insurance': 'shield-heart', 'Taxes & Fees': 'receipt',
    'Software': 'laptop-code', 'Education': 'graduation-cap', 'India': 'paper-plane', 'Kids': 'baby', 'Pets': 'paw',
    'Gifts & Donations': 'gift', 'Movie': 'film', 'Electronics': 'tv', 'Shopping': 'bag-shopping',
    'Credit Card Payment': 'credit-card', 'Transfer': 'right-left', 'Investment': 'chart-line'
  };

  function getCategoryBadge(displayName) {
    getCategoryGroups();
    const category = categoryCache.originals[displayName] || displayName; // built-in identity
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
    const icon = `<i class="fas fa-${CATEGORY_ICONS[category] || 'tag'}" aria-hidden="true"></i>`;
    if (classMap[category]) {
      return `<span class="category-badge ${classMap[category]}">${icon}${escapeHtml(displayName)}</span>`;
    }
    // Custom categories get a stable auto-generated color from their name
    let hue = 0;
    for (const ch of category) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    return `<span class="category-badge" style="background-color: hsl(${hue} 70% 88%); color: hsl(${hue} 60% 28%);">${icon}${escapeHtml(displayName)}</span>`;
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

  let categoryFilter = ''; // set by clicking a category on the dashboard

  function getFilteredData() {
    const searchTerm = searchInput.value.trim().toLowerCase();
    // "85.20" or "$85" also finds that amount
    const amountMatch = searchTerm.match(/^\$?(\d+(?:\.\d{1,2})?)$/);
    const searchCents = amountMatch ? toCents(amountMatch[1]) : null;
    const start = filterStartDate.value;
    const end = filterEndDate.value;
    const minAmount = parseFloat(filterMinAmount.value) || 0;
    const maxAmount = parseFloat(filterMaxAmount.value) || Infinity;

    return budgetData.filter(row => {
      const matchesSearch = (
        (row['Purchased By'] || '').toLowerCase().includes(searchTerm) ||
        (row['Purchased Store'] || '').toLowerCase().includes(searchTerm) ||
        (row['Bank Name'] || '').toLowerCase().includes(searchTerm) ||
        getCategory(row).toLowerCase().includes(searchTerm) ||
        (row['Notes'] || '').toLowerCase().includes(searchTerm) ||
        (searchCents !== null && [row['Amount Total'], row['Debit [D]'], row['Credit [C]']].some(v => v !== '' && toCents(v) === searchCents))
      );
      const cat = categoryFilter ? getCategory(row) : '';
      const matchesCategory = !categoryFilter || cat === categoryFilter || getCategoryGroup(cat) === categoryFilter;

      const rowDate = row['Date'] || '';
      const matchesDate = (!start || rowDate >= start) && (!end || rowDate <= end);

      const rowAmount = Number(row['Amount Total']) || 0;
      const matchesAmount = rowAmount >= minAmount && rowAmount <= maxAmount;

      return matchesSearch && matchesDate && matchesAmount && matchesCategory;
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

  // Large files: draw the first rows and add more on request (totals always use every row)
  const TABLE_PAGE = 300;
  let tableLimit = TABLE_PAGE;
  let tableViewKey = '';

  function renderTable() {
    markExcessRefunds(budgetData);
    const table = document.getElementById('budgetTable');
    const tbody = table.querySelector('tbody');
    const tfoot = table.querySelector('tfoot');

    const filteredData = getFilteredData();
    const filtersActive = searchInput.value !== '' || filterStartDate.value || filterEndDate.value ||
      filterMinAmount.value !== '' || filterMaxAmount.value !== '' || !!categoryFilter;
    syncFilterUI();
    const chip = document.getElementById('categoryChip');
    chip.hidden = !categoryFilter;
    document.getElementById('categoryChipLabel').textContent = categoryFilter;

    document.getElementById('rowCount').textContent =
      filtersActive ? `(${filteredData.length} of ${budgetData.length})` : `(${budgetData.length})`;

    // Forget selections for rows that no longer exist
    const live = new Set(budgetData);
    [...selectedRows].forEach(r => { if (!live.has(r)) selectedRows.delete(r); });
    updateBulkBar(filteredData);
    refreshNoteSuggestions();
    renderQuickCats();

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

    // A new search, filter, sort or file starts again from the top
    const viewKey = [searchInput.value, filterStartDate.value, filterEndDate.value, filterMinAmount.value,
      filterMaxAmount.value, categoryFilter, currentSort.column, currentSort.direction, source && source.name].join('|');
    if (viewKey !== tableViewKey) { tableViewKey = viewKey; tableLimit = TABLE_PAGE; }

    let html = '';
    let lastDay = null;
    let spentC = 0;
    let incomeC = 0;
    let transferC = 0;
    rows.forEach(r => {
      const c = classify(r);
      spentC += c.spend;
      incomeC += c.income;
      transferC += Math.abs(c.transfer);
    });
    rows.slice(0, tableLimit).forEach(row => {
      const idx = indexOf.get(row);
      const day = row['Date'] || '';
      if (grouped && day !== lastDay) {
        lastDay = day;
        const total = dayTotals[day];
        html += `<tr class="day-row"><td colspan="7"><div class="day-head"><span>${escapeHtml(dayLabel(day))}</span>` +
          `<span class="day-total ${total > 0 ? 'is-income' : ''}">${fmtSigned(total)}</span></div></td></tr>`;
      }
      const c = classify(row);
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
        `<div class="txn-sub">${getCategoryBadge(getCategory(row))}${kindTag}` +
        (row['Notes'] ? `<button type="button" class="note-chip" data-note="${escapeHtml(row['Notes'])}" title=""><i class="fas fa-hashtag" aria-hidden="true"></i>${escapeHtml(row['Notes'])}</button>` : '') +
        `<span class="txn-meta">${escapeHtml(meta)}</span></div></td>` +
        `<td class="col-person">${escapeHtml(row['Purchased By'] || '')}</td>` +
        `<td class="col-bank">${escapeHtml(row['Bank Name'] || '')}</td>` +
        `<td class="right amount-cell ${amountClass}">${fmtSigned(net)}</td>` +
        `<td class="center col-actions">` +
        `<button type="button" class="icon-btn" data-action="editRow" data-index="${idx}" aria-label="Edit ${escapeHtml(store || 'transaction')}"><i class="fas fa-pen"></i></button>` +
        `<button type="button" class="icon-btn danger" data-action="removeRow" data-index="${idx}" aria-label="Delete ${escapeHtml(store || 'transaction')}"><i class="fas fa-trash"></i></button>` +
        `</td></tr>`;
    });
    const remaining = rows.length - Math.min(tableLimit, rows.length);
    if (remaining > 0) {
      html += `<tr class="more-row"><td colspan="7"><button type="button" class="pill-btn ghost" data-action="showMoreRows">` +
        `<i class="fas fa-angles-down" aria-hidden="true"></i> Show ${Math.min(TABLE_PAGE, remaining)} more <span>(${remaining.toLocaleString()} not shown)</span></button></td></tr>`;
    }
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
      const projectedC = isCurrent && elapsed >= FORECAST_MIN_DAYS ? forecastMonth(spentC, elapsed, daysInMonth) : null;
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
      item.dataset.target = target;
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.setAttribute('aria-label', `${target}: ${statusText}. Show transactions`);
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
    document.getElementById('editNotes').value = row['Notes'] || '';

    const cat = row['Category'] || '';
    const catSel = document.getElementById('editCategory');
    if (cat && ![...catSel.options].some(o => o.value === cat)) {
      catSel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`);
    }
    catSel.value = cat;
    document.getElementById('editCategoryLabel').textContent = cat || `Auto-detect (${getCategory({ 'Purchased Store': row['Purchased Store'] })})`;

    setFieldError('editAmountError', '');
    setFieldError('editDateError', '');
    toggleSplit(false);
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
    if (!entry['Category'] && before['Category']) forgetLearnedCategory([entry]);
    rememberStores([entry]);
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

  function toggleSplit(open) {
    document.getElementById('splitBox').hidden = !open;
    document.getElementById('editSplit').setAttribute('aria-expanded', String(open));
    document.getElementById('splitAmount').value = '';
    document.getElementById('splitCategory').value = '';
    setFieldError('splitError', '');
    if (open) setTimeout(() => document.getElementById('splitAmount').focus(), 30);
  }

  // Moves part of the amount into a new row with its own category
  // (e.g. $40 of a $160 Costco receipt to Home). Totals stay exactly the same.
  function splitFromEditor() {
    if (editIndex < 0) return;
    const entry = readEntryForm(EDIT_FORM);
    if (!entry) return;
    const totalC = toCents(entry['Amount Total']);
    const partC = toCents(document.getElementById('splitAmount').value);
    const category = document.getElementById('splitCategory').value;
    if (!(partC > 0 && partC < totalC)) {
      setFieldError('splitError', `Enter an amount between ${fmtMoney(0.01)} and ${fmtMoney((totalC - 1) / 100)}`);
      return;
    }
    if (!category) {
      setFieldError('splitError', 'Choose a category for the split part');
      return;
    }
    const isCredit = entry['Credit [C]'] !== '';
    const withAmount = (base, cents) => {
      const v = cents / 100;
      return { ...base, 'Debit [D]': isCredit ? '' : v, 'Credit [C]': isCredit ? v : '', 'Amount Total': v };
    };
    const kept = withAmount(entry, totalC - partC);
    const part = withAmount(entry, partC);
    part['Category'] = category;
    const at = editIndex;
    const before = budgetData[at];
    budgetData.splice(at, 1, kept, part);
    markChanged(2);
    closeEditor();
    renderTable();
    showStatus(`✂️ Split into ${fmtMoney(kept['Amount Total'])} + ${fmtMoney(part['Amount Total'])} ${category}`, false, () => {
      const i = budgetData.indexOf(kept);
      if (i > -1 && budgetData[i + 1] === part) budgetData.splice(i, 2, before);
      markChanged();
      renderTable();
      showStatus('↩️ Split undone.');
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
    if (value === '__auto') forgetLearnedCategory(rows);
    else rememberStores(rows);
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
    if (sampleMode) return; // sample data is never kept
    try {
      if (unsavedCount > 0 && budgetData.length) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          unsaved: unsavedCount,
          rows: budgetData,
          source: source ? { name: source.name, months: source.months, sheets: source.sheets || null } : null
        }));
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch (e) { /* storage full or unavailable — the leave-page warning still protects */ }
  }

  function updateUnsavedBadge() {
    const badge = document.getElementById('unsavedBadge');
    badge.hidden = unsavedCount === 0 || sampleMode;
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
    // Show the restore bar: the browser may put the old scroll position back
    // after loading, so scroll to the top once loading has finished
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const toTop = () => setTimeout(() => window.scrollTo({ top: 0 }), 0);
    if (document.readyState === 'complete') toTop();
    else window.addEventListener('load', toTop, { once: true });
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
        sheets: Array.isArray(draft.source.sheets)
          ? draft.source.sheets.filter(sh => sh && typeof sh.name === 'string' && Array.isArray(sh.months))
            .map(sh => ({ name: sh.name, months: sh.months.filter(m => /^\d{4}-\d{2}$/.test(m)) }))
          : null,
        handle: handle && handle.name === draft.source.name ? handle : null,
        workbook: null
      };
    }
    pendingDraft = null;
    document.getElementById('draftBanner').hidden = true;
    selectedRows.clear();
    dashPinned = null;
    unsavedCount = 0;
    leaveSampleMode();
    markChanged(Math.max(1, parseInt(draft.unsaved, 10) || 1));
    renderTable();
    revealDashboard();
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
  const EXPORT_COLUMNS = ['Date', 'Purchased By', 'Purchased Store', 'Bank Name', 'Category', 'Debit [D]', 'Credit [C]', 'Amount Total', 'Notes'];

  function buildSheet(rows) {
    const clean = rows.map(r => Object.fromEntries(EXPORT_COLUMNS.map(c => [c, r[c] ?? ''])));
    const ws = XLSX.utils.json_to_sheet(clean, { header: EXPORT_COLUMNS });
    const widths = EXPORT_COLUMNS.map(col => Math.max(col.length, ...clean.map(row => String(row[col]).length)));
    ws['!cols'] = widths.map(w => ({ wch: Math.min(40, Math.max(10, w + 2)) }));
    return ws;
  }

  // Puts the data into the named sheet (or the first one), keeping any other
  // sheets the user added
  function withDataSheet(workbook, ws, sheetName) {
    const wb = workbook || XLSX.utils.book_new();
    if (sheetName && wb.Sheets[sheetName]) wb.Sheets[sheetName] = ws;
    else if (!sheetName && wb.SheetNames.length) wb.Sheets[wb.SheetNames[0]] = ws;
    else XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Budget Data');
    return wb;
  }

  // The opened workbook with its data sheets rewritten. A workbook with a sheet
  // per month gets each month back on its own sheet (rows without a date, or
  // moved to a month no sheet had, go to the first data sheet).
  function sourceWorkbookWith(rows) {
    const wb = source.workbook || XLSX.utils.book_new();
    const sheets = source.sheets && source.sheets.length ? source.sheets : null;
    if (!sheets || sheets.length === 1) return withDataSheet(wb, buildSheet(rows), sheets ? sheets[0].name : null);
    const sheetOf = {};
    sheets.forEach(sh => sh.months.forEach(m => { if (!sheetOf[m]) sheetOf[m] = sh.name; }));
    const buckets = Object.fromEntries(sheets.map(sh => [sh.name, []]));
    rows.forEach(r => buckets[sheetOf[monthKeyOf(r)] || sheets[0].name].push(r));
    sheets.forEach(sh => withDataSheet(wb, buildSheet(buckets[sh.name]), sh.name));
    return wb;
  }

  function monthFileName(key) {
    if (!/^\d{4}-\d{2}$/.test(key)) return 'Expenses.xlsx';
    return `${monthLabelOf(key, { month: 'short' })}-${key.slice(0, 4)}-Expenses.xlsx`;
  }

  async function downloadExcel() {
    if (sampleMode) { showStatus(SAMPLE_SAVE_MESSAGE); return; }
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
        if (key === 'source') {
          if (source.handle && await saveToSourceFile(rows)) {
            done.push(`updated ${source.name}`);
            continue;
          }
          const name = source.name.replace(/\.[^.]*$/, '') + '.xlsx';
          XLSX.writeFile(sourceWorkbookWith(rows), name);
          done.push(`downloaded ${name}`);
        } else {
          const name = monthFileName(key);
          XLSX.writeFile(withDataSheet(null, buildSheet(rows)), name);
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
  async function saveToSourceFile(rows) {
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
    await writable.write(XLSX.write(sourceWorkbookWith(rows), { bookType: 'xlsx', type: 'array' }));
    await writable.close();
    return true;
  }

  const isPdfFile = f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

  // One Upload for everything: Excel files open into the list, bank PDFs go
  // to the statement review. `handles` (Chrome/Edge) let Save update the file.
  async function routeUploads(files, handles = []) {
    const pdfs = files.filter(isPdfFile);
    const excels = files.filter(f => !isPdfFile(f) && /\.xlsx?$/i.test(f.name));
    const other = files.length - pdfs.length - excels.length;
    if (other) showStatus(`⚠️ Skipped ${other} file${other === 1 ? '' : 's'} — Upload takes Excel (.xlsx) and bank statement PDFs.`, true);
    if (excels.length) {
      if (excels.length > 1) {
        showStatus('ℹ️ Opened the first Excel file only. For a whole year, use Reports → Year summary → Load monthly files.');
      }
      const file = excels[0];
      if (confirmReplaceUnsaved()) {
        const handle = handles[files.indexOf(file)] || null;
        // Only .xlsx can be written back; .xls files are saved as a new .xlsx
        const writable = handle && /\.xlsx$/i.test(file.name) ? handle : null;
        const ok = await importWorkbook(file, writable);
        if (ok) storeSourceHandle(writable);
      }
    }
    if (pdfs.length) importStatementFiles(pdfs);
  }

  async function chooseUploadFiles() {
    if (!(typeof window.showOpenFilePicker === 'function')) {
      document.getElementById('uploadAny').click();
      return;
    }
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'Excel or bank statement PDF',
          accept: {
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            'application/vnd.ms-excel': ['.xls'],
            'application/pdf': ['.pdf']
          }
        }]
      });
    } catch (e) {
      return; // picker cancelled
    }
    const files = await Promise.all(handles.map(h => h.getFile()));
    routeUploads(files, handles);
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
  // Reads an amount however it was typed: 1234.5, "1,234.50", "$1,234.50",
  // "(25.00)" or "25.00-" (negative), "CA$ 12". Returns '' for blanks.
  function parseAmount(v) {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let t = String(v).trim();
    if (!t) return '';
    const negative = /^\(.*\)$/.test(t) || /-$/.test(t) || /^[-−]/.test(t);
    t = t.replace(/[^0-9.]/g, '');
    const n = parseFloat(t);
    if (!isFinite(n)) return 0;
    return negative ? -n : n;
  }

  // A "Total" / "Balance" line someone added to their sheet is not a transaction.
  // Real purchases have a date, so only undated rows can be summary lines
  // (a store called "Total Wine" with a date is kept).
  function isSummaryRow(row) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(excelDateToStr(row['Date']))) return false;
    const label = [row['Purchased Store'], row['Purchased By'], row['Date']]
      .map(v => String(v ?? '').trim()).join(' ').trim().toLowerCase();
    if (/^((grand\s*)?totals?|sub-?totals?|(opening|closing|ending|starting)?\s*balance|net|sum)\b/.test(label)) return true;
    // No description and no person but amounts filled in: a formula row
    const noText = !String(row['Purchased Store'] ?? '').trim() && !String(row['Purchased By'] ?? '').trim();
    return noText && (parseAmount(row['Debit [D]']) !== '' || parseAmount(row['Credit [C]']) !== '');
  }

  function normalizeRow(row) {
    let debit = parseAmount(row['Debit [D]']);
    let credit = parseAmount(row['Credit [C]']);
    // A negative debit is money coming in (and vice versa)
    if (debit !== '' && debit < 0) { credit = (credit === '' ? 0 : credit) + -debit; debit = ''; }
    if (credit !== '' && credit < 0) { debit = (debit === '' ? 0 : debit) + -credit; credit = ''; }
    if (debit === 0 && credit !== '') debit = '';
    if (credit === 0 && debit !== '') credit = '';
    let amount = parseAmount(row['Amount Total']);
    if (amount === '' || !isFinite(amount) || amount < 0) amount = (Number(debit) || 0) + (Number(credit) || 0);

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
    // Optional note/tag (newer files only), e.g. "Banff trip"
    const note = String(row['Notes'] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (note) entry['Notes'] = note;
    return entry;
  }

  // Reads every sheet that holds transactions (a Date column plus Debit,
  // Credit or Amount Total); other sheets such as notes or summaries are left
  // alone. Falls back to the first sheet so very old files still open.
  function readWorkbookRows(wb) {
    const AMOUNT_COLS = ['Debit [D]', 'Credit [C]', 'Amount Total'];
    const sheets = [];
    let summaryRows = 0;
    const read = name => {
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[name]);
      summaryRows += raw.filter(isSummaryRow).length;
      return raw.filter(r => !isSummaryRow(r)).map(normalizeRow);
    };
    wb.SheetNames.forEach(name => {
      const ws = wb.Sheets[name];
      if (!ws) return;
      const header = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(h => String(h).trim());
      if (!header.includes('Date') || !AMOUNT_COLS.some(c => header.includes(c))) return;
      const rows = read(name);
      if (rows.length) sheets.push({ name, rows });
    });
    if (!sheets.length && wb.SheetNames.length) {
      const rows = read(wb.SheetNames[0]);
      if (rows.length) sheets.push({ name: wb.SheetNames[0], rows });
    }
    return { sheets, rows: sheets.flatMap(s => s.rows), summaryRows };
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
      const read = readWorkbookRows(workbook);
      const summaryRows = read.summaryRows;
      if (!read.rows.length) {
        showStatus('❌ No transactions found in the Excel file.', true);
        return false;
      }
      budgetData = read.rows;
      leaveSampleMode();
      rememberStores(budgetData);
      source = {
        name: file.name,
        months: [...new Set(budgetData.map(monthKeyOf).filter(Boolean))],
        // Which months came from which sheet, so Save puts them back there
        sheets: read.sheets.map(sh => ({ name: sh.name, months: [...new Set(sh.rows.map(monthKeyOf).filter(Boolean))] })),
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
      revealDashboard();
      const dups = countDuplicates(budgetData);
      showStatus(`✅ Opened ${budgetData.length} transaction${budgetData.length > 1 ? 's' : ''} from ${file.name}` +
        (read.sheets.length > 1 ? ` (${read.sheets.length} sheets)` : '') +
        (summaryRows ? ` · skipped ${summaryRows} total row${summaryRows === 1 ? '' : 's'}` : '') +
        (dups ? ` · ⚠️ ${dups} look${dups === 1 ? 's' : ''} like duplicate${dups === 1 ? '' : 's'}` : ''));
      return true;
    } catch (error) {
      showStatus('❌ Error reading Excel file: ' + error.message, true);
      return false;
    }
  }

  let compareNote = '';

  async function uploadMultipleExcel(event) {
    // Copy first: clearing the input (so the same files can be picked again) empties its FileList
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (files.length === 0) return;

    const allMonthlyData = {};
    let grandTotalIncome = 0;
    let grandTotalExpense = 0;
    document.getElementById('comparisonSummary').style.display = 'none';

    try {
      showStatus(`📂 Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
      const { rows, skipped, problems } = await rowsFromFiles(files);
      if (!rows.length) throw new Error(problems.length ? problems.join(', ') : 'no transactions found');
      markExcessRefunds(rows).forEach(row => {
        const key = monthKeyOf(row);
        if (!key) return;
        if (!allMonthlyData[key]) allMonthlyData[key] = { label: monthLabelOf(key), income: 0, expenses: 0 };
        const c = classify(row);
        allMonthlyData[key].income += c.income;
        allMonthlyData[key].expenses += c.spend;
      });
      compareNote = [skipped ? `${skipped} duplicate${skipped === 1 ? '' : 's'} counted once` : '',
        problems.length ? `couldn't read ${problems.join(', ')}` : ''].filter(Boolean).join(' · ');

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
      showStatus(`✅ Compared ${Object.keys(allMonthlyData).length} month${Object.keys(allMonthlyData).length === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}` +
        (compareNote ? ` · ${compareNote}` : ''));
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
  // Refunds bigger than what was spent in their category that month are really
  // money coming in (a transfer from someone, an insurance payout…). Set by
  // markExcessRefunds() for each data set, so no category goes below zero.
  const EXCESS_REFUNDS = new WeakSet();

  function markExcessRefunds(rows) {
    const buckets = new Map();
    rows.forEach(r => {
      EXCESS_REFUNDS.delete(r);
      const c = classify(r);
      if (c.kind !== 'expense' && c.kind !== 'refund') return;
      const key = `${monthKeyOf(r) || 'undated'}|${getCategory(r)}`;
      const b = buckets.get(key) || { spent: 0, refunded: 0, refunds: [] };
      if (c.spend > 0) b.spent += c.spend;
      else { b.refunded -= c.spend; b.refunds.push(r); }
      buckets.set(key, b);
    });
    buckets.forEach(b => {
      if (b.refunded > b.spent) b.refunds.forEach(r => EXCESS_REFUNDS.add(r));
    });
    return rows;
  }

  function classify(row) {
    const debit = toCents(row['Debit [D]']);
    const credit = toCents(row['Credit [C]']);
    if (EXCESS_REFUNDS.has(row)) return { spend: 0, income: credit - debit, transfer: 0, kind: 'income' };
    const group = getCategoryGroup(getCategory(row));
    if (group === TRANSFER_GROUP) return { spend: 0, income: 0, transfer: credit - debit, kind: 'transfer' };
    if (group === 'Income') return { spend: 0, income: credit - debit, transfer: 0, kind: 'income' };
    // Money coming back for taxes or fees (CRA refunds, credits) is income — a
    // large one would otherwise push spending below zero
    if (credit > debit && getCategory(row) === canonicalCategory('Taxes & Fees')) {
      return { spend: 0, income: credit - debit, transfer: 0, kind: 'income' };
    }
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
  // Forecasts start once a week of the month has passed
  const FORECAST_MIN_DAYS = 7;

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
  // Ranks store names for a query: starts-with, then word starts-with, then
  // contains; ties go to stores you use more often, then more recently.
  function rankStoreSuggestions(query, entries, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    entries.forEach(e => {
      const n = e.name.toLowerCase();
      if (n === q) return; // already typed in full
      let rank;
      if (n.startsWith(q)) rank = 0;
      else if (n.split(/[\s\-&.,/]+/).some(w => w.startsWith(q))) rank = 1;
      else if (n.includes(q)) rank = 2;
      else return;
      scored.push({ e, rank: rank + (e.mine ? 0 : 3) });
    });
    scored.sort((a, b) => a.rank - b.rank || (b.e.count || 0) - (a.e.count || 0) ||
      (b.e.used || 0) - (a.e.used || 0) || a.e.name.localeCompare(b.e.name));
    return scored.slice(0, limit).map(s => s.e);
  }
  // Even split: who pays whom so everyone has paid the same share.
  // paid = { name: cents }. Returns [{ from, to, cents }] with the fewest transfers
  // (greedy largest-first); rounding cents go to the first people listed.
  function settleUp(paid) {
    const names = Object.keys(paid);
    if (names.length < 2) return [];
    const total = names.reduce((s, n) => s + paid[n], 0);
    const base = Math.floor(total / names.length);
    let extra = total - base * names.length;
    const balance = names.map(n => {
      const share = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      return { n, bal: paid[n] - share };
    });
    const owes = balance.filter(b => b.bal < 0).sort((a, b) => a.bal - b.bal);
    const gets = balance.filter(b => b.bal > 0).sort((a, b) => b.bal - a.bal);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < owes.length && j < gets.length) {
      const amt = Math.min(-owes[i].bal, gets[j].bal);
      if (amt > 0) out.push({ from: owes[i].n, to: gets[j].n, cents: amt });
      owes[i].bal += amt;
      gets[j].bal -= amt;
      if (owes[i].bal === 0) i++;
      if (gets[j].bal === 0) j++;
    }
    return out;
  }
  // Finds likely subscriptions/bills: the same store charged in 2+ different
  // months for about the same amount (within 10%). Skips transfers and anything
  // already set up as recurring.
  function detectRecurring(rows, existing) {
    const known = new Set((existing || []).map(r => String(r.desc || '').trim().toLowerCase()));
    const byStore = new Map();
    rows.forEach(r => {
      const c = classify(r);
      const month = monthKeyOf(r);
      const name = String(r['Purchased Store'] || '').trim();
      if (!name || !month || c.kind === 'transfer' || c.kind === 'refund') return;
      const cents = c.kind === 'income' ? c.income : c.spend;
      if (cents <= 0) return;
      const key = name.toLowerCase();
      if (known.has(key)) return;
      if (!byStore.has(key)) byStore.set(key, []);
      byStore.get(key).push({ r, month, cents, type: c.kind === 'income' ? 'C' : 'D' });
    });
    const median = arr => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const found = [];
    byStore.forEach(list => {
      // One charge per month (the largest) so a second purchase doesn't count twice
      const perMonth = new Map();
      list.forEach(x => { if (!perMonth.has(x.month) || perMonth.get(x.month).cents < x.cents) perMonth.set(x.month, x); });
      const months = [...perMonth.values()];
      if (months.length < 2) return;
      const amounts = months.map(x => x.cents);
      const mid = median(amounts);
      if (!amounts.every(a => Math.abs(a - mid) <= mid * 0.1)) return;
      const latest = months.sort((a, b) => b.month.localeCompare(a.month))[0];
      found.push({
        desc: String(latest.r['Purchased Store']).trim(),
        amount: mid / 100,
        day: median(months.map(x => dayOf(x.r)).filter(Boolean)) || 1,
        payer: latest.r['Purchased By'] || '',
        bank: latest.r['Bank Name'] || '',
        type: latest.type,
        months: months.length
      });
    });
    return found.sort((a, b) => b.months - a.months || b.amount - a.amount).slice(0, 8);
  }
  // Year summary grid: { categories: [{ name, months[12], total }], income[12],
  // spent[12], net[12] } in cents — same rules as every other total
  function yearSummary(rows, year) {
    const prefix = `${year}-`;
    const cats = new Map();
    const income = new Array(12).fill(0);
    const spent = new Array(12).fill(0);
    rows.forEach(r => {
      const key = monthKeyOf(r);
      if (!key || !key.startsWith(prefix)) return;
      const m = Number(key.slice(5, 7)) - 1;
      const c = classify(r);
      income[m] += c.income;
      if (c.spend) {
        spent[m] += c.spend;
        const name = getCategory(r);
        if (!cats.has(name)) cats.set(name, new Array(12).fill(0));
        cats.get(name)[m] += c.spend;
      }
    });
    const categories = [...cats.entries()]
      .map(([name, months]) => ({ name, months, total: months.reduce((a, b) => a + b, 0) }))
      .filter(c => c.total !== 0)
      .sort((a, b) => b.total - a.total);
    return { categories, income, spent, net: income.map((v, i) => v - spent[i]) };
  }
  // Name matching key: ignores case, spacing, punctuation and store/branch
  // numbers, so "COSTCO #512", "Costco 512" and "costco" are the same store
  function nameKey(name) {
    return String(name || '').toLowerCase()
      .replace(/[#*]\s*\d+/g, ' ')          // #512, *1234
      .replace(/[^a-z0-9&+ ]+/g, ' ')         // punctuation
      .replace(/\b\d+\b/g, ' ')              // standalone numbers
      .replace(/\s+/g, ' ').trim();
  }

  // 0–1 similarity from edit distance ("house rent" vs "home rent" ≈ 0.8)
  function nameSimilarity(a, b) {
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  // Pairs of names that are probably the same thing, for you to confirm.
  // names: [{ key, name, count }] (distinct keys). skip: Set of "keyA|keyB" you said differ.
  function findSimilarNames(names, skip) {
    const list = names.filter(x => x.key.length >= 4).slice(0, 400);
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const id = [a.key, b.key].sort().join('|');
        if (skip && skip.has(id)) continue;
        const sim = nameSimilarity(a.key, b.key);
        const wordsA = a.key.split(' ');
        const wordsB = b.key.split(' ');
        // One name is the other plus extra words ("shell" / "shell gas")
        const contained = (wordsA.every(w => wordsB.includes(w)) || wordsB.every(w => wordsA.includes(w))) &&
          Math.min(a.key.length, b.key.length) >= 4;
        if (sim >= 0.75 || contained) pairs.push({ a, b, id, score: Math.max(sim, contained ? 0.7 : 0) });
      }
    }
    return pairs.sort((x, y) => y.score - x.score || (y.a.count + y.b.count) - (x.a.count + x.b.count)).slice(0, 12);
  }
  // Savings goal progress. goal: { target, saved, by: 'YYYY-MM' | '' }.
  // perMonthC = what to put aside each month (this one included) to finish on time.
  function goalPlan(goal, currentMonth) {
    const targetC = toCents(goal.target);
    const savedC = toCents(goal.saved);
    const leftC = Math.max(0, targetC - savedC);
    const pct = targetC > 0 ? Math.min(100, (savedC / targetC) * 100) : 0;
    let monthsLeft = null;
    let perMonthC = null;
    if (/^\d{4}-\d{2}$/.test(goal.by || '')) {
      const [y1, m1] = currentMonth.split('-').map(Number);
      const [y2, m2] = goal.by.split('-').map(Number);
      monthsLeft = (y2 - y1) * 12 + (m2 - m1) + 1;
      perMonthC = monthsLeft > 0 ? Math.ceil(leftC / monthsLeft) : leftC;
    }
    return { targetC, savedC, leftC, pct, monthsLeft, perMonthC, done: leftC === 0 && targetC > 0 };
  }

  // Bills from your recurring list that are due soon or overdue this month and
  // not in the transactions yet. today: 'YYYY-MM-DD'. dismissed: Set of "name|YYYY-MM".
  function dueReminders(recurring, rows, today, windowDays, dismissed) {
    const month = today.slice(0, 7);
    const [y, m, d] = today.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const recorded = new Set(rows.filter(r => monthKeyOf(r) === month).map(r => nameKey(r['Purchased Store'])));
    const out = [];
    (recurring || []).forEach(rec => {
      if (rec.type === 'C' || !rec.desc) return; // reminders are for bills
      const key = nameKey(rec.desc);
      if (recorded.has(key) || (dismissed && dismissed.has(`${key}|${month}`))) return;
      const day = Math.min(Math.max(parseInt(rec.day, 10) || 1, 1), lastDay);
      const daysUntil = day - d;
      if (daysUntil > windowDays) return;
      out.push({ rec, key, date: `${month}-${String(day).padStart(2, '0')}`, daysUntil, overdue: daysUntil < 0 });
    });
    return out.sort((a, b) => a.daysUntil - b.daysUntil);
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
    // On the 1st and 2nd there's too little to compare — show no change arrows yet
    const tooEarly = cutoff !== null && cutoff < 3;
    renderKpis(rows, prevRows.length && !tooEarly ? prevCompare : null, prevLabel);

    const empty = budgetData.length === 0;
    document.getElementById('dashEmpty').hidden = !empty;
    document.getElementById('dashCharts').hidden = empty;
    document.getElementById('overviewSection').classList.toggle('is-empty', empty);
    document.querySelector('.table-section').classList.toggle('is-empty', empty);
    renderReminders(); // bills due show even before any file is opened
    if (empty) return;

    // Redrawn on every table render, so skip animation to avoid flicker
    const theme = chartTheme();
    renderCategoryPanel(rows, theme);
    renderPacePanel(rows, prevRows, prevKey, theme);
    renderTrendPanel(months, theme);
    renderTopStores(rows);
    renderSettleUp(rows);
    renderGoals();
  }

  // ---- Savings goals ----
  function renderGoals() {
    const panel = document.getElementById('goalsPanel');
    const goals = getSettings().goals;
    panel.hidden = !goals.length;
    if (!goals.length) return;
    const now = todayStr().slice(0, 7);
    const colors = seriesColors(chartTheme(), goals.length);
    document.getElementById('goalsList').innerHTML = goals.map((g, i) => {
      const plan = goalPlan(g, now);
      const by = g.by ? monthLabelOf(g.by, { month: 'short', year: 'numeric' }) : '';
      const hint = plan.done ? '🎉 Reached!'
        : plan.monthsLeft !== null
          ? (plan.monthsLeft > 0 ? `${fmtMoney(plan.leftC / 100)} to go · ${fmtMoney(plan.perMonthC / 100)}/month to reach it by ${escapeHtml(by)}` : `${fmtMoney(plan.leftC / 100)} to go · target date ${escapeHtml(by)} has passed`)
          : `${fmtMoney(plan.leftC / 100)} to go`;
      return `<li class="goal" data-goal="${escapeHtml(g.id)}">
        <div class="top-row"><span class="top-name">${escapeHtml(g.name)}</span><span class="top-amount">${fmtMoney(plan.savedC / 100)} <span class="muted">/ ${fmtMoney(plan.targetC / 100)}</span></span></div>
        <div class="top-bar"><span style="width: ${Math.max(2, plan.pct)}%; background: ${colors[i]}"></span></div>
        <div class="goal-foot"><span>${hint}</span>
          <span class="goal-add"><input type="number" step="0.01" inputmode="decimal" placeholder="Amount" aria-label="Amount to add to ${escapeHtml(g.name)}">
          <button type="button" class="pill-btn ghost" data-action="addToGoal" data-id="${escapeHtml(g.id)}"><i class="fas fa-plus"></i> Add</button></span>
        </div>
      </li>`;
    }).join('');
  }

  function addGoal() {
    const name = document.getElementById('goalName').value.trim().slice(0, 60);
    const target = parseFloat(document.getElementById('goalTarget').value);
    const by = document.getElementById('goalBy').value; // YYYY-MM or ''
    if (!name || !(target > 0)) {
      showStatus('⚠️ A goal needs a name and a target above zero.', true);
      return;
    }
    const settings = getSettings();
    settings.goals.push({ id: `g${Date.now().toString(36)}`, name, target: toCents(target) / 100, saved: 0, by: /^\d{4}-\d{2}$/.test(by) ? by : '' });
    saveSettings(settings);
    ['goalName', 'goalTarget', 'goalBy'].forEach(id => { document.getElementById(id).value = ''; });
    populateSettingsUI();
    renderDashboard();
    showStatus(`🎯 Goal “${name}” added.`);
  }

  // Positive amounts add to the goal, negative ones take money out
  function addToGoal(id, input) {
    const amount = parseFloat(input.value);
    if (!isFinite(amount) || amount === 0) { input.focus(); return; }
    const settings = getSettings();
    const g = settings.goals.find(x => x.id === id);
    if (!g) return;
    g.saved = Math.max(0, (toCents(g.saved) + toCents(amount)) / 100);
    saveSettings(settings);
    renderDashboard();
    showStatus(`🎯 ${fmtMoney(Math.abs(amount))} ${amount > 0 ? 'added to' : 'taken from'} “${g.name}”.`);
  }

  function removeGoal(id) {
    const settings = getSettings();
    settings.goals = settings.goals.filter(g => g.id !== id);
    saveSettings(settings);
    populateSettingsUI();
    renderDashboard();
  }

  // ---- Bill reminders ----
  const DISMISS_KEY = 'spendwise_dismissed';
  let currentReminders = [];

  function dismissedReminders() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY)) || []); } catch (e) { return new Set(); }
  }

  function renderReminders() {
    const box = document.getElementById('reminders');
    currentReminders = dueReminders(getSettings().recurring, budgetData, todayStr(), 5, dismissedReminders());
    box.hidden = !currentReminders.length;
    if (!currentReminders.length) { box.innerHTML = ''; return; }
    box.innerHTML = currentReminders.map((x, i) => {
      const when = x.overdue ? `was due ${escapeHtml(shortDate(x.date))}` : x.daysUntil === 0 ? 'due today' : x.daysUntil === 1 ? 'due tomorrow' : `due in ${x.daysUntil} days (${escapeHtml(shortDate(x.date))})`;
      return `<div class="reminder ${x.overdue ? 'overdue' : ''}">
        <i class="fas ${x.overdue ? 'fa-circle-exclamation' : 'fa-bell'}" aria-hidden="true"></i>
        <span><strong>${escapeHtml(x.rec.desc)}</strong> ${fmtMoney(x.rec.amount)} · ${when}</span>
        <span class="reminder-actions">
          <button type="button" class="pill-btn ghost" data-action="recordReminder" data-index="${i}">Add it</button>
          <button type="button" class="pill-btn ghost" data-action="dismissReminder" data-index="${i}" aria-label="Dismiss reminder for ${escapeHtml(x.rec.desc)}">Dismiss</button>
        </span>
      </div>`;
    }).join('');
  }

  function recordReminder(index) {
    const x = currentReminders[index];
    if (!x) return;
    const r = x.rec;
    const amount = toCents(r.amount) / 100;
    const entry = {
      'Date': x.date,
      'Purchased By': r.payer || '',
      'Purchased Store': r.desc,
      'Bank Name': r.bank || '',
      'Debit [D]': amount,
      'Credit [C]': '',
      'Amount Total': amount
    };
    budgetData.push(entry);
    rememberStores([entry]);
    markChanged();
    renderTable();
    showStatus(`✅ ${r.desc} ${fmtMoney(amount)} added for ${shortDate(x.date)}.`);
  }

  function dismissReminder(index) {
    const x = currentReminders[index];
    if (!x) return;
    const set = dismissedReminders();
    set.add(`${x.key}|${x.date.slice(0, 7)}`);
    // Keep only this year's dismissals
    const keep = [...set].filter(k => k.slice(-7, -3) >= String(new Date().getFullYear() - 1));
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(keep)); } catch (e) { /* ignore */ }
    renderReminders();
  }

  // Spending per person and the transfers that would even it up
  function renderSettleUp(rows) {
    const panel = document.getElementById('settlePanel');
    const paid = {};
    let unassignedC = 0;
    rows.forEach(r => {
      const c = spendOf(r);
      if (!c) return;
      const who = String(r['Purchased By'] || '').trim();
      if (who) paid[who] = (paid[who] || 0) + c;
      else unassignedC += c;
    });
    const people = Object.keys(paid).filter(n => paid[n] !== 0);
    if (people.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;
    const total = people.reduce((s, n) => s + paid[n], 0);
    const max = Math.max(...people.map(n => Math.abs(paid[n])));
    document.getElementById('settleSub').textContent =
      `${fmtMoney(total / 100)} shared by ${people.length} people · ${fmtMoney(total / people.length / 100)} each` +
      (unassignedC ? ` · ${fmtMoney(unassignedC / 100)} without a person not included` : '');
    const transfers = settleUp(Object.fromEntries(people.map(n => [n, paid[n]])));
    const colors = seriesColors(chartTheme(), people.length);
    document.getElementById('settleList').innerHTML =
      people.sort((a, b) => paid[b] - paid[a]).map((n, i) => `
        <li>
          <div class="top-row"><span class="top-name">${escapeHtml(n)}</span><span class="top-amount">${fmtMoney(paid[n] / 100)}</span></div>
          <div class="top-bar"><span style="width: ${Math.max(2, (Math.abs(paid[n]) / max) * 100)}%; background: ${colors[i]}"></span></div>
        </li>`).join('') +
      `<li class="settle-result">${transfers.length
        ? transfers.map(t => `<div><i class="fas fa-arrow-right-arrow-left" aria-hidden="true"></i> <strong>${escapeHtml(t.from)}</strong> pays <strong>${escapeHtml(t.to)}</strong> ${fmtMoney(t.cents / 100)}</div>`).join('')
        : '<div><i class="fas fa-circle-check" aria-hidden="true"></i> All even — nobody owes anything</div>'}</li>`;
  }

  function renderKpis(rows, prevRows, prevLabel) {
    const cur = periodTotals(rows);
    const prev = prevRows ? periodTotals(prevRows) : null;

    setAnimatedNumber(document.getElementById('kpiSpent'), cur.spent, fmtMoney);
    setAnimatedNumber(document.getElementById('kpiIncome'), cur.income, fmtMoney);
    const netEl = document.getElementById('kpiNet');
    setAnimatedNumber(netEl, cur.net, fmtMoney);
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
      el.innerHTML = `Same as <span class="nowrap">${escapeHtml(prevLabel)}</span>`;
      return;
    }
    const text = kind === 'pct' ? `${Math.abs((diff / prev) * 100).toFixed(0)}%`
      : kind === 'pts' ? `${Math.abs(diff).toFixed(0)} pts`
      : fmtMoney(Math.abs(diff));
    const up = diff > 0;
    el.classList.add(up === goodWhenUp ? 'good' : 'bad');
    el.innerHTML = `<i class="fas fa-arrow-${up ? 'up' : 'down'}" aria-hidden="true"></i> ${up ? 'Up' : 'Down'} ${escapeHtml(text)} <span class="nowrap">vs ${escapeHtml(prevLabel)}</span>`;
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
    // Height follows the number of bars, so one or two categories don't leave an empty box
    document.getElementById('dashCategoryChart').parentElement.style.height = `${Math.max(96, top.length * 34 + 24)}px`;
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
        // Click a bar to see those transactions ("Other (n more)" is a bundle, so not clickable)
        onClick: (evt, els) => {
          const i = els.length ? els[0].index : -1;
          if (i < 0 || (rest.length && i === top.length - 1)) return;
          filterTableTo({ category: top[i][0] });
        },
        onHover: (evt, els) => {
          const i = els.length ? els[0].index : -1;
          evt.native.target.style.cursor = (i >= 0 && !(rest.length && i === top.length - 1)) ? 'pointer' : 'default';
        },
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
      return perDay.slice(0, upTo).map(c => Math.max(0, (run += c)) / 100);
    };

    const isCurrent = dashActive === todayStr().slice(0, 7);
    const shownDays = isCurrent ? monthCutoffDay(rows) : daysIn(dashActive);
    const curSeries = cumulative(rows, dashActive, shownDays);
    const prevSeries = prevRows.length ? cumulative(prevRows, prevKey, daysIn(prevKey)) : null;
    const labelCount = Math.max(daysIn(dashActive), prevSeries ? prevSeries.length : 0);
    const curName = monthLabelOf(dashActive, { month: 'short' });
    const prevName = monthLabelOf(prevKey, { month: 'short' });

    const spentSoFar = curSeries[curSeries.length - 1] || 0;
    // A projection from the first few days would be a wild guess
    const projection = isCurrent && shownDays >= FORECAST_MIN_DAYS && shownDays < daysIn(dashActive)
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
      const raw = String(r['Purchased Store'] || '').trim();
      if (!c || !raw) return;
      const name = displayName(raw);
      const key = nameKey(name) || name.toLowerCase();
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
    const colors = seriesColors(chartTheme(), top.length);
    list.innerHTML = top.map((s, i) => `
      <li class="top-item" role="button" tabindex="0" data-store="${escapeHtml(s.name)}" aria-label="Show ${escapeHtml(s.name)} transactions">
        <div class="top-row">
          <span class="top-name">${escapeHtml(s.name)}</span>
          <span class="top-amount">${fmtMoney(s.cents / 100)}</span>
        </div>
        <div class="top-meta">${s.count} purchase${s.count > 1 ? 's' : ''}</div>
        <div class="top-bar"><span style="width: ${Math.max(2, (s.cents / max) * 100)}%; background: ${colors[i]}"></span></div>
      </li>`).join('');
  }

  // Dashboard → table: show the matching transactions for the month on screen
  function filterTableTo({ category = '', search = '' }) {
    syncFilterUI.autoOpen = true;
    setTimeout(() => { syncFilterUI.autoOpen = false; }, 0);
    categoryFilter = category;
    searchInput.value = search;
    filterMinAmount.value = '';
    filterMaxAmount.value = '';
    const preset = document.getElementById('datePreset');
    if (dashActive !== 'all') {
      const [y, m] = dashActive.split('-').map(Number);
      filterStartDate.value = `${dashActive}-01`;
      filterEndDate.value = `${dashActive}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      preset.value = 'custom';
    } else {
      filterStartDate.value = '';
      filterEndDate.value = '';
      preset.value = 'all';
    }
    renderTable();
    document.querySelector('.table-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const dashPeriodSelect = document.getElementById('dashPeriod');
  function setDashPeriod(value) {
    withViewTransition(() => {
      dashPinned = value;
      renderDashboard();
      renderBudgetTracking();
    });
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
          backgroundColor: seriesColors(theme, Object.keys(sortedBanks).length),
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
          backgroundColor: seriesColors(theme, Object.keys(sortedPersons).length),
          borderRadius: 4,
          maxBarThickness: 24
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 24 } }, // room for the tip labels
        plugins: {
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
    toggleTheme: el => toggleTheme(el),
    addSettingItem: el => addSettingItem(el.dataset.key, el.dataset.input),
    removeSettingItem: el => removeSettingItem(el.dataset.key, Number(el.dataset.index)),
    addBudgetSetting: () => addBudgetSetting(),
    removeBudgetByIndex: el => removeBudgetByIndex(Number(el.dataset.index)),
    addCategorySetting: () => addCategorySetting(),
    removeCategoryByIndex: el => removeCategoryByIndex(Number(el.dataset.index)),
    addRecurringSetting: () => addRecurringSetting(),
    removeRecurring: el => removeRecurring(Number(el.dataset.index)),
    addDetectedRecurring: el => addDetectedRecurring(Number(el.dataset.index)),
    mergeSuggestion: el => {
      const p = nameSuggestions[Number(el.dataset.index)];
      if (!p) return;
      const keep = el.dataset.keep === 'a' ? p.a : p.b;
      const drop = el.dataset.keep === 'a' ? p.b : p.a;
      mergeNames(drop.name, keep.name);
    },
    notSameSuggestion: el => {
      const p = nameSuggestions[Number(el.dataset.index)];
      if (p) markNotSame(p.id);
    },
    removeAlias: el => removeAlias(el.dataset.key),
    startCategoryEdit: el => { editingCategory = el.dataset.cat; renderBuiltinCategories(); const f = document.querySelector('#builtinCats .cat-edit-name'); if (f) f.focus(); },
    cancelCategoryEdit: () => { editingCategory = null; renderBuiltinCategories(); },
    saveCategoryEdit: el => saveCategoryEdit(el.dataset.cat),
    toggleCategoryHidden: el => toggleCategoryHidden(el.dataset.cat),
    resetCategoryEdit: el => resetCategoryEdit(el.dataset.cat),
    showMoreRows: () => { tableLimit += TABLE_PAGE; renderTable(); },
    addGoal: () => addGoal(),
    removeGoal: el => removeGoal(el.dataset.id),
    addToGoal: el => addToGoal(el.dataset.id, el.closest('.goal-add').querySelector('input')),
    recordReminder: el => recordReminder(Number(el.dataset.index)),
    dismissReminder: el => dismissReminder(Number(el.dataset.index)),
    resetAllLocalData: () => resetAllLocalData(),
    clearDeviceData: () => clearDeviceData(),
    backToReports: () => {
      document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
      openReportsHub();
    },
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
  attachStoreAutocomplete(document.getElementById('store'), () => autofillFromStore());
  attachStoreAutocomplete(document.getElementById('editStore'), null);

  // Phone: the + button opens the add form as a bottom sheet
  document.getElementById('fab').addEventListener('click', openEntrySheet);
  document.getElementById('entryClose').addEventListener('click', closeEntrySheet);
  document.getElementById('sheetBackdrop').addEventListener('click', closeEntrySheet);

  // Edit dialog
  document.getElementById('editSave').addEventListener('click', saveEdit);
  document.getElementById('editCancel').addEventListener('click', closeEditor);
  document.getElementById('editDuplicate').addEventListener('click', duplicateFromEditor);
  document.getElementById('editSplit').addEventListener('click', () =>
    toggleSplit(document.getElementById('splitBox').hidden));
  document.getElementById('splitApply').addEventListener('click', splitFromEditor);
  document.getElementById('splitAmount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); splitFromEditor(); }
  });
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
    const chip = e.target.closest('.note-chip');
    if (chip) {
      searchInput.value = chip.dataset.note;
      renderTable();
      return;
    }
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
  document.getElementById('bulkNoteApply').addEventListener('click', bulkSetNote);
  document.getElementById('bulkNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bulkSetNote(); } });
  document.getElementById('bulkDelete').addEventListener('click', bulkDelete);
  document.getElementById('bulkClear').addEventListener('click', () => {
    selectedRows.clear();
    renderTable();
  });

  // Clicking a top store or budget card filters the table to it
  const openFromDashboard = (el) => {
    if (el.dataset.store) filterTableTo({ search: el.dataset.store });
    else if (el.dataset.target) {
      const t = el.dataset.target;
      const isCategory = getCategoryGroup(t) || Object.prototype.hasOwnProperty.call(getCategoryGroups(), t);
      filterTableTo(isCategory ? { category: t } : { search: t });
    }
  };
  ['dashTopStores', 'budgetProgressList'].forEach(id => {
    const host = document.getElementById(id);
    host.addEventListener('click', (e) => {
      const el = e.target.closest('[data-store], [data-target]');
      if (el) openFromDashboard(el);
    });
    host.addEventListener('keydown', (e) => {
      const el = e.target.closest('[data-store], [data-target]');
      if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFromDashboard(el); }
    });
  });
  document.getElementById('categoryChipClear').addEventListener('click', () => {
    categoryFilter = '';
    renderTable();
  });

  // ---- Sample data: see the whole app before committing a file ----
  function buildSampleData() {
    const settings = getSettings();
    const [a, b] = settings.people.length >= 2 ? settings.people : ['Alex', 'Sam'];
    const card = settings.banks.find(x => /amex|credit|visa/i.test(x)) || settings.banks[0] || 'Card';
    const debitAcct = settings.banks.find(x => /debit|chequing/i.test(x)) || settings.banks[1] || card;
    const today = todayStr();
    const rows = [];
    const add = (month, day, who, store, bank, debit, credit, note) => {
      const [y, m] = month.split('-').map(Number);
      const d = Math.min(day, new Date(y, m, 0).getDate());
      const date = `${month}-${String(d).padStart(2, '0')}`;
      if (date > today) return; // nothing in the future
      const row = { 'Date': date, 'Purchased By': who, 'Purchased Store': store, 'Bank Name': bank,
        'Debit [D]': debit || '', 'Credit [C]': credit || '', 'Amount Total': debit || credit };
      if (note) row['Notes'] = note;
      rows.push(row);
    };
    [shiftMonth(today.slice(0, 7), -2), shiftMonth(today.slice(0, 7), -1), today.slice(0, 7)].forEach((m, k) => {
      add(m, 1, a, 'Payroll', debitAcct, 0, 4250);
      add(m, 1, b, 'Payroll', debitAcct, 0, 3380);
      add(m, 1, a, 'Rent', debitAcct, 2150, 0);
      add(m, 3, b, 'Costco', card, 186.4 + k * 12.35, 0);
      add(m, 5, a, 'Netflix', card, 16.99, 0);
      add(m, 6, b, 'Rogers', card, 95, 0);
      add(m, 8, a, 'Tim Hortons', card, 8.75 + k, 0);
      add(m, 10, b, 'Shell', card, 64.2, 0);
      add(m, 12, a, 'Uber Eats', card, 41.3 + k * 6, 0);
      add(m, 14, b, 'No Frills', card, 92.15, 0);
      add(m, 15, a, 'Amex credit card payment', debitAcct, 900, 0);
      add(m, 18, b, 'Winners', card, 58.99 - k * 7, 0);
      add(m, 20, a, 'Hydro One', debitAcct, 84.6, 0);
      add(m, 22, b, 'GoodLife Fitness', card, 45, 0);
      add(m, 24, a, 'TFSA contribution', debitAcct, 500, 0);
      add(m, 26, b, 'Shoppers Drug Mart', card, 27.4, 0);
    });
    add(shiftMonth(today.slice(0, 7), -1), 9, a, 'Air Canada', card, 642, 0, 'Banff trip');
    add(shiftMonth(today.slice(0, 7), -1), 11, b, 'Fairmont Banff Springs', card, 389, 0, 'Banff trip');
    return rows.map(normalizeRow);
  }

  function loadSampleData() {
    if (!confirmReplaceUnsaved()) return;
    budgetData = buildSampleData();
    sampleMode = true;
    source = null;
    selectedRows.clear();
    dashPinned = null;
    unsavedCount = 0;
    updateUnsavedBadge();
    document.getElementById('sampleBanner').hidden = false;
    renderTable();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    revealDashboard();
  }

  function leaveSampleMode() {
    sampleMode = false;
    document.getElementById('sampleBanner').hidden = true;
    updateUnsavedBadge();
  }

  document.getElementById('welcomeSample').addEventListener('click', loadSampleData);
  document.getElementById('sampleClear').addEventListener('click', () => {
    budgetData = [];
    leaveSampleMode();
    unsavedCount = 0;
    updateUnsavedBadge();
    renderTable();
  });
  document.getElementById('sampleUpload').addEventListener('click', () => chooseUploadFiles());

  // Welcome screen shortcuts
  document.getElementById('welcomeAdd').addEventListener('click', () => {
    if (isPhone()) { openEntrySheet(); return; }
    setCollapsed('entry', false);
    document.getElementById('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => document.getElementById('amount').focus({ preventScroll: true }), 250);
  });
  document.getElementById('welcomeOpen').addEventListener('click', chooseUploadFiles);

  // ---- Collapsible sections (remembered on this device) ----
  const COLLAPSE_KEY = 'spendwise_collapsed';
  const COLLAPSE_TARGETS = { overview: '#overviewSection', entry: '#entryCard', table: '.table-section' };

  function setCollapsed(key, collapsed, persist = true) {
    const section = document.querySelector(COLLAPSE_TARGETS[key]);
    const btn = document.querySelector(`[data-collapse="${key}"]`);
    if (!section || !btn) return;
    section.classList.toggle('collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${btn.getAttribute('aria-label').replace(/^(Expand|Collapse) /, '')}`);
    if (!persist) return;
    let state = {};
    try { state = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) { /* ignore */ }
    state[key] = collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  document.querySelectorAll('[data-collapse]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.collapse;
      setCollapsed(key, !document.querySelector(COLLAPSE_TARGETS[key]).classList.contains('collapsed'));
    });
  });
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {};
    Object.keys(COLLAPSE_TARGETS).forEach(k => { if (saved[k] === true) setCollapsed(k, true, false); });
  } catch (e) { /* ignore */ }

  // Enter saves a category edit, Escape cancels it
  document.getElementById('builtinCats').addEventListener('keydown', (e) => {
    const row = e.target.closest('.cat-edit-row.editing');
    if (!row) return;
    if (e.key === 'Enter') { e.preventDefault(); saveCategoryEdit(row.dataset.cat); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editingCategory = null; renderBuiltinCategories(); }
  });

  document.getElementById('goalsList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.goal-add input')) {
      e.preventDefault();
      const btn = e.target.closest('.goal-add').querySelector('[data-action="addToGoal"]');
      addToGoal(btn.dataset.id, e.target);
    }
  });

  // Quick category chips: tap to choose, tap again for Auto-detect
  document.getElementById('quickCats').addEventListener('click', (e) => {
    const chip = e.target.closest('button');
    if (!chip) return;
    e.preventDefault();
    const sel = document.getElementById('category');
    if (chip.id === 'quickMore') { openCategoryPanel(document.querySelector('#entryCard .cat-wrap')); return; }
    sel.value = sel.value === chip.dataset.cat ? '' : chip.dataset.cat;
    sel.dispatchEvent(new Event('change'));
    renderQuickCats();
  });
  document.getElementById('category').addEventListener('change', renderQuickCats);

  // ---- Phone tab bar ----
  const tabActions = {
    overview: () => document.getElementById('overviewSection').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }),
    table: () => document.querySelector('.table-section').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }),
    reports: () => openReportsHub(),
    settings: () => openSettingsModal()
  };
  document.getElementById('tabBar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (tab.id === 'tabAdd') { openEntrySheet(); return; }
    tabActions[tab.dataset.tab]();
  });
  // Highlight the section on screen
  if ('IntersectionObserver' in window) {
    const tabs = { overview: document.getElementById('overviewSection'), table: document.querySelector('.table-section') };
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const key = Object.keys(tabs).find(k => tabs[k] === en.target);
        document.querySelectorAll('#tabBar .tab[data-tab]').forEach(t => {
          const on = t.dataset.tab === key;
          t.classList.toggle('active', on);
          if (on) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.values(tabs).forEach(el => io.observe(el));
  }

  // ---- Settings section menu ----
  document.querySelector('.settings-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-target]');
    if (!btn) return;
    document.getElementById(btn.dataset.target).scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  });

  // ---- Keyboard shortcuts ----
  const shortcutsModal = document.getElementById('shortcutsModal');
  const openShortcuts = () => { shortcutsModal.style.display = 'flex'; };
  document.getElementById('shortcutsLink').addEventListener('click', openShortcuts);
  document.getElementById('closeShortcuts').addEventListener('click', () => { shortcutsModal.style.display = 'none'; });
  shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) shortcutsModal.style.display = 'none'; });

  document.addEventListener('keydown', (e) => {
    // ⌘S / Ctrl+S saves to Excel from anywhere, instead of saving the web page
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (budgetData.length) downloadExcel();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing || [...document.querySelectorAll('.modal')].some(m => m.style.display === 'flex')) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (isPhone()) { openEntrySheet(); return; }
      setCollapsed('entry', false);
      document.getElementById('entryCard').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      setTimeout(() => document.getElementById('amount').focus({ preventScroll: true }), 200);
    } else if (e.key === '/') {
      e.preventDefault();
      setCollapsed('table', false);
      searchInput.scrollIntoView({ block: 'center' });
      searchInput.focus({ preventScroll: true });
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      document.getElementById('downloadBtn').click();
    } else if (e.key === '?') {
      e.preventDefault();
      openShortcuts();
    }
  });

  // Draft restore bar
  document.getElementById('draftRestore').addEventListener('click', restoreDraft);
  document.getElementById('draftDiscard').addEventListener('click', discardDraft);

  // Last line of defence if storage is unavailable: warn before leaving with unsaved work
  window.addEventListener('beforeunload', (e) => {
    if (unsavedCount > 0 && !sampleMode) {
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
            const visible = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
            const first = visible.find(el => !el.matches('.close, .back-btn')) || visible[0];
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

  // First impression: the header and hero arrive in a calm sequence, once per visit
  try {
    if (!sessionStorage.getItem('moneta_entered') && !prefersReducedMotion()) {
      document.body.classList.add('is-entering');
      setTimeout(() => document.body.classList.remove('is-entering'), 1800);
    }
    sessionStorage.setItem('moneta_entered', '1');
  } catch (e) { /* storage unavailable */ }

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
