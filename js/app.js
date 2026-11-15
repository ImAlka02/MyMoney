// =========================================================
// MyMoney — lógica de la aplicación
// =========================================================
import * as DB from './db.js';

const UNCATEGORIZED = { id: null, name: 'Sin categoría', color: '#8A8884', type: 'both' };
const PALETTE = [
  '#C0623B', '#D08C3A', '#B8913E', '#4F7942', '#2F8F83', '#3B6E8F', '#5A7D9A',
  '#6B5B95', '#8E5A9B', '#C07A9A', '#B5485D', '#7A5C45', '#7A7873', '#2B2B2B',
];
const VIEW_TITLES = { dashboard: 'Resumen', transactions: 'Movimientos', categories: 'Categorías', budgets: 'Presupuestos', settings: 'Ajustes' };
const MONTH_VIEWS = ['dashboard', 'transactions', 'budgets'];

const state = {
  view: 'dashboard',
  month: monthKey(new Date()),
  currency: 'MXN',
  categories: [],
  transactions: [],
  budgets: [],
  catMap: new Map(),
  breakdownType: 'expense',
  filterType: 'all',
  filterCat: 'all',
  search: '',
  catTab: 'expense',
  // diálogo de movimiento
  editingTx: null,
  txType: 'expense',
  txCategoryId: null,
  // diálogo de categoría
  editingCat: null,
  catType: 'expense',
  catColor: PALETTE[0],
  txBudgetId: null,
  catReturn: null,    // 'tx' cuando la categoría se crea desde el diálogo de movimiento
  // diálogo de presupuesto
  editingBudget: null,
  budgetColor: PALETTE[2],
  budgetPeriod: 'monthly',
  budgetReturn: null, // 'tx' cuando el presupuesto se crea desde el diálogo de movimiento
};

// ---------- Utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function pad(n) { return String(n).padStart(2, '0'); }

function monthKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDate(str) { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d || 1); }

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let formatter = null;
function makeFormatter() {
  try {
    formatter = new Intl.NumberFormat('es-MX', { style: 'currency', currency: state.currency, minimumFractionDigits: 2 });
  } catch {
    formatter = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
const fmt = (cents) => formatter.format(cents / 100);
function currencySymbol() {
  const part = formatter.formatToParts(0).find((p) => p.type === 'currency');
  return part ? part.value : '$';
}

/** Convierte "1,234.50" o "1234,5" a centavos enteros. */
function parseAmount(raw) {
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Color de texto legible sobre un fondo dado. */
function textOn(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#111111' : '#FFFFFF';
}

const initial = (name) => (Array.from(name.trim())[0] || '?').toUpperCase();
const getCat = (id) => state.catMap.get(id) || UNCATEGORIZED;
const catFits = (cat, type) => cat.type === type || cat.type === 'both';

function sortTx(list) {
  return list.sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
}

/** Ajusta el ancho del input de monto a su contenido para que "$" quede pegado al número. */
function autosizeAmount(input) {
  let m = document.querySelector('.amount-measure');
  if (!m) {
    m = document.createElement('span');
    m.className = 'amount-measure';
    m.setAttribute('aria-hidden', 'true');
    document.body.appendChild(m);
  }
  m.textContent = input.value || input.placeholder || '0';
  input.style.width = `${Math.ceil(m.getBoundingClientRect().width) + 4}px`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function confirmDialog(title, text, okLabel = 'Confirmar') {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

// ---------- Datos ----------
async function loadData() {
  const [categories, transactions, budgets] = await Promise.all([
    DB.getAll('categories'), DB.getAll('transactions'), DB.getAll('budgets'),
  ]);
  state.categories = categories.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  state.catMap = new Map(categories.map((c) => [c.id, c]));
  state.transactions = sortTx(transactions);
  state.budgets = budgets.sort((a, b) =>
    (a.period === b.period ? 0 : a.period === 'monthly' ? -1 : 1) ||
    budgetLabel(a).localeCompare(budgetLabel(b), 'es'));
}

// ---------- Presupuestos ----------
// Un presupuesto tiene nombre y color propios; los gastos se vinculan a él con `budgetId`.
// (Los presupuestos creados con la versión anterior traían `categoryId`: se usa como respaldo
//  para mostrar nombre y color.)
const legacyCat = (b) => (b.categoryId != null && state.catMap.has(b.categoryId) ? state.catMap.get(b.categoryId) : null);
const budgetLabel = (b) => b.name || legacyCat(b)?.name || 'Presupuesto';
const budgetColor = (b) => b.color || legacyCat(b)?.color || '#B8913E';
const budgetById = (id) => (id == null ? null : state.budgets.find((b) => b.id === id) || null);

/** Presupuestos a los que se puede asignar un gasto con esa fecha. */
function budgetsAt(date) {
  return state.budgets.filter((b) => b.period === 'monthly' || (date >= b.start && date <= b.end));
}

/** Rango de fechas [desde, hasta] que cubre el presupuesto para un mes dado. */
function budgetRange(b, month = state.month) {
  if (b.period === 'range') return [b.start, b.end];
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, `${month}-${pad(new Date(y, m, 0).getDate())}`];
}

/** Cuánto se ha gastado de un presupuesto (gastos vinculados a él dentro del rango). */
function budgetStatus(b, month = state.month) {
  const [from, to] = budgetRange(b, month);
  let spent = 0, count = 0;
  for (const t of state.transactions) {
    if (t.type === 'expense' && t.budgetId === b.id && t.date >= from && t.date <= to) { spent += t.amount; count++; }
  }
  const remaining = b.amount - spent;
  const pct = b.amount ? (spent / b.amount) * 100 : 0;
  return { from, to, spent, count, remaining, pct, level: pct > 100 ? 'over' : pct >= 80 ? 'warn' : 'ok' };
}

/** Presupuestos que aplican al mes visible (mensuales + por fechas que se cruzan con el mes). */
function budgetsForMonth(month = state.month) {
  const [from, to] = budgetRange({ period: 'monthly' }, month);
  return state.budgets.filter((b) => b.period === 'monthly' || (b.start <= to && b.end >= from));
}

function shortDate(str) {
  return parseDate(str).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

function periodLabel(b) {
  return b.period === 'monthly' ? 'Mensual' : `${shortDate(b.start)} – ${shortDate(b.end)}`;
}

function monthTransactions() {
  return state.transactions.filter((t) => t.date.startsWith(state.month));
}

function totals(list) {
  let income = 0, expense = 0;
  for (const t of list) t.type === 'income' ? (income += t.amount) : (expense += t.amount);
  return { income, expense, net: income - expense };
}

// ---------- Render ----------
function renderAll() {
  renderMonth();
  renderDashboard();
  renderTransactions();
  renderCategories();
  renderBudgets();
}

function budgetItemHTML(b, extraClass = '') {
  const color = budgetColor(b);
  const name = budgetLabel(b);
  const st = budgetStatus(b);
  return `
    <div class="budget-item level-${st.level} ${extraClass}" data-budget="${b.id}" style="--c:${color}" tabindex="0">
      <div class="budget-top">
        <div class="tx-avatar" style="background:${color};color:${textOn(color)}">${escapeHTML(initial(name))}</div>
        <div class="budget-info">
          <div class="tx-title">${escapeHTML(name)}</div>
          <div class="tx-meta"><span>${periodLabel(b)}</span><span>·</span><span>${st.count} ${st.count === 1 ? 'gasto' : 'gastos'}</span></div>
        </div>
        <div class="budget-remaining">
          <strong>${fmt(Math.abs(st.remaining))}</strong>
          <small>${st.remaining >= 0 ? 'disponible' : 'excedido'}</small>
        </div>
      </div>
      <div class="budget-bar"><i style="width:${Math.min(st.pct, 100)}%"></i></div>
      <div class="budget-foot"><span>Gastado ${fmt(st.spent)} de ${fmt(b.amount)}</span><span>${Math.round(st.pct)}%</span></div>
    </div>`;
}

function renderBudgets() {
  const list = budgetsForMonth();

  // Tarjeta del resumen
  $('#dash-budgets').innerHTML = list.length
    ? list.map((b) => budgetItemHTML(b)).join('')
    : emptyHTML('Sin presupuestos para este mes', 'Crea uno en la sección Presupuestos.');

  // Vista de presupuestos
  let total = 0, spent = 0;
  for (const b of list) { total += b.amount; spent += budgetStatus(b).spent; }
  const left = total - spent;
  $('#budget-overview').innerHTML = list.length ? `
    <div><span class="eyebrow">Presupuestado</span><strong>${fmt(total)}</strong></div>
    <div><span class="eyebrow">Gastado</span><strong>${fmt(spent)}</strong></div>
    <div><span class="eyebrow">${left >= 0 ? 'Disponible' : 'Excedido'}</span><strong class="${left < 0 ? 'over' : ''}">${fmt(Math.abs(left))}</strong></div>` : '';
  $('#budget-list').innerHTML = list.length
    ? list.map((b) => budgetItemHTML(b, 'card')).join('')
    : `<div class="card" style="grid-column:1/-1">${emptyHTML('Aún no tienes presupuestos', 'Crea uno y, al registrar un gasto, elige a qué presupuesto pertenece para que se vaya restando.')}</div>`;
}

function renderMonth() {
  const label = parseDate(state.month).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  $('#month-label').textContent = label.charAt(0).toUpperCase() + label.slice(1);
}

function txItemHTML(t, { showDate = false } = {}) {
  const cat = getCat(t.categoryId);
  const sign = t.type === 'income' ? '+' : '−';
  const date = showDate ? `<span>${parseDate(t.date).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</span>` : '';
  const budget = t.type === 'expense' ? budgetById(t.budgetId) : null;
  const budgetTag = budget
    ? `<span class="budget-tag" style="--c:${budgetColor(budget)}"><svg viewBox="0 0 24 24"><path d="M21 12A9 9 0 1 1 12 3v9z"/></svg>${escapeHTML(budgetLabel(budget))}</span>`
    : '';
  return `
    <li class="tx-item" data-id="${t.id}" style="--c:${cat.color};border-left-color:${cat.color}" tabindex="0">
      <div class="tx-avatar" style="background:${cat.color};color:${textOn(cat.color)}">${escapeHTML(initial(cat.name))}</div>
      <div class="tx-main">
        <div class="tx-title">${escapeHTML(t.note || cat.name)}</div>
        <div class="tx-meta"><span class="cat-chip" style="--c:${cat.color}">${escapeHTML(cat.name)}</span>${budgetTag}${date}</div>
      </div>
      <div class="tx-amount ${t.type}">${sign}${fmt(t.amount)}<small>${t.type === 'income' ? 'Ingreso' : 'Gasto'}</small></div>
    </li>`;
}

function emptyHTML(title, sub) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 12h6M12 9v6"/></svg>
    <p><strong>${title}</strong></p>${sub ? `<p>${sub}</p>` : ''}</div>`;
}

function renderDashboard() {
  const all = totals(state.transactions);
  const month = monthTransactions();
  const m = totals(month);

  const bal = $('#balance-total');
  bal.textContent = fmt(all.net);
  bal.classList.toggle('negative', all.net < 0);
  $('#month-income').textContent = fmt(m.income);
  $('#month-expense').textContent = fmt(m.expense);

  // Desglose por categoría
  const type = state.breakdownType;
  const list = month.filter((t) => t.type === type);
  const groups = new Map();
  for (const t of list) groups.set(t.categoryId, (groups.get(t.categoryId) || 0) + t.amount);
  const total = type === 'income' ? m.income : m.expense;
  const rows = [...groups.entries()].map(([id, amount]) => ({ cat: getCat(id), amount })).sort((a, b) => b.amount - a.amount);

  const box = $('#breakdown');
  if (!rows.length) {
    box.innerHTML = emptyHTML(type === 'income' ? 'Sin ingresos este mes' : 'Sin gastos este mes', 'Registra un movimiento para ver el desglose.');
    box.style.display = 'block';
  } else {
    box.style.display = '';
    let acc = 0;
    const stops = rows.map(({ cat, amount }) => {
      const from = (acc / total) * 360;
      acc += amount;
      const to = (acc / total) * 360;
      return `${cat.color} ${from}deg ${to}deg`;
    });
    box.innerHTML = `
      <div class="donut" style="background:conic-gradient(${stops.join(',')})">
        <div class="donut-center"><strong>${fmt(total)}</strong><span>${type === 'income' ? 'Ingresos' : 'Gastos'}</span></div>
      </div>
      <ul class="legend">
        ${rows.slice(0, 6).map(({ cat, amount }) => {
          const pct = Math.round((amount / total) * 100);
          return `<li>
            <div class="legend-row">
              <span class="legend-name"><span class="legend-swatch" style="background:${cat.color}"></span><span>${escapeHTML(cat.name)}</span></span>
              <span class="legend-val">${fmt(amount)}<small>${pct}%</small></span>
            </div>
            <div class="bar"><i style="width:${pct}%;background:${cat.color}"></i></div>
          </li>`;
        }).join('')}
        ${rows.length > 6 ? `<li class="muted" style="font-size:12px">+${rows.length - 6} categorías más</li>` : ''}
      </ul>`;
  }

  // Recientes
  const recent = month.slice(0, 6);
  $('#recent-list').innerHTML = recent.length
    ? recent.map((t) => txItemHTML(t, { showDate: true })).join('')
    : emptyHTML('Aún no hay movimientos este mes', 'Usa “Ingreso” o “Gasto” para empezar.');
}

function dayLabel(dateStr) {
  const today = todayStr();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  if (dateStr === today) return 'Hoy';
  if (dateStr === yesterday) return 'Ayer';
  return parseDate(dateStr).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' });
}

function renderTransactions() {
  // opciones del filtro de categorías
  const sel = $('#filter-category');
  const relevant = state.categories.filter((c) => state.filterType === 'all' || catFits(c, state.filterType));
  if (state.filterCat !== 'all' && state.filterCat !== 'none' && !relevant.some((c) => String(c.id) === state.filterCat)) state.filterCat = 'all';
  sel.innerHTML = `<option value="all">Todas las categorías</option>` +
    relevant.map((c) => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('') +
    `<option value="none">Sin categoría</option>`;
  sel.value = state.filterCat;

  const q = state.search.trim().toLowerCase();
  const list = monthTransactions().filter((t) => {
    if (state.filterType !== 'all' && t.type !== state.filterType) return false;
    if (state.filterCat === 'none' && t.categoryId != null && state.catMap.has(t.categoryId)) return false;
    if (state.filterCat !== 'all' && state.filterCat !== 'none' && String(t.categoryId) !== state.filterCat) return false;
    if (q) {
      const hay = `${t.note || ''} ${getCat(t.categoryId).name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tot = totals(list);
  $('#tx-summary').innerHTML = `
    <div class="card"><p class="eyebrow">Balance</p><strong>${fmt(tot.net)}</strong></div>
    <div class="card"><p class="eyebrow">Ingresos</p><strong class="gold">+${fmt(tot.income)}</strong></div>
    <div class="card"><p class="eyebrow">Gastos</p><strong>−${fmt(tot.expense)}</strong></div>`;

  if (!list.length) {
    $('#tx-groups').innerHTML = `<div class="card">${emptyHTML('No hay movimientos', q || state.filterType !== 'all' || state.filterCat !== 'all' ? 'Prueba con otros filtros.' : 'Registra tu primer ingreso o gasto de este mes.')}</div>`;
    return;
  }

  const byDay = new Map();
  for (const t of list) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t);
  }
  $('#tx-groups').innerHTML = [...byDay.entries()].map(([date, items]) => {
    const net = totals(items).net;
    return `<div class="tx-group">
      <div class="tx-group-head"><strong>${dayLabel(date)}</strong><span>${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</span></div>
      <div class="card"><ul class="tx-list">${items.map((t) => txItemHTML(t)).join('')}</ul></div>
    </div>`;
  }).join('');
}

function renderCategories() {
  const tab = state.catTab;
  const usage = new Map();
  for (const t of state.transactions) {
    if (t.type !== tab) continue;
    const u = usage.get(t.categoryId) || { count: 0, amount: 0 };
    u.count++; u.amount += t.amount;
    usage.set(t.categoryId, u);
  }
  const cats = state.categories.filter((c) => catFits(c, tab));
  $('#cat-grid').innerHTML = cats.map((c) => {
    const u = usage.get(c.id) || { count: 0, amount: 0 };
    return `<button class="card cat-card" data-cat="${c.id}" style="--cat:${c.color}">
      <div class="tx-avatar" style="background:${c.color};color:${textOn(c.color)}">${escapeHTML(initial(c.name))}</div>
      <div class="cat-info">
        <h3>${escapeHTML(c.name)}${c.type === 'both' ? '<span class="badge">Ambos</span>' : ''}</h3>
        <p>${u.count} ${u.count === 1 ? 'movimiento' : 'movimientos'}</p>
      </div>
      <span class="cat-total">${fmt(u.amount)}</span>
    </button>`;
  }).join('') || `<div class="card">${emptyHTML('Sin categorías', 'Crea una nueva categoría.')}</div>`;
}

// ---------- Navegación ----------
function setView(view, push = true) {
  if (!VIEW_TITLES[view]) view = 'dashboard';
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-title').textContent = VIEW_TITLES[view];
  $('#month-picker').hidden = !MONTH_VIEWS.includes(view);
  if (push && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  window.scrollTo({ top: 0 });
}

function shiftMonth(delta) {
  const d = parseDate(state.month);
  d.setMonth(d.getMonth() + delta);
  state.month = monthKey(d);
  renderAll();
}

function setSegmented(container, attr, value) {
  $$(`button`, container).forEach((b) => b.classList.toggle('active', b.dataset[attr] === value));
}

// ---------- Diálogo de movimiento ----------
function openTxDialog({ type = 'expense', tx = null } = {}) {
  state.editingTx = tx;
  state.txType = tx ? tx.type : type;
  state.txCategoryId = tx ? tx.categoryId : null;
  state.txBudgetId = tx?.budgetId ?? null;

  $('#tx-dialog-title').textContent = tx ? 'Editar movimiento' : txTitle();
  $('#tx-amount').value = tx ? (tx.amount / 100).toFixed(2) : '';
  $('#tx-date').value = tx ? tx.date : (state.month === monthKey(new Date()) ? todayStr() : `${state.month}-01`);
  $('#tx-note').value = tx?.note || '';
  $('#tx-currency').textContent = currencySymbol();
  $('#tx-error').textContent = '';
  $('#tx-delete').hidden = !tx;
  setSegmented($('#tx-type'), 'type', state.txType);
  renderTxCategories();
  renderTxBudgets();
  autosizeAmount($('#tx-amount'));

  $('#tx-dialog').showModal();
  if (!matchMedia('(pointer: coarse)').matches) $('#tx-amount').focus();
}

const txTitle = () => (state.txType === 'income' ? 'Nuevo ingreso' : 'Nuevo gasto');

/** Botones de categoría (chips) con colores; se usan en movimientos y presupuestos. */
function chipsHTML(cats, selectedId) {
  return cats.map((c) => `
    <button type="button" class="chip-option ${c.id === selectedId ? 'selected' : ''}" data-id="${c.id}" style="--chip:${c.color}">
      <i style="background:${c.color}"></i>${escapeHTML(c.name)}
    </button>`).join('') + `
    <button type="button" class="chip-option add" data-add>
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Nueva
    </button>`;
}

function renderTxCategories() {
  const cats = state.categories.filter((c) => catFits(c, state.txType));
  if (state.txCategoryId != null && !cats.some((c) => c.id === state.txCategoryId)) state.txCategoryId = null;
  $('#tx-categories').innerHTML = chipsHTML(cats, state.txCategoryId);
}

/** Selector opcional de presupuesto: solo para gastos y solo presupuestos vigentes en la fecha. */
function renderTxBudgets() {
  const field = $('#tx-budget-field');
  const date = $('#tx-date').value;
  if (state.txType !== 'expense') { field.hidden = true; return; }
  field.hidden = false;

  const list = date ? budgetsAt(date) : state.budgets;
  if (state.txBudgetId != null && !list.some((b) => b.id === state.txBudgetId)) state.txBudgetId = null;

  $('#tx-budgets').innerHTML = `
    <button type="button" class="chip-option none ${state.txBudgetId == null ? 'selected' : ''}" data-id="">Ninguno</button>` +
    list.map((b) => {
      const color = budgetColor(b);
      return `<button type="button" class="chip-option ${b.id === state.txBudgetId ? 'selected' : ''}" data-id="${b.id}" style="--chip:${color}">
        <i style="background:${color}"></i>${escapeHTML(budgetLabel(b))}
      </button>`;
    }).join('') + `
    <button type="button" class="chip-option add" data-add>
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Nuevo
    </button>`;
  renderBudgetHint();
}

/** Muestra cuánto queda en el presupuesto elegido y cómo queda tras este gasto. */
function renderBudgetHint() {
  const box = $('#tx-budget-hint');
  const date = $('#tx-date').value;
  const b = budgetById(state.txBudgetId);
  if (state.txType !== 'expense' || !b || !date) { box.hidden = true; return; }

  const amount = parseAmount($('#tx-amount').value) || 0;
  const st = budgetStatus(b, date.slice(0, 7));
  let spent = st.spent;
  // Al editar, no contar dos veces el monto original de este mismo gasto
  const editing = state.editingTx;
  if (editing && editing.type === 'expense' && editing.budgetId === b.id &&
      editing.date >= st.from && editing.date <= st.to) spent -= editing.amount;
  const available = b.amount - spent;
  const after = available - amount;
  const pct = Math.min(((spent + amount) / b.amount) * 100, 100);
  const afterTxt = amount > 0
    ? (after >= 0 ? `Después de este gasto quedarán <b>${fmt(after)}</b>.`
                  : `<span class="over">Excederás el presupuesto por ${fmt(-after)}.</span>`)
    : '';
  box.style.setProperty('--c', budgetColor(b));
  box.innerHTML = `
    <div><b>${escapeHTML(budgetLabel(b))}</b> · ${available >= 0 ? `disponible ${fmt(available)}` : `<span class="over">excedido por ${fmt(-available)}</span>`} de ${fmt(b.amount)}</div>
    ${afterTxt ? `<div>${afterTxt}</div>` : ''}
    <div class="budget-bar"><i style="width:${pct}%;${after < 0 ? 'background:var(--danger)' : ''}"></i></div>`;
  box.hidden = false;
}

async function saveTx(e) {
  e.preventDefault();
  const err = $('#tx-error');
  const amount = parseAmount($('#tx-amount').value);
  const date = $('#tx-date').value;
  if (!(amount > 0)) { err.textContent = 'Ingresa un monto mayor a 0.'; $('#tx-amount').focus(); return; }
  if (state.txCategoryId == null) { err.textContent = 'Elige una categoría.'; return; }
  if (!date) { err.textContent = 'Elige una fecha.'; return; }

  const tx = {
    ...(state.editingTx || { createdAt: Date.now() }),
    type: state.txType,
    amount,
    categoryId: state.txCategoryId,
    budgetId: state.txType === 'expense' ? state.txBudgetId : null, // solo los gastos usan presupuesto
    date,
    note: $('#tx-note').value.trim(),
    updatedAt: Date.now(),
  };
  await DB.put('transactions', tx);
  $('#tx-dialog').close();
  await loadData();
  // Si el movimiento cae en otro mes, navega a ese mes para que se vea
  if (!date.startsWith(state.month)) state.month = date.slice(0, 7);
  renderAll();

  let msg = state.editingTx ? 'Movimiento actualizado' : (tx.type === 'income' ? 'Ingreso registrado' : 'Gasto registrado');
  const linked = budgetById(tx.budgetId);
  if (linked && budgetStatus(linked, date.slice(0, 7)).remaining < 0) msg += ` · Excediste “${budgetLabel(linked)}”`;
  toast(msg);
}

// ---------- Diálogo de presupuesto ----------
function openBudgetDialog({ budget = null, returnTo = null } = {}) {
  state.editingBudget = budget;
  state.budgetColor = budget ? budgetColor(budget) : PALETTE[Math.floor(Math.random() * PALETTE.length)];
  state.budgetPeriod = budget ? budget.period : 'monthly';
  state.budgetReturn = returnTo;

  const [, monthEnd] = budgetRange({ period: 'monthly' }, monthKey(new Date()));
  $('#budget-dialog-title').textContent = budget ? 'Editar presupuesto' : 'Nuevo presupuesto';
  $('#budget-amount').value = budget ? (budget.amount / 100).toFixed(2) : '';
  $('#budget-name').value = budget ? budgetLabel(budget) : '';
  $('#budget-start').value = budget?.start || todayStr();
  $('#budget-end').value = budget?.end || monthEnd;
  $('#budget-currency').textContent = currencySymbol();
  $('#budget-error').textContent = '';
  $('#budget-delete').hidden = !budget;
  renderSwatches('#budget-swatches', state.budgetColor);
  setBudgetPeriod(state.budgetPeriod);
  autosizeAmount($('#budget-amount'));

  $('#budget-dialog').showModal();
  if (!matchMedia('(pointer: coarse)').matches) $('#budget-amount').focus();
}

function setBudgetPeriod(period) {
  state.budgetPeriod = period;
  setSegmented($('#budget-period'), 'period', period);
  $('#budget-range').hidden = period !== 'range';
  $('#budget-period-help').textContent = period === 'monthly'
    ? 'Se reinicia cada mes: se restan los gastos que asignes a este presupuesto en ese mes.'
    : 'Se restan los gastos que asignes a este presupuesto entre estas fechas.';
}

async function saveBudget(e) {
  e.preventDefault();
  const err = $('#budget-error');
  const amount = parseAmount($('#budget-amount').value);
  const period = state.budgetPeriod;
  const start = $('#budget-start').value;
  const end = $('#budget-end').value;
  const name = $('#budget-name').value.trim();
  if (!(amount > 0)) { err.textContent = 'Ingresa un monto mayor a 0.'; $('#budget-amount').focus(); return; }
  if (!name) { err.textContent = 'Escribe un nombre para el presupuesto.'; $('#budget-name').focus(); return; }
  if (state.budgets.some((b) => b.id !== state.editingBudget?.id && budgetLabel(b).toLowerCase() === name.toLowerCase())) {
    err.textContent = 'Ya existe un presupuesto con ese nombre.';
    return;
  }
  if (period === 'range' && (!start || !end)) { err.textContent = 'Elige las fechas de inicio y fin.'; return; }
  if (period === 'range' && start > end) { err.textContent = 'La fecha final debe ser posterior a la inicial.'; return; }

  const { categoryId, ...base } = state.editingBudget || { createdAt: Date.now() }; // ya no se usa categoryId
  const budget = {
    ...base,
    name,
    color: state.budgetColor,
    amount,
    period,
    start: period === 'range' ? start : null,
    end: period === 'range' ? end : null,
    updatedAt: Date.now(),
  };
  const id = await DB.put('budgets', budget);
  $('#budget-dialog').close();
  await loadData();

  // Si se creó desde el formulario de gasto, se deja seleccionado ahí
  if (state.budgetReturn === 'tx') {
    state.txBudgetId = id;
    renderTxBudgets();
  }
  renderAll();
  toast(state.editingBudget ? 'Presupuesto actualizado' : 'Presupuesto creado');
}

async function deleteBudget() {
  const b = state.editingBudget;
  if (!b) return;
  const linked = state.transactions.filter((t) => t.budgetId === b.id).length;
  const ok = await confirmDialog('Eliminar presupuesto',
    `Se eliminará el presupuesto “${budgetLabel(b)}”.` +
    (linked === 1 ? ' Su gasto vinculado se conserva; solo quedará sin presupuesto.'
      : linked > 1 ? ` Sus ${linked} gastos vinculados se conservan; solo quedarán sin presupuesto.` : ''),
    'Eliminar');
  if (!ok) return;
  await DB.deleteBudget(b.id);
  $('#budget-dialog').close();
  await loadData();
  renderAll();
  toast('Presupuesto eliminado');
}

async function deleteTx() {
  const tx = state.editingTx;
  if (!tx) return;
  const ok = await confirmDialog('Eliminar movimiento', `Se eliminará este ${tx.type === 'income' ? 'ingreso' : 'gasto'} de ${fmt(tx.amount)}. Esta acción no se puede deshacer.`, 'Eliminar');
  if (!ok) return;
  await DB.remove('transactions', tx.id);
  $('#tx-dialog').close();
  await loadData();
  renderAll();
  toast('Movimiento eliminado');
}

// ---------- Diálogo de categoría ----------
function openCatDialog({ cat = null, type = 'expense', returnTo = null } = {}) {
  state.editingCat = cat;
  state.catType = cat ? cat.type : type;
  state.catColor = cat ? cat.color : PALETTE[Math.floor(Math.random() * PALETTE.length)];
  state.catReturn = returnTo;

  $('#cat-dialog-title').textContent = cat ? 'Editar categoría' : 'Nueva categoría';
  $('#cat-name').value = cat?.name || '';
  $('#cat-error').textContent = '';
  $('#cat-delete').hidden = !cat;
  setSegmented($('#cat-type'), 'type', state.catType);
  renderSwatches();
  updateCatPreview();
  $('#cat-dialog').showModal();
  if (!matchMedia('(pointer: coarse)').matches) $('#cat-name').focus();
}

/** Paleta de colores + selector personalizado (categorías y presupuestos). */
function renderSwatches(sel = '#cat-swatches', color = state.catColor) {
  const custom = !PALETTE.some((c) => c.toLowerCase() === color.toLowerCase());
  $(sel).innerHTML = PALETTE.map((c) =>
    `<button type="button" class="swatch ${c.toLowerCase() === color.toLowerCase() ? 'selected' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`
  ).join('') + `
    <label class="swatch-custom ${custom ? 'selected' : ''}" title="Color personalizado" ${custom ? `style="background:${color}"` : ''}>
      <input type="color" value="${color}" aria-label="Color personalizado">
    </label>`;
}

/** Conecta clics en la paleta y el selector personalizado; onPick recibe el color elegido. */
function bindSwatches(sel, onPick) {
  const box = $(sel);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    onPick(b.dataset.color);
    $$('.swatch', box).forEach((s) => s.classList.toggle('selected', s === b));
    const lbl = $('.swatch-custom', box);
    lbl.classList.remove('selected');
    lbl.style.background = '';
  });
  box.addEventListener('input', (e) => {
    if (e.target.type !== 'color') return;
    onPick(e.target.value);
    $$('.swatch', box).forEach((s) => s.classList.remove('selected'));
    const lbl = e.target.parentElement;
    lbl.classList.add('selected');
    lbl.style.background = e.target.value;
  });
}

function updateCatPreview() {
  const el = $('#cat-preview');
  el.textContent = $('#cat-name').value.trim() || 'Categoría';
  el.style.setProperty('--c', state.catColor);
}

async function saveCat(e) {
  e.preventDefault();
  const err = $('#cat-error');
  const name = $('#cat-name').value.trim();
  if (!name) { err.textContent = 'Escribe un nombre.'; $('#cat-name').focus(); return; }
  const dup = state.categories.find((c) =>
    c.id !== state.editingCat?.id && c.name.toLowerCase() === name.toLowerCase() &&
    (c.type === state.catType || c.type === 'both' || state.catType === 'both'));
  if (dup) { err.textContent = 'Ya existe una categoría con ese nombre.'; return; }

  const cat = {
    ...(state.editingCat || { createdAt: Date.now(), isDefault: false }),
    name,
    type: state.catType,
    color: state.catColor,
  };
  const id = await DB.put('categories', cat);
  $('#cat-dialog').close();
  await loadData();

  if (state.catReturn === 'tx') {
    if (catFits(cat, state.txType)) state.txCategoryId = id;
    renderTxCategories();
  }
  renderAll();
  toast(state.editingCat ? 'Categoría actualizada' : 'Categoría creada');
}

async function deleteCat() {
  const cat = state.editingCat;
  if (!cat) return;
  const used = state.transactions.filter((t) => t.categoryId === cat.id).length;
  const msg = used
    ? `“${cat.name}” se usa en ${used} ${used === 1 ? 'movimiento' : 'movimientos'}. Quedarán como “Sin categoría”.`
    : `Se eliminará la categoría “${cat.name}”.`;
  const ok = await confirmDialog('Eliminar categoría', msg, 'Eliminar');
  if (!ok) return;
  await DB.deleteCategory(cat.id);
  $('#cat-dialog').close();
  await loadData();
  renderAll();
  toast('Categoría eliminada');
}

// ---------- Ajustes ----------
function applyTheme(pref) {
  try { localStorage.setItem('mm-theme', pref); } catch { /* sin almacenamiento */ }
  const resolved = pref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = resolved === 'dark' ? '#0D0D0D' : '#111111';
  setSegmented($('#set-theme'), 'theme', pref);
}
function currentThemePref() {
  try { return localStorage.getItem('mm-theme') || 'system'; } catch { return 'system'; }
}

async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mymoney-respaldo-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Respaldo exportado');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'MyMoney') throw new Error('El archivo no es un respaldo de MyMoney.');
    const ok = await confirmDialog('Importar respaldo',
      `Se reemplazarán tus datos actuales con ${data.transactions.length} movimientos y ${data.categories.length} categorías del respaldo.`, 'Importar');
    if (!ok) return;
    await DB.importAll(data);
    state.currency = await DB.getSetting('currency', 'MXN');
    $('#set-currency').value = state.currency;
    makeFormatter();
    await loadData();
    renderAll();
    toast('Respaldo importado');
  } catch (err) {
    toast(err.message || 'No se pudo importar el archivo');
  }
}

