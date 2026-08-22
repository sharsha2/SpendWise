  let budgetData = [];
  let inlineEditIndex = -1;

  const DATA_KEY = 'spendwise_data';
  const fmtCurrency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

  function fmtMoney(v) {
    return fmtCurrency.format(Number(v) || 0);
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

  function persistData() {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(budgetData)); } catch (e) { /* storage unavailable or full */ }
  }

  function loadPersistedData() {
    try {
      const stored = JSON.parse(localStorage.getItem(DATA_KEY));
      if (Array.isArray(stored)) budgetData = stored;
    } catch (e) { /* corrupted saved data — start fresh */ }
  }
  let incomeExpenseChart = null;
  let spendingCategoryChart = null;
  let monthlyOverviewChart = null;
  let creditCardSpendingChart = null;
  let purchasedByTrendChart = null;
  let compareMonthsChart = null;
  let currentSort = { column: null, direction: 'none' }; // none, asc, desc

  // Chart Color Palette
  const chartColors = {
    income: '#059669',   // Emerald 600
    expense: '#EF4444',  // Red 500
    primary: '#0D9488',  // Teal 600
    palette: [
      '#0D9488', '#6366F1', '#F59E0B', '#F43F5E', '#8B5CF6', /* Teal, Indigo, Amber, Rose, Violet */
      '#06B6D4', '#10B981', '#D946EF', '#F97316', '#64748B' /* Cyan, Emerald, Fuchsia, Orange, Slate */
    ]
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
      if (inlineEditIndex > -1) cancelInlineEdit();
    }
  });

  function showView(viewId) {
    if(viewId === 'dashboard') {
      document.getElementById('dashboardView').classList.add('active');
    }
    menuOptions.classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

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
  function getCategoryGroups() {
    const groups = {
      'Income': {
        'Income': ['payroll', 'salary', 'deposit', 'income', 'interest', 'intrest', 'refund', 'cashback', 'rebate']
      },
      'Housing': {
        'Rent': ['rent', 'apartment', 'housing', 'lease'],
        'Home': ['furniture', 'ikea', 'home depot', 'decor', 'renovation', 'repair', 'appliance']
      },
      'Bills & Utilities': {
        'Phone & Internet': ['phone', 'internet', 'wifi', 'mobile', 'rogers', 'bell canada', 'bell mobility', 'telus', 'fido', 'koodo', 'freedom mobile', 'cable tv'],
        'Utilities': ['utility', 'utilities', 'hydro', 'electricity', 'electric bill', 'power bill', 'water', 'gas bill', 'natural gas', 'enbridge', 'heating'],
        'Credit Card Payment': ['credit card', 'card payment'],
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
        'Investment': ['investment', 'stocks', 'etf', 'crypto', 'rrsp', 'tfsa', 'mutual fund', 'wealthsimple'],
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
    return groups;
  }

  // Flat map (sub-category → keywords). Custom entries are inserted first so
  // the user's keywords take matching precedence over the built-ins, and
  // re-applied last so same-named custom categories override default keywords.
  function getCategoryMap() {
    const groups = getCategoryGroups();
    const custom = groups['Custom'] || {};
    const flat = { ...custom };
    for (const [group, subs] of Object.entries(groups)) {
      if (group === 'Custom') continue;
      Object.assign(flat, subs);
    }
    return Object.assign(flat, custom);
  }

  // Which group a sub-category belongs to (e.g. 'Utilities' → 'Bills & Utilities')
  function getCategoryGroup(category) {
    for (const [group, subs] of Object.entries(getCategoryGroups())) {
      if (subs[category] !== undefined) return group;
    }
    return null;
  }

  // Manage People and Banks Settings
  function getSettings() {
    const defaultSettings = {
      people: ['Harsha', 'Cherry'],
      banks: ['Scotia Debit', 'Scotia Credit', 'Amex', 'PC', 'Wealthsimple', 'Simplii'],
      budgets: {}, // { "Groceries": 600 }
      recurring: [], // [ {desc, amount, day, payer, bank, type} ]
      categories: {} // { "Pets": ["vet", "petsmart"] }
    };
    const stored = localStorage.getItem('spendwise_settings');
    return stored ? JSON.parse(stored) : defaultSettings;
  }

  function saveSettings(settings) {
    localStorage.setItem('spendwise_settings', JSON.stringify(settings));
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
    if (!target || isNaN(amount)) return;
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
    if (!name || keywords.length === 0) {
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
    const day = parseInt(document.getElementById('recDay').value);
    if (!desc || isNaN(amount) || isNaN(day)) return;
    
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
    
    pList.innerHTML = settings.people.map((p, i) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:5px; border-bottom:1px solid var(--border-color);">
        ${escapeHtml(p)} <button class="list-remove-btn" aria-label="Remove ${escapeHtml(p)}" onclick="removeSettingItem('people', ${i})"><i class="fas fa-times"></i></button>
      </div>`).join('');

    bList.innerHTML = settings.banks.map((b, i) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:5px; border-bottom:1px solid var(--border-color);">
        ${escapeHtml(b)} <button class="list-remove-btn" aria-label="Remove ${escapeHtml(b)}" onclick="removeSettingItem('banks', ${i})"><i class="fas fa-times"></i></button>
      </div>`).join('');

    budList.innerHTML = Object.entries(settings.budgets).map(([k, v], i) =>
      `<div class="budget-item" style="display:flex; justify-content:space-between; align-items:center;">
        <span><strong>${escapeHtml(k)}</strong>: ${fmtMoney(v)}</span>
        <button class="list-remove-btn" aria-label="Remove budget ${escapeHtml(k)}" onclick="removeBudgetByIndex(${i})"><i class="fas fa-times"></i></button>
      </div>`).join('');

    recList.innerHTML = settings.recurring.map((r, i) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-color);">
        <span>[Day ${r.day}] <strong>${escapeHtml(r.desc)}</strong> - ${fmtMoney(r.amount)} (${escapeHtml(r.payer)})</span>
        <button class="list-remove-btn" aria-label="Remove recurring ${escapeHtml(r.desc)}" onclick="removeRecurring(${i})"><i class="fas fa-times"></i></button>
      </div>`).join('');

    catList.innerHTML = Object.entries(settings.categories || {}).map(([name, kws], i) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:5px; border-bottom:1px solid var(--border-color);">
        <span><strong>${escapeHtml(name)}</strong>: ${escapeHtml(kws.join(', '))}</span>
        <button class="list-remove-btn" aria-label="Remove category ${escapeHtml(name)}" onclick="removeCategoryByIndex(${i})"><i class="fas fa-times"></i></button>
      </div>`).join('') || '<div style="color: var(--muted-color); padding: 5px;">No custom categories yet.</div>';

    // Sync dropdowns in recurring form
    document.getElementById('recPayer').innerHTML = settings.people.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    document.getElementById('recBank').innerHTML = settings.banks.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
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

  function applyRecurringTransactions(auto = false) {
    const settings = getSettings();
    if (settings.recurring.length === 0) {
      if (!auto) showStatus('⚠️ No recurring transactions defined in Settings.', true);
      return;
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    
    let count = 0;
    let skipped = 0;
    settings.recurring.forEach(r => {
      const day = String(r.day).padStart(2, '0');
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
      if (!auto) showStatus('ℹ️ All recurring transactions were already applied this month.');
      return;
    }

    renderTable();
    showStatus(auto
      ? `🔁 Auto-applied ${count} recurring transaction${count > 1 ? 's' : ''} for this month.`
      : `✅ Applied ${count} recurring transaction${count > 1 ? 's' : ''}${skipped ? ` (${skipped} already present)` : ''}.`);
  }

  applyRecurringBtn.addEventListener('click', () => applyRecurringTransactions(false));

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

  function addEntry() {
    const date = document.getElementById('date').value;
    const purchasedBy = document.getElementById('purchasedBy').value || '';
    const store = document.getElementById('store').value || '';
    const bank = document.getElementById('bank').value || '';
    const type = document.getElementById('type').value;
    const category = document.getElementById('category').value;
    const amountVal = document.getElementById('amount').value;
    const amount = amountVal === '' ? NaN : parseFloat(amountVal);

    if (!date || isNaN(amount) || amount < 0) {
      showStatus('⚠️ Please enter valid Date and Amount (must be positive).', true);
      return;
    }

    const debit = type === 'D' ? amount : '';
    const credit = type === 'C' ? amount : '';

    const entry = {
      'Date': date,
      'Purchased By': purchasedBy,
      'Purchased Store': store,
      'Bank Name': bank,
      'Debit [D]': debit,
      'Credit [C]': credit,
      'Amount Total': amount
    };
    if (category) entry['Category'] = category;

    budgetData.push(entry);
    showStatus('✅ Entry added successfully!');
    renderTable();
    resetForm();
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
    updateCategoryHint();
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

    document.getElementById('categoryPickerPanel').innerHTML = buildCategoryPanelHTML();
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

  // Manual category on the entry wins; otherwise guess from keywords
  function getCategory(row) {
    return row['Category'] || categorizeStore(row['Purchased Store'] || '');
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
    for (const [category, keywords] of Object.entries(categoryMap)) {
      if (keywords.some(keyword => keywordMatches(storeLower, keyword))) {
        return category;
      }
    }
    return 'Other';
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
      direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    }
    
    // Update current sort
    currentSort = { column, direction };
    header.setAttribute('data-sort-direction', direction);
    
    // Update sort icon
    const sortIcon = header.querySelector('.sort-icon');
    sortIcon.textContent = direction === 'asc' ? '↑' : '↓';

    // Sorting reorders rows, so leave inline edit mode to keep indices valid
    inlineEditIndex = -1;
    
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
        (row['Bank Name'] || '').toLowerCase().includes(searchTerm)
      );

      const rowDate = row['Date'] || '';
      const matchesDate = (!start || rowDate >= start) && (!end || rowDate <= end);

      const rowAmount = Number(row['Amount Total']) || 0;
      const matchesAmount = rowAmount >= minAmount && rowAmount <= maxAmount;

      return matchesSearch && matchesDate && matchesAmount;
    });
  }

  function renderTable() {
    persistData();

    const tbody = document.querySelector('#budgetTable tbody');
    tbody.innerHTML = '';

    let totalDebitC = 0;
    let totalCreditC = 0;
    let totalAmountC = 0;

    const filteredData = getFilteredData();
    const filtersActive = searchInput.value !== '' || filterStartDate.value || filterEndDate.value ||
      filterMinAmount.value !== '' || filterMaxAmount.value !== '';

    document.getElementById('rowCount').textContent =
      filtersActive ? `(${filteredData.length} of ${budgetData.length})` : `(${budgetData.length})`;

    if (filteredData.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><div class="empty-state">
        <i class="fas ${filtersActive ? 'fa-filter-circle-xmark' : 'fa-receipt'}"></i>
        <div class="empty-title">${filtersActive ? 'No matching transactions' : 'No transactions yet'}</div>
        <div class="empty-hint">${filtersActive ? 'Try adjusting or clearing your filters.' : 'Add your first entry above, or upload an Excel file to get started.'}</div>
      </div></td></tr>`;
      updateTotals();
      renderBudgetTracking();
      return;
    }

    const settings = getSettings();
    // <option> list where the row's current value stays selectable even if
    // it was removed from Settings since the entry was created
    const selOpts = (list, current) => {
      const items = (!current || list.includes(current)) ? list : [current, ...list];
      return items.map(v => `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
    };

    filteredData.forEach((row) => {
      const tr = document.createElement('tr');
      const debit = Number(row['Debit [D]']) || 0;
      const credit = Number(row['Credit [C]']) || 0;
      const amount = Number(row['Amount Total']) || 0;

      // Map back to original index for data integrity
      const originalIdx = budgetData.indexOf(row);

      totalDebitC += toCents(debit);
      totalCreditC += toCents(credit);
      totalAmountC += toCents(amount);

      const category = getCategory(row);

      if (originalIdx === inlineEditIndex) {
        tr.className = 'editing-row';
        // Same grouped structure as the main picker: optgroups per group,
        // single-category groups shown as direct options
        const cur = row['Category'] || '';
        const catOpt = c => `<option value="${escapeHtml(c)}"${cur === c ? ' selected' : ''}>${escapeHtml(c)}</option>`;
        const catOpts = '<option value="">Auto-detect</option>' +
          Object.entries(getCategoryGroups()).map(([group, subs]) => {
            const names = Object.keys(subs).sort((a, b) => a.localeCompare(b));
            if (names.length === 1) return catOpt(names[0]);
            return `<optgroup label="${escapeHtml(group)}">` + names.map(catOpt).join('') + '</optgroup>';
          }).join('');
        tr.innerHTML =
          `<td><input type="date" class="ie-date" value="${escapeHtml(row['Date'] || '')}"></td>` +
          `<td><select class="ie-payer">${selOpts(settings.people, row['Purchased By'] || '')}</select></td>` +
          `<td><input type="text" class="ie-store" value="${escapeHtml(row['Purchased Store'] || '')}" placeholder="Store">` +
          `<div class="cat-wrap ie-cat-wrap">` +
          `<select class="ie-category sr-select" tabindex="-1" aria-hidden="true">${catOpts}</select>` +
          `<button type="button" class="category-picker-btn" aria-haspopup="listbox" aria-expanded="false"><span>${escapeHtml(cur || 'Auto-detect')}</span><i class="fas fa-chevron-down"></i></button>` +
          `<div class="category-picker-panel" hidden>${buildCategoryPanelHTML()}</div>` +
          `</div></td>` +
          `<td><select class="ie-bank">${selOpts(settings.banks, row['Bank Name'] || '')}</select></td>` +
          `<td class="right"><input type="number" class="ie-debit" step="0.01" min="0" inputmode="decimal" placeholder="0.00" value="${debit || ''}"></td>` +
          `<td class="right"><input type="number" class="ie-credit" step="0.01" min="0" inputmode="decimal" placeholder="0.00" value="${credit || ''}"></td>` +
          `<td class="right amount-cell">${fmtMoney(amount)}</td>` +
          `<td class="center">` +
          `<button class="action-btn edit-btn" data-tooltip="Save" aria-label="Save" onclick="saveInlineEdit(${originalIdx})"><i class="fas fa-check"></i></button>` +
          `<button class="action-btn delete-btn" data-tooltip="Cancel" aria-label="Cancel" onclick="cancelInlineEdit()"><i class="fas fa-times"></i></button>` +
          `</td>`;
        tbody.appendChild(tr);
        return;
      }

      tr.innerHTML =
        `<td>${escapeHtml(row['Date'] || '')}</td>` +
        `<td>${escapeHtml(row['Purchased By'] || '')}</td>` +
        `<td>${getCategoryBadge(category)} ${escapeHtml(row['Purchased Store'] || '')}</td>` +
        `<td>${escapeHtml(row['Bank Name'] || '')}</td>` +
        `<td class="right debit-cell">${debit ? fmtMoney(debit) : ''}</td>` +
        `<td class="right credit-cell">${credit ? fmtMoney(credit) : ''}</td>` +
        `<td class="right amount-cell">${fmtMoney(amount)}</td>` +
        `<td class="center">` +
        `<button class="action-btn edit-btn" data-tooltip="Edit Entry" aria-label="Edit Entry" onclick="editRow(${originalIdx})"><i class="fas fa-edit"></i></button>` +
        `<button class="action-btn delete-btn" data-tooltip="Delete Entry" aria-label="Delete Entry" onclick="removeRow(${originalIdx})"><i class="fas fa-trash"></i></button>` +
        `</td>`;
      tbody.appendChild(tr);
    });

    // Add summary row
    const summaryRow = document.createElement('tr');
    summaryRow.className = 'summary-row';
    summaryRow.innerHTML =
      `<td colspan="4"><strong>TOTALS</strong></td>` +
      `<td class="right debit-cell"><strong>${fmtMoney(totalDebitC / 100)}</strong></td>` +
      `<td class="right credit-cell"><strong>${fmtMoney(totalCreditC / 100)}</strong></td>` +
      `<td class="right amount-cell"><strong>${fmtMoney(totalAmountC / 100)}</strong></td>` +
      `<td class="center"></td>`;
    tbody.appendChild(summaryRow);

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

    // Budgets are monthly: only count spending from the current month
    const monthPrefix = todayStr().slice(0, 7);
    const monthName = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
    document.getElementById('budgetMonthLabel').textContent = `— ${monthName}`;

    Object.entries(settings.budgets).forEach(([target, limit]) => {
      const spent = budgetData.reduce((cents, r) => {
        if (!(r['Date'] || '').startsWith(monthPrefix)) return cents;
        const cat = getCategory(r);
        // A budget can target a sub-category, a whole group (e.g. "Bills & Utilities"), or store text
        const matches = (cat === target || getCategoryGroup(cat) === target ||
          (r['Purchased Store'] || '').toLowerCase().includes(target.toLowerCase()));
        return matches ? cents + toCents(r['Debit [D]']) : cents;
      }, 0) / 100;

      const percent = Math.min((spent / limit) * 100, 100);
      const color = percent >= 100 ? 'var(--danger-color)' : percent > 80 ? 'var(--warning-color)' : 'var(--gradient)';

      const item = document.createElement('div');
      item.className = 'budget-item';
      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:700;">
          <span>${escapeHtml(target)}</span>
          <span>${fmtMoney(spent)} / ${fmtMoney(limit)}</span>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${percent}%; background: ${color};"></div></div>
      `;
      list.appendChild(item);
    });
  }

  // Editing happens inline, directly on the table row
  function editRow(index) {
    inlineEditIndex = index;
    renderTable();
    const firstInput = document.querySelector('#budgetTable tbody tr.editing-row input');
    if (firstInput) firstInput.focus();
  }

  function cancelInlineEdit() {
    inlineEditIndex = -1;
    renderTable();
  }

  function saveInlineEdit(index) {
    const tr = document.querySelector('#budgetTable tbody tr.editing-row');
    if (!tr) return;

    const date = tr.querySelector('.ie-date').value;
    const debitVal = tr.querySelector('.ie-debit').value;
    const creditVal = tr.querySelector('.ie-credit').value;
    const debit = debitVal === '' ? 0 : parseFloat(debitVal);
    const credit = creditVal === '' ? 0 : parseFloat(creditVal);

    if (!date || isNaN(debit) || isNaN(credit) || debit < 0 || credit < 0 || (debit === 0 && credit === 0)) {
      showStatus('⚠️ Enter a valid date and a debit or credit amount.', true);
      return;
    }

    const entry = {
      'Date': date,
      'Purchased By': tr.querySelector('.ie-payer').value,
      'Purchased Store': tr.querySelector('.ie-store').value.trim(),
      'Bank Name': tr.querySelector('.ie-bank').value,
      'Debit [D]': debit || '',
      'Credit [C]': credit || '',
      'Amount Total': (toCents(debit) + toCents(credit)) / 100
    };
    const cat = tr.querySelector('.ie-category').value;
    if (cat) entry['Category'] = cat;

    budgetData[index] = entry;
    inlineEditIndex = -1;
    renderTable();
    showStatus('✅ Entry updated.');
  }

  function removeRow(index) {
    const removed = budgetData.splice(index, 1)[0];
    if (inlineEditIndex === index) {
      inlineEditIndex = -1;
    } else if (inlineEditIndex > index) {
      inlineEditIndex--;
    }
    renderTable();
    showStatus('🗑️ Entry deleted.', false, () => {
      budgetData.splice(Math.min(index, budgetData.length), 0, removed);
      renderTable();
      showStatus('↩️ Entry restored.');
    });
  }

  function clearTable() {
    if (confirm('🗑️ Clear all data? This action cannot be undone.')) {
      budgetData = [];
      inlineEditIndex = -1;
      renderTable();
      showStatus('✅ All data cleared!');
    }
  }

  function downloadExcel() {
    if (budgetData.length === 0) {
      showStatus('❌ No data to download!', true);
      return;
    }
    if (typeof XLSX === 'undefined') {
      showStatus('❌ Excel library not loaded. Please refresh and try again.', true);
      return;
    }
    try {
      const cols = ['Date','Purchased By','Purchased Store','Bank Name','Category','Debit [D]','Credit [C]','Amount Total'];
      const ws = XLSX.utils.json_to_sheet(budgetData, { header: cols });
      const maxWidths = cols.map(col => Math.max(col.length, ...budgetData.map(row => String(row[col] || '').length)));
      ws['!cols'] = maxWidths.map(width => ({ wch: Math.min(40, Math.max(10, width + 2)) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Budget Data');
      const now = new Date();
      const month = now.toLocaleString('default', { month: 'short' });
      const year = now.getFullYear();
      const date = String(now.getDate()).padStart(2, '0');
      const fileName = `${month}-${year}-${date}-Expenses.xlsx`;
      XLSX.writeFile(wb, fileName);
      showStatus('✅ Excel file downloaded successfully!');
    } catch (error) {
      showStatus('❌ Error downloading Excel file: ' + error.message, true);
    }
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
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet);
        if (jsonData.length === 0) {
          showStatus('❌ No data found in the Excel file.', true);
          return;
        }
        budgetData = jsonData.map(normalizeRow);
        renderTable();
        showStatus(`✅ Imported ${budgetData.length} transaction${budgetData.length > 1 ? 's' : ''} from Excel.`);
      } catch (error) {
        showStatus('❌ Error reading Excel file: ' + error.message, true);
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
  }

  async function uploadMultipleExcel(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

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
                  allMonthlyData[sortKey].income += toCents(row['Credit [C]']);
                  allMonthlyData[sortKey].expenses += toCents(row['Debit [D]']);
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
      document.getElementById('comparisonSummary').style.display = 'flex';

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

    compareMonthsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Income', data: incomeData, backgroundColor: chartColors.income, borderRadius: 6 },
          { label: 'Expenses', data: expensesData, backgroundColor: chartColors.expense, borderRadius: 6 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (context) => `${context.dataset.label}: ${fmtMoney(context.raw)}`
            }
          }
        },
        scales: {
          y: { beginAtZero: true, grid: { display: false } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  function updateTotals() {
    const totalDebitC = sumCents(budgetData, 'Debit [D]');
    const totalCreditC = sumCents(budgetData, 'Credit [C]');
    const net = (totalCreditC - totalDebitC) / 100;

    document.getElementById('totalDebit').textContent = fmtMoney(totalDebitC / 100);
    document.getElementById('totalCredit').textContent = fmtMoney(totalCreditC / 100);
    const netEl = document.getElementById('netTotal');
    netEl.textContent = fmtMoney(net);
    netEl.classList.toggle('pos', net >= 0);
    netEl.classList.toggle('neg', net < 0);
  }

  function updateIncomeExpenseChart() {
    const ctx = document.getElementById('incomeExpenseChart').getContext('2d');
    
    if (incomeExpenseChart) {
      incomeExpenseChart.destroy();
    }
    
    const data = getFilteredData();
    const totalDebit = sumCents(data, 'Debit [D]') / 100;
    const totalCredit = sumCents(data, 'Credit [C]') / 100;
    
    incomeExpenseChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Expenses', 'Income'],
        datasets: [{
          data: [totalDebit, totalCredit],
          backgroundColor: [chartColors.expense, chartColors.income],
          borderWidth: 0,
          hoverOffset: 15
        }]
      },
      options: {
        cutout: '70%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Total Cashflow Summary',
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 14
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
                return `${context.label || ''}: ${fmtMoney(context.raw)} (${pct}%)`;
              }
            }
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
      if (row['Debit [D]']) {
        const category = getCategory(row);
        categoriesC[category] = (categoriesC[category] || 0) + toCents(row['Debit [D]']);
      }
    });

    // Show the top slices only and group the tail so the doughnut stays readable
    const catEntries = Object.entries(categoriesC).sort((a, b) => b[1] - a[1]);
    const topSlices = catEntries.slice(0, 9);
    const restSlices = catEntries.slice(9);
    if (restSlices.length) {
      topSlices.push([`Other (${restSlices.length} more)`, restSlices.reduce((s, [, v]) => s + v, 0)]);
    }
    const sortedCategories = Object.fromEntries(topSlices.map(([k, v]) => [k, v / 100]));
    
    spendingCategoryChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(sortedCategories),
        datasets: [{
          data: Object.values(sortedCategories),
          backgroundColor: chartColors.palette,
          borderWidth: 0,
          hoverOffset: 15
        }]
      },
      options: {
        cutout: '70%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Expenditure Breakdown',
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 14
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
                return `${context.label || ''}: ${fmtMoney(context.raw)} (${pct}%)`;
              }
            }
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

        monthlyData[sortKey].incomeC += toCents(row['Credit [C]']);
        monthlyData[sortKey].expensesC += toCents(row['Debit [D]']);
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
    
    monthlyOverviewChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Income',
            data: incomeData,
            backgroundColor: chartColors.income,
            borderRadius: 6,
            barPercentage: 0.6,
            categoryPercentage: 0.5
          },
          {
            label: 'Expenses',
            data: expensesData,
            backgroundColor: chartColors.expense,
            borderRadius: 6,
            barPercentage: 0.6,
            categoryPercentage: 0.5
          },
          {
            type: 'line',
            label: 'Net Savings',
            data: netData,
            borderColor: chartColors.primary,
            backgroundColor: chartColors.primary,
            tension: 0.3,
            pointRadius: 3
          }
        ]
      },
      options: {
        indexAxis: 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Monthly Financial Trends',
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 14
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                label += fmtMoney(context.raw);
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { display: false },
            title: {
              display: true,
              text: 'Month',
              font: { weight: 'bold' }
            }
          },
          y: {
            beginAtZero: true,
            grid: { display: false },
            ticks: { font: { weight: 'bold' } }
          }
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
      if (row['Debit [D]'] && row['Bank Name']) {
        const bank = row['Bank Name'] || 'Unknown';
        bankData[bank] = (bankData[bank] || 0) + toCents(row['Debit [D]']);
      }
    });

    const sortedBanks = Object.fromEntries(
      Object.entries(bankData).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / 100]));
    
    creditCardSpendingChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(sortedBanks),
        datasets: [{
          label: 'Spending Amount ($)',
          data: Object.values(sortedBanks),
          backgroundColor: chartColors.palette,
          borderRadius: 8
        }]
      },
      options: {
        indexAxis: 'y', // Better for reading bank names
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Spending by Bank/Account',
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 14
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
                return `${context.label || ''}: ${fmtMoney(context.raw)} (${pct}%)`;
              }
            }
          }
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
      if (row['Debit [D]'] && row['Purchased By']) {
        const person = row['Purchased By'] || 'Unknown';
        personData[person] = (personData[person] || 0) + toCents(row['Debit [D]']);
      }
    });

    const sortedPersons = Object.fromEntries(
      Object.entries(personData).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / 100]));
    
    purchasedByTrendChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(sortedPersons),
        datasets: [{
          label: 'Total Spent ($)',
          data: Object.values(sortedPersons),
          backgroundColor: chartColors.palette,
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Spending Distribution by Person',
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 14
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((context.raw / total) * 100).toFixed(1) : '0.0';
                return `${context.label || ''}: ${fmtMoney(context.raw)} (${pct}%)`;
              }
            }
          }
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

  // Restore transactions saved from previous visits
  loadPersistedData();

  // Recurring transactions apply themselves once per month (duplicate-safe)
  applyRecurringTransactions(true);

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

  // Enter saves while editing a row inline (but not while typing in the category search)
  document.querySelector('#budgetTable tbody').addEventListener('keydown', (e) => {
    if (inlineEditIndex < 0) return;
    if (e.key === 'Enter' && !e.target.closest('.category-picker-panel')) {
      e.preventDefault();
      saveInlineEdit(inlineEditIndex);
    }
  });

  // Clicking the app name hard-refreshes: clears the offline cache, then reloads
  // fresh from the server (saved transactions and settings are untouched).
  const appTitle = document.querySelector('h1');
  appTitle.style.cursor = 'pointer';
  appTitle.title = 'Refresh Moneta';
  appTitle.addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) { /* cache API unavailable — plain reload still works */ }
    location.reload();
  });

  // Press Enter anywhere in the entry form to add the transaction
  document.querySelector('.controls .grid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT' &&
        !e.target.closest('.category-picker-btn, .category-picker-panel')) {
      e.preventDefault();
      addEntry();
    }
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

  // Mirror tooltips as accessible names for icon-only buttons
  document.querySelectorAll('.action-btn[data-tooltip]').forEach(btn => {
    if (!btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', btn.dataset.tooltip);
  });

  renderTable();

  // Caching is disabled: every visit loads fresh from the server.
  // Also clean up the service worker and caches left by earlier versions.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
  }
