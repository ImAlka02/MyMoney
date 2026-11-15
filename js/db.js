// =========================================================
// Capa de datos — IndexedDB
// Stores: transactions, categories, budgets, settings
// =========================================================

const DB_NAME = 'mymoney';
const DB_VERSION = 2; // v2: presupuestos

export const DEFAULT_CATEGORIES = [
  // Ingresos
  { name: 'Salario',        color: '#4F7942', type: 'income' },
  { name: 'Ventas',         color: '#3B6E8F', type: 'income' },
  { name: 'Freelance',      color: '#8E5A9B', type: 'income' },
  { name: 'Regalos',        color: '#C07A9A', type: 'income' },
  // Gastos
  { name: 'Comida',         color: '#C0623B', type: 'expense' },
  { name: 'Transporte',     color: '#3B6E8F', type: 'expense' },
  { name: 'Hogar',          color: '#6B5B95', type: 'expense' },
  { name: 'Servicios',      color: '#2F8F83', type: 'expense' },
  { name: 'Salud',          color: '#B5485D', type: 'expense' },
  { name: 'Entretenimiento',color: '#D08C3A', type: 'expense' },
  { name: 'Compras',        color: '#5A7D9A', type: 'expense' },
  // Ambos
  { name: 'Otros',          color: '#7A7873', type: 'both' },
];

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = event.target.transaction;

      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
        s.createIndex('categoryId', 'categoryId');
        s.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('categories')) {
        const c = db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        c.createIndex('type', 'type');
        const now = Date.now();
        DEFAULT_CATEGORIES.forEach((cat, i) =>
          tx.objectStore('categories').add({ ...cat, isDefault: true, createdAt: now + i })
        );
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('budgets')) {
        const b = db.createObjectStore('budgets', { keyPath: 'id', autoIncrement: true });
        b.createIndex('categoryId', 'categoryId');
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB bloqueada por otra pestaña');
  });
  return dbPromise;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return promisify((await store(name)).getAll());
}

export async function get(name, id) {
  return promisify((await store(name)).get(id));
}

export async function put(name, value) {
  const s = await store(name, 'readwrite');
  const id = await promisify(s.put(value));
  await txDone(s.transaction);
  return id;
}

export async function remove(name, id) {
  const s = await store(name, 'readwrite');
  s.delete(id);
  await txDone(s.transaction);
}

// --- Settings ---
export async function getSetting(key, fallback = null) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return put('settings', { key, value });
}

// --- Operaciones compuestas ---

/** Elimina un presupuesto y desvincula los gastos que lo usaban (los gastos no se borran). */
export async function deleteBudget(id) {
  const db = await openDB();
  const tx = db.transaction(['budgets', 'transactions'], 'readwrite');
  tx.objectStore('transactions').openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    if (cursor.value.budgetId === id) cursor.update({ ...cursor.value, budgetId: null });
    cursor.continue();
  };
  tx.objectStore('budgets').delete(id);
  await txDone(tx);
}

/** Elimina una categoría y deja sus movimientos como "Sin categoría". */
export async function deleteCategory(id) {
  const db = await openDB();
  const tx = db.transaction(['categories', 'transactions'], 'readwrite');
  const txStore = tx.objectStore('transactions');
  const idx = txStore.index('categoryId');
  idx.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      cursor.update({ ...cursor.value, categoryId: null });
      cursor.continue();
    }
  };
  tx.objectStore('categories').delete(id);
  await txDone(tx);
}

/** Exporta toda la base a un objeto plano. */
export async function exportAll() {
  const [transactions, categories, budgets, settings] = await Promise.all([
    getAll('transactions'), getAll('categories'), getAll('budgets'), getAll('settings'),
  ]);
  return { app: 'MyMoney', version: 2, exportedAt: new Date().toISOString(), categories, transactions, budgets, settings };
}

/** Reemplaza toda la base con los datos importados. */
export async function importAll(data) {
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.transactions)) {
    throw new Error('El archivo no es un respaldo válido de MyMoney.');
  }
  const db = await openDB();
  const tx = db.transaction(['categories', 'transactions', 'budgets', 'settings'], 'readwrite');
  const cats = tx.objectStore('categories');
  const txs = tx.objectStore('transactions');
  const buds = tx.objectStore('budgets');
  const sets = tx.objectStore('settings');
  cats.clear(); txs.clear(); buds.clear(); sets.clear();
  data.categories.forEach((c) => cats.put(c));
  data.transactions.forEach((t) => txs.put(t));
  (data.budgets || []).forEach((b) => buds.put(b)); // los respaldos v1 no traen presupuestos
  (data.settings || []).forEach((s) => sets.put(s));
  await txDone(tx);
}

/** Borra movimientos, presupuestos y categorías personalizadas; restaura las predeterminadas. */
export async function resetAll() {
  const db = await openDB();
  const tx = db.transaction(['categories', 'transactions', 'budgets'], 'readwrite');
  const cats = tx.objectStore('categories');
  tx.objectStore('transactions').clear();
  tx.objectStore('budgets').clear();
  cats.clear();
  const now = Date.now();
  DEFAULT_CATEGORIES.forEach((cat, i) => cats.add({ ...cat, isDefault: true, createdAt: now + i }));
  await txDone(tx);
}