// ---------- Eventos ----------
function bindEvents() {
  // Navegación
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)));
  window.addEventListener('popstate', () => setView(location.hash.slice(1) || 'dashboard', false));

  // Acciones rápidas
  $$('[data-action="new-income"]').forEach((b) => b.addEventListener('click', () => openTxDialog({ type: 'income' })));
  $$('[data-action="new-expense"]').forEach((b) => b.addEventListener('click', () => openTxDialog({ type: 'expense' })));
  $('#fab').addEventListener('click', () => openTxDialog({ type: 'expense' }));

  // Mes
  $('#month-prev').addEventListener('click', () => shiftMonth(-1));
  $('#month-next').addEventListener('click', () => shiftMonth(1));
  $('#month-label').addEventListener('click', () => { state.month = monthKey(new Date()); renderAll(); });

  // Desglose
  $('#breakdown-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.breakdownType = b.dataset.type;
    setSegmented(e.currentTarget, 'type', state.breakdownType);
    renderDashboard();
  });

  // Abrir movimiento al hacer clic en la lista
  const openFromList = (e) => {
    const li = e.target.closest('.tx-item'); if (!li) return;
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    const tx = state.transactions.find((t) => t.id === Number(li.dataset.id));
    if (tx) openTxDialog({ tx });
  };
  ['#recent-list', '#tx-groups'].forEach((sel) => {
    $(sel).addEventListener('click', openFromList);
    $(sel).addEventListener('keydown', openFromList);
  });

  // Filtros
  $('#filter-type').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.filterType = b.dataset.type;
    setSegmented(e.currentTarget, 'type', state.filterType);
    renderTransactions();
  });
  $('#filter-category').addEventListener('change', (e) => { state.filterCat = e.target.value; renderTransactions(); });
  $('#filter-search').addEventListener('input', (e) => { state.search = e.target.value; renderTransactions(); });

  // Categorías
  $('#cat-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.catTab = b.dataset.type;
    setSegmented(e.currentTarget, 'type', state.catTab);
    renderCategories();
  });
  $('#btn-new-category').addEventListener('click', () => openCatDialog({ type: state.catTab }));
  $('#cat-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-cat]'); if (!card) return;
    openCatDialog({ cat: state.catMap.get(Number(card.dataset.cat)) });
  });

  // Diálogo movimiento
  $('#tx-form').addEventListener('submit', saveTx);
  $('#tx-delete').addEventListener('click', deleteTx);
  $('#tx-type').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.txType = b.dataset.type;
    setSegmented(e.currentTarget, 'type', state.txType);
    if (!state.editingTx) $('#tx-dialog-title').textContent = txTitle();
    renderTxCategories();
    renderTxBudgets();
  });
  $('#tx-categories').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-add')) return openCatDialog({ type: state.txType, returnTo: 'tx' });
    state.txCategoryId = Number(b.dataset.id);
    $('#tx-error').textContent = '';
    $$('.chip-option', e.currentTarget).forEach((c) => c.classList.toggle('selected', c === b));
  });
  $('#tx-budgets').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-add')) return openBudgetDialog({ returnTo: 'tx' });
    state.txBudgetId = b.dataset.id ? Number(b.dataset.id) : null;
    $$('.chip-option', e.currentTarget).forEach((c) => c.classList.toggle('selected', c === b));
    renderBudgetHint();
  });
  $('#tx-amount').addEventListener('input', (e) => { autosizeAmount(e.target); renderBudgetHint(); });
  $('#budget-amount').addEventListener('input', (e) => autosizeAmount(e.target));
  $('#tx-date').addEventListener('change', renderTxBudgets);

  // Presupuestos
  $('#btn-new-budget').addEventListener('click', () => openBudgetDialog());
  const openBudgetFromList = (e) => {
    const item = e.target.closest('[data-budget]'); if (!item) return;
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    const budget = state.budgets.find((b) => b.id === Number(item.dataset.budget));
    if (budget) openBudgetDialog({ budget });
  };
  ['#budget-list', '#dash-budgets'].forEach((sel) => {
    $(sel).addEventListener('click', openBudgetFromList);
    $(sel).addEventListener('keydown', openBudgetFromList);
  });
  $('#budget-form').addEventListener('submit', saveBudget);
  $('#budget-delete').addEventListener('click', deleteBudget);
  $('#budget-period').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setBudgetPeriod(b.dataset.period);
  });
  bindSwatches('#budget-swatches', (color) => { state.budgetColor = color; });

  // Diálogo categoría
  $('#cat-form').addEventListener('submit', saveCat);
  $('#cat-delete').addEventListener('click', deleteCat);
  $('#cat-name').addEventListener('input', updateCatPreview);
  $('#cat-type').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.catType = b.dataset.type;
    setSegmented(e.currentTarget, 'type', state.catType);
  });
  bindSwatches('#cat-swatches', (color) => { state.catColor = color; updateCatPreview(); });

  // Cerrar diálogos (botones y clic en el fondo)
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  });

  // Ajustes
  $('#set-currency').addEventListener('change', async (e) => {
    state.currency = e.target.value;
    await DB.setSetting('currency', state.currency);
    makeFormatter();
    renderAll();
    toast('Moneda actualizada');
  });
  $('#set-theme').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    applyTheme(b.dataset.theme);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemePref() === 'system') applyTheme('system');
  });
  $('#btn-export').addEventListener('click', exportData);
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });
  $('#btn-reset').addEventListener('click', async () => {
    const ok = await confirmDialog('Borrar todos los datos',
      'Se eliminarán todos los movimientos, presupuestos y categorías personalizadas. Esta acción no se puede deshacer.', 'Borrar todo');
    if (!ok) return;
    await DB.resetAll();
    await loadData();
    renderAll();
    toast('Datos eliminados');
  });

  // Instalación PWA
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#install-card').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#install-card').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#install-card').hidden = true; });
}

// ---------- Inicio ----------
async function init() {
  try {
    await DB.openDB();
    state.currency = await DB.getSetting('currency', 'MXN');
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base de datos local');
    return;
  }
  makeFormatter();
  $('#set-currency').value = state.currency;
  applyTheme(currentThemePref());
  bindEvents();
  await loadData();
  renderAll();
  setView(location.hash.slice(1) || 'dashboard', false);

  // Atajos desde el ícono de la app (?action=income|expense)
  const action = new URLSearchParams(location.search).get('action');
  if (action === 'income' || action === 'expense') {
    history.replaceState(null, '', location.pathname + location.hash);
    openTxDialog({ type: action });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW no registrado', e));
  }
}

init();
