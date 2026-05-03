const _DB_FILENAME = 'image-search-db.json';
const _IDB_NAME = 'ImageSearchDB';
const _IDB_STORE = 'records';
const _IDB_VER = 1;

let _fsHandle = null;

function hasFolderAccess() { return !!_fsHandle; }
function getFolderName()   { return _fsHandle ? _fsHandle.name : null; }

async function openFolderPicker() {
  if (!('showDirectoryPicker' in window)) return false;
  try {
    _fsHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('openFolderPicker:', e);
    return false;
  }
}

async function _saveToFS(records) {
  if (!_fsHandle) return false;
  try {
    const fh = await _fsHandle.getFileHandle(_DB_FILENAME, { create: true });
    const wr = await fh.createWritable();
    await wr.write(JSON.stringify(records, null, 2));
    await wr.close();
    return true;
  } catch (e) {
    console.error('FS save error:', e);
    return false;
  }
}

async function _loadFromFS() {
  if (!_fsHandle) return null;
  try {
    const fh = await _fsHandle.getFileHandle(_DB_FILENAME);
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch { return null; }
}

function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE, { keyPath: 'filename' });
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = () => reject(req.error);
  });
}

async function _saveToIDB(records) {
  if (!records.length) return;
  const idb = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx    = idb.transaction(_IDB_STORE, 'readwrite');
    const store = tx.objectStore(_IDB_STORE);
    records.forEach(r => store.put(r));
    tx.oncomplete = () => { idb.close(); resolve(); };
    tx.onerror    = () => { idb.close(); reject(tx.error); };
  });
}

async function _loadFromIDB() {
  const idb = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx  = idb.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).getAll();
    req.onsuccess = () => { idb.close(); resolve(req.result); };
    req.onerror   = () => { idb.close(); reject(req.error); };
  });
}

async function dbLoad() {
  let arr = await _loadFromFS();
  if (!arr) arr = await _loadFromIDB().catch(() => []);
  return Object.fromEntries((arr || []).map(r => [r.filename, r]));
}

async function dbSave(recordMap) {
  const arr = Object.values(recordMap);
  if (!arr.length) return;
  await _saveToFS(arr);
  await _saveToIDB(arr).catch(e => console.error('IDB save:', e));
}
