// ---- State ----
let images = []; // { id, file, src, name, fileSize, status, text, ocrText, editedText, tags, isReviewed, progress, updatedAt }
let selectedLangs = new Set(['jpn', 'eng']);
let ocrWorker = null;
let currentImg = null;
let currentPctBase = 0;
let currentPctStep = 1;
let currentPassNum = 1;

// ---- Phase 2 State ----
let dbRecords = {}; // { filename: { filename, ocrText, editedText, tags, isReviewed, updatedAt } }
let activeTags = new Set();

// ---- Init: load persisted data ----
(async () => {
  try {
    dbRecords = await dbLoad();
    updateDbStatus();
    updateExportButtons();
  } catch (e) {
    console.error('DB load failed:', e);
  }
})();

// ---- 画像前処理 ----
function preprocessForOCR(imgSrc, mode) {
  return new Promise(resolve => {
    const imgEl = new Image();
    imgEl.onload = () => {
      const scale = 3;
      const W = imgEl.naturalWidth  * scale;
      const H = imgEl.naturalHeight * scale;

      function applyContrast(data) {
        const f = (259 * (85 + 255)) / (255 * (259 - 85));
        for (let i = 0; i < data.length; i += 4) {
          let g = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
          g = Math.min(255, Math.max(0, Math.round(f * (g - 128) + 128)));
          data[i] = data[i+1] = data[i+2] = g;
        }
      }

      if (mode === 'rotate90') {
        const canvas = document.createElement('canvas');
        canvas.width = H; canvas.height = W;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(H, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(imgEl, 0, 0, W, H);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyContrast(imageData.data);
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (mode === 'normal') {
          ctx.drawImage(imgEl, 0, 0, W, H);
          const imageData = ctx.getImageData(0, 0, W, H);
          applyContrast(imageData.data);
          ctx.putImageData(imageData, 0, 0);
        } else {
          ctx.drawImage(imgEl, 0, 0, W, H);
          const origData = ctx.getImageData(0, 0, W, H).data;
          const blurCanvas = document.createElement('canvas');
          blurCanvas.width = W; blurCanvas.height = H;
          const blurCtx = blurCanvas.getContext('2d');
          blurCtx.filter = 'blur(42px)';
          blurCtx.imageSmoothingEnabled = true;
          blurCtx.imageSmoothingQuality = 'high';
          blurCtx.drawImage(imgEl, 0, 0, W, H);
          const blurData = blurCtx.getImageData(0, 0, W, H).data;
          const outData = ctx.createImageData(W, H);
          const out = outData.data;
          const MARGIN = 18;
          for (let i = 0; i < origData.length; i += 4) {
            const og = 0.299 * origData[i] + 0.587 * origData[i+1] + 0.114 * origData[i+2];
            const bg = 0.299 * blurData[i] + 0.587 * blurData[i+1] + 0.114 * blurData[i+2];
            const val = og > bg + MARGIN ? 0 : 255;
            out[i] = out[i+1] = out[i+2] = val;
            out[i+3] = 255;
          }
          ctx.putImageData(outData, 0, 0);
        }
        resolve(canvas.toDataURL('image/png'));
      }
    };
    imgEl.src = imgSrc;
  });
}

// ---- OCR テキストマージ ----
function mergeOCRTexts(text1, text2) {
  const normKey = s => s.trim().replace(/\s+/g, '');

  function isGarbage(line) {
    const t = line.trim();
    if (!t) return true;
    if (!/[\u3040-\u30ff\u4e00-\u9fff\uff10-\uff19a-zA-Z0-9０-９%・.,。、（）()「」【】\-\/\\]/.test(t)) return true;
    const norm = normKey(t);
    if (norm.length >= 6) {
      const uniqueRatio = new Set(norm).size / norm.length;
      if (uniqueRatio < 0.30) return true;
    }
    return false;
  }

  const lines1 = text1.split('\n').map(l => l.trim()).filter(l => l && !isGarbage(l));
  const seen   = new Set(lines1.map(normKey));
  const lines2 = text2.split('\n').map(l => l.trim())
    .filter(l => l && !isGarbage(l) && !seen.has(normKey(l)));
  return [...lines1, ...lines2].join('\n');
}

let convertCircled = true;

function convertCircledNumbers(text) {
  if (!text) return text;
  text = text.replace(/[\u2460-\u2473]/g, ch => String(ch.codePointAt(0) - 0x2460 + 1));
  text = text.replace(/[\u24EA\u24FF]/g, '0');
  text = text.replace(/[\u24EB-\u24F4]/g, ch => String(ch.codePointAt(0) - 0x24EB + 11));
  text = text.replace(/[\u24F5-\u24FE]/g, ch => String(ch.codePointAt(0) - 0x24F5 + 1));
  text = text.replace(/[\u3251-\u325F]/g, ch => String(ch.codePointAt(0) - 0x3251 + 21));
  text = text.replace(/[\u32B1-\u32BF]/g, ch => String(ch.codePointAt(0) - 0x32B1 + 36));
  return text;
}

function onToggleCircled() {
  convertCircled = document.getElementById('circledToggle').checked;
  doSearch();
}

function prepareText(rawText) {
  return convertCircled ? convertCircledNumbers(rawText) : rawText;
}

// ---- Language badge toggle ----
document.querySelectorAll('.lang-badge').forEach(badge => {
  badge.addEventListener('click', async () => {
    const lang = badge.dataset.lang;
    if (selectedLangs.has(lang)) {
      if (selectedLangs.size <= 1) return;
      selectedLangs.delete(lang);
      badge.classList.remove('selected');
    } else {
      selectedLangs.add(lang);
      badge.classList.add('selected');
    }
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
  });
});

// ---- Drop Zone ----
const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  addFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
});
document.getElementById('fileInput').addEventListener('change', e => {
  addFiles(Array.from(e.target.files));
  e.target.value = '';
});

// ---- Utilities ----
function formatSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function sizeLevel(bytes) {
  if (bytes > 8 * 1024 * 1024) return 'danger';
  if (bytes > 3 * 1024 * 1024) return 'warn';
  return 'ok';
}

function readFileAsDataURL(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

// ---- Add Files (async, Phase 2: duplicate check + auto-restore) ----
async function addFiles(files) {
  let restoredCount = 0;

  for (const file of files) {
    // 同名ファイルが既にセッション内にある場合は上書き確認
    const inSession = images.find(img => img.name === file.name);
    if (inSession) {
      const ok = confirm(`「${file.name}」はすでにリストにあります。\n上書きしますか？`);
      if (!ok) continue;
      images = images.filter(img => img.name !== file.name);
    }

    const id  = Date.now() + Math.random();
    const src = await readFileAsDataURL(file);
    const rec = dbRecords[file.name]; // 保存済みレコードがあれば復元

    const entry = {
      id,
      file,
      src,
      name: file.name,
      fileSize: file.size,
      ocrText:    rec?.ocrText    || '',
      editedText: rec?.editedText || '',
      tags:       rec?.tags       ? [...rec.tags] : [],
      isReviewed: rec?.isReviewed ?? false,
      updatedAt:  rec?.updatedAt  || null,
      progress: 0,
      status: 'pending',
      text: ''
    };

    if (rec && (rec.ocrText || rec.editedText)) {
      entry.status   = 'restored';
      entry.text     = rec.editedText || rec.ocrText;
      entry.progress = 100;
      restoredCount++;
    }

    images.push(entry);
    renderGrid();
    updateButtons();
    updateWarnings();
  }

  if (restoredCount > 0) {
    showToast(`${restoredCount}件の保存済みデータを復元しました`, 'success');
    renderTagFilterBadges();
  }

  updateSearchInput();
  doSearch();
  updateExportButtons();
}

function updateSearchInput() {
  const si = document.getElementById('searchInput');
  const hasSearchable = images.some(i => i.status === 'done' || i.status === 'restored');
  si.disabled    = !hasSearchable;
  si.placeholder = hasSearchable ? 'キーワードを入力して検索...' : '先に画像を読み取ってください...';
}

function removeImage(id) {
  images = images.filter(img => img.id !== id);
  renderGrid();
  updateButtons();
  updateWarnings();
  updateSearchInput();
  updateExportButtons();
  renderTagFilterBadges();
  doSearch();
}

function clearAll() {
  images = [];
  activeTags.clear();
  renderGrid();
  updateButtons();
  updateWarnings();
  updateExportButtons();
  showEmptyState();
  renderTagFilterBadges();
  document.getElementById('searchInput').value = '';
  document.getElementById('searchStat').textContent = '';
  updateSearchInput();
}

function renderGrid() {
  const grid = document.getElementById('imageGrid');
  if (images.length === 0) { grid.innerHTML = ''; return; }
  grid.innerHTML = images.map(img => {
    const sz = img.fileSize || 0;
    const lvl = sizeLevel(sz);
    const sizeThumbClass = lvl !== 'ok' ? `size-${lvl}` : '';
    return `
    <div class="img-thumb ${img.status} ${sizeThumbClass}" id="thumb-${img.id}">
      <img src="${img.src}" alt="${escHtml(img.name)}" />
      <div class="thumb-info">
        <div class="thumb-name" title="${escHtml(img.name)}">${escHtml(img.name)}</div>
        <div class="thumb-status" style="display:flex;align-items:center;gap:4px;">
          ${statusBadge(img)}
          <span class="size-chip ${lvl}">${formatSize(sz)}</span>
        </div>
      </div>
      <button class="remove-thumb" onclick="removeImage(${img.id})" title="削除">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div class="thumb-progress">
        <div class="thumb-progress-fill" style="width:${img.progress}%"></div>
      </div>
    </div>`;
  }).join('');
}

function statusBadge(img) {
  const ic = d => `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (img.status === 'pending')    return `<span style="color:#9ca3af;display:flex;align-items:center;gap:3px;">${ic('<circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/>')} 待機中</span>`;
  if (img.status === 'processing') return `<span style="color:var(--brand);display:flex;align-items:center;gap:3px;">${ic('<polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')} 読取中 ${img.progress}%</span>`;
  if (img.status === 'done')       return `<span style="color:#10b981;display:flex;align-items:center;gap:3px;">${ic('<polyline points="20,6 9,17 4,12"/>')} 完了</span>`;
  if (img.status === 'restored')   return `<span style="color:#8b5cf6;display:flex;align-items:center;gap:3px;">${ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/>')} 復元済み</span>`;
  if (img.status === 'error')      return `<span style="color:#ef4444;display:flex;align-items:center;gap:3px;">${ic('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>')} エラー</span>`;
  return '';
}

function updateThumb(img) {
  const thumb = document.getElementById(`thumb-${img.id}`);
  if (!thumb) return;
  thumb.className = `img-thumb ${img.status}`;
  thumb.querySelector('.thumb-status').innerHTML = statusBadge(img);
  thumb.querySelector('.thumb-progress-fill').style.width = img.progress + '%';
}

function updateButtons() {
  const hasPending = images.some(i => i.status === 'pending');
  const hasAny     = images.length > 0;
  document.getElementById('ocrBtn').disabled   = !hasPending;
  document.getElementById('clearBtn').disabled = !hasAny;
}

function updateExportButtons() {
  const hasSearchable = images.some(i => i.status === 'done' || i.status === 'restored');
  document.getElementById('exportCsvBtn').disabled = !hasSearchable;
  document.getElementById('exportTxtBtn').disabled = !hasSearchable;
}

// ---- ファイルサイズ・枚数の警告表示 ----
function updateWarnings() {
  const summaryEl  = document.getElementById('fileSummary');
  const warningsEl = document.getElementById('fileWarnings');
  if (images.length === 0) {
    summaryEl.style.display = 'none';
    warningsEl.innerHTML = '';
    return;
  }

  const totalBytes  = images.reduce((s, img) => s + (img.fileSize || 0), 0);
  const totalMB     = totalBytes / 1024 / 1024;
  const count       = images.length;
  const dangerFiles = images.filter(img => sizeLevel(img.fileSize) === 'danger');
  const warnFiles   = images.filter(img => sizeLevel(img.fileSize) === 'warn');

  const totalLevel  = totalMB > 30 ? 'danger' : totalMB > 20 ? 'warn' : 'ok';
  summaryEl.style.display = 'flex';
  summaryEl.className = 'file-summary';
  const svgImg  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>`;
  const svgDb   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`;
  const svgOk   = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>`;
  const svgWarn = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const svgX    = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  const levelIcon  = totalLevel === 'ok' ? svgOk : totalLevel === 'warn' ? svgWarn : svgX;
  const levelLabel = totalLevel === 'ok' ? '問題なし' : totalLevel === 'warn' ? '上限に近い' : '推奨超過';
  summaryEl.innerHTML = `
    <div class="fs-item" style="display:flex;align-items:center;gap:4px;">${svgImg} <strong>${count}</strong> 枚</div>
    <div class="fs-item" style="display:flex;align-items:center;gap:4px;">${svgDb} 合計 <strong>${totalMB.toFixed(1)} MB</strong>
      <span class="fs-badge ${totalLevel}" style="display:inline-flex;align-items:center;gap:3px;">${levelIcon} ${levelLabel}</span>
    </div>
  `;

  const msgs = [];
  const svgDanger  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  const svgWarnMsg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

  if (dangerFiles.length > 0)
    msgs.push({ level: 'danger', icon: svgDanger, text: `<strong>${dangerFiles.length}枚のファイルが8MBを超えています。</strong><br>${dangerFiles.map(f => `${escHtml(f.name)}（${formatSize(f.fileSize)}）`).join('、')}<br>処理中にブラウザがクラッシュする可能性があります。リサイズして再アップロードすることをお勧めします。` });
  if (warnFiles.length > 0)
    msgs.push({ level: 'warn', icon: svgWarnMsg, text: `<strong>${warnFiles.length}枚のファイルが3MBを超えています。</strong>（推奨上限）<br>${warnFiles.map(f => `${escHtml(f.name)}（${formatSize(f.fileSize)}）`).join('、')}<br>処理に時間がかかる場合があります。` });
  if (totalMB > 30)
    msgs.push({ level: 'danger', icon: svgDanger, text: `<strong>合計ファイルサイズが ${totalMB.toFixed(1)} MB です。</strong><br>推奨上限（20MB）を大きく超えています。枚数を減らすか、サイズの小さい画像を使用してください。` });
  else if (totalMB > 20)
    msgs.push({ level: 'warn', icon: svgWarnMsg, text: `<strong>合計ファイルサイズが ${totalMB.toFixed(1)} MB です。</strong>推奨上限（20MB）を超えています。` });

  warningsEl.innerHTML = msgs.map(m =>
    `<div class="warn-item ${m.level}"><span class="wi-icon">${m.icon}</span><span>${m.text}</span></div>`
  ).join('');
}

// ---- OCR ----
async function startOCR() {
  const pendingImages = images.filter(i => i.status === 'pending');
  if (pendingImages.length === 0) return;

  document.getElementById('ocrBtn').disabled = true;
  document.getElementById('globalProgress').style.display = 'block';

  const langSet = new Set(selectedLangs);
  if (langSet.has('jpn')) langSet.add('jpn_vert');
  const langStr = Array.from(langSet).join('+');

  try {
    if (!ocrWorker) {
      document.getElementById('gpLabel').textContent = '言語モデルを読み込み中...（初回のみ時間がかかります）';
      ocrWorker = await Tesseract.createWorker(langStr, 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5',
        langPath:   'https://tessdata.projectnaptha.com/4.0.0',
        logger: m => {
          if (m.status === 'recognizing text' && currentImg) {
            const third      = currentPctStep / 3;
            const passOffset = (currentPassNum - 1) * third;
            currentImg.progress = Math.round((passOffset + m.progress * third) / currentPctStep * 100);
            updateThumb(currentImg);
            document.getElementById('gpFill').style.width =
              (currentPctBase + passOffset + m.progress * third) + '%';
          }
        }
      });
      await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
    }

    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      img.status   = 'processing';
      img.progress = 0;
      updateThumb(img);

      const pctBase = i / pendingImages.length * 100;
      const pctStep = 100 / pendingImages.length;
      document.getElementById('gpLabel').textContent = `読み取り中... (${i + 1} / ${pendingImages.length}) — ${img.name}`;

      try {
        currentImg     = img;
        currentPctBase = pctBase;
        currentPctStep = pctStep;

        currentPassNum = 1;
        const src1 = await preprocessForOCR(img.src, 'normal');
        const res1 = await ocrWorker.recognize(src1);

        currentPassNum = 2;
        const src2 = await preprocessForOCR(img.src, 'invert');
        const res2 = await ocrWorker.recognize(src2);

        currentPassNum = 3;
        const src3 = await preprocessForOCR(img.src, 'rotate90');
        const res3 = await ocrWorker.recognize(src3);

        img.text = mergeOCRTexts(
          mergeOCRTexts(res1.data.text || '', res2.data.text || ''),
          res3.data.text || ''
        );
        img.ocrText    = img.text;
        img.isReviewed = false;
        img.updatedAt  = new Date().toISOString();
        img.status     = 'done';
        img.progress   = 100;

        persistRecord(img);
      } catch (err) {
        console.error('OCR error:', err);
        img.status = 'error';
        img.text   = '';
      } finally {
        currentImg = null;
      }
      updateThumb(img);
    }

    document.getElementById('gpFill').style.width = '100%';
    document.getElementById('gpLabel').textContent = 'すべての画像の読み取りが完了しました';
    setTimeout(() => { document.getElementById('globalProgress').style.display = 'none'; }, 2000);

    updateSearchInput();
    document.getElementById('searchInput').focus();
    renderTagFilterBadges();
    updateExportButtons();
    doSearch();

  } catch (err) {
    console.error(err);
    document.getElementById('gpLabel').textContent = 'エラーが発生しました: ' + err.message;
  }

  updateButtons();
}

// ---- Search ----
function getSearchText(img) {
  return img.editedText || img.ocrText || img.text || '';
}

function doSearch() {
  const query       = document.getElementById('searchInput').value.trim();
  const searchable  = images.filter(i => i.status === 'done' || i.status === 'restored');

  if (searchable.length === 0) {
    showEmptyState();
    document.getElementById('searchStat').textContent = '';
    return;
  }

  // タグフィルター
  let filtered = searchable;
  if (activeTags.size > 0) {
    filtered = filtered.filter(img => img.tags && img.tags.some(t => activeTags.has(t)));
  }

  if (!query) {
    document.getElementById('searchStat').textContent = `${filtered.length} 件の画像が検索可能です`;
    renderResults(filtered, '');
    return;
  }

  const matchedImages = filtered.filter(img =>
    normalizeText(prepareText(getSearchText(img))).toLowerCase()
      .includes(normalizeText(query).toLowerCase())
  );

  document.getElementById('searchStat').textContent =
    `「${query}」が見つかった画像: ${matchedImages.length} / ${filtered.length} 件`;

  renderResults(filtered, query);
}

function showEmptyState() {
  document.getElementById('results').innerHTML = `
    <div class="empty-state">
      <div class="es-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52" fill="none">
          <circle cx="22" cy="22" r="14" stroke="#d1d5db" stroke-width="3" fill="none"/>
          <line x1="32" y1="32" x2="46" y2="46" stroke="#d1d5db" stroke-width="3" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="es-title">検索する準備ができていません</div>
      <div class="es-desc">左パネルから画像をアップロードし、<br>「テキストを読み取る」を実行してください。</div>
    </div>`;
}

function renderResults(imgs, query) {
  const resultsEl = document.getElementById('results');
  if (imgs.length === 0) { showEmptyState(); return; }

  const sorted = [...imgs].sort((a, b) => {
    const aM = query ? countMatches(prepareText(getSearchText(a)), query) : 0;
    const bM = query ? countMatches(prepareText(getSearchText(b)), query) : 0;
    return bM - aM;
  });

  resultsEl.innerHTML = sorted.map(img => {
    const effectiveText = getSearchText(img);
    const prepared      = prepareText(effectiveText);
    const matchCount    = query ? countMatches(prepared, query) : 0;
    const isMatch       = matchCount > 0;
    const highlighted   = query ? highlightText(prepared, query) : escHtml(normalizeText(prepared));
    const ocrHighlighted = query
      ? highlightText(prepareText(img.ocrText || img.text || ''), query)
      : escHtml(normalizeText(img.ocrText || img.text || ''));

    const unreviewedBadge = (!img.isReviewed && (img.ocrText || img.text))
      ? '<span class="badge-unreviewed">未確認</span>'
      : (img.isReviewed ? '<span class="badge-reviewed">確認済</span>' : '');

    const headerTags = img.tags && img.tags.length
      ? img.tags.slice(0, 3).map(t => `<span class="tag-chip small">${escHtml(t)}</span>`).join('')
        + (img.tags.length > 3 ? `<span class="tag-chip small">+${img.tags.length - 3}</span>` : '')
      : '';

    const tagsHtml = img.tags && img.tags.length
      ? img.tags.map(t => `<span class="tag-chip editable">${escHtml(t)}<button class="tag-remove" data-tag="${escHtml(t)}" onclick="removeTag(${img.id}, this.dataset.tag)" title="削除">×</button></span>`).join('')
      : '<span class="no-tags-msg">タグなし</span>';

    return `
    <div class="result-card ${query ? (isMatch ? 'matched' : 'no-match') : ''}" id="rc-${img.id}">
      <div class="result-header" onclick="toggleCard('${img.id}')">
        <img class="result-thumb" src="${img.src}" alt="${escHtml(img.name)}" />
        <div class="result-meta">
          <div class="result-name">
            ${escHtml(img.name)}
            ${unreviewedBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;">
            <div class="result-count ${query ? (isMatch ? 'found' : 'none') : 'none'}">
              ${query
                ? (isMatch
                    ? `「${escHtml(query)}」が ${matchCount} 箇所見つかりました`
                    : `「${escHtml(query)}」は見つかりませんでした`)
                : ((img.ocrText || img.text)
                    ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>テキスト読み取り済み'
                    : '（テキストなし）')}
            </div>
            ${headerTags}
          </div>
        </div>
        <span class="result-chevron">›</span>
      </div>
      <div class="result-body">
        <div class="result-body-inner">
          <div class="result-body-img">
            <img src="${img.src}" alt="${escHtml(img.name)}" />
          </div>
          <div class="result-text-area">

            <!-- OCR テキスト（直接編集可能） -->
            <div class="result-text-label" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <span>読み取ったテキスト（OCR）</span>
              ${unreviewedBadge}
            </div>
            <textarea class="edit-textarea" id="edit-${img.id}"
                      placeholder="テキストが検出されませんでした。ここに直接入力することもできます。">${escHtml(img.editedText || normalizeText(prepareText(img.ocrText || img.text || '')))}</textarea>
            <div class="edit-footer">
              <span class="edit-hint">編集したテキストが検索に使われます</span>
              <button class="btn btn-sm btn-primary save-edit-btn" onclick="saveEdit(${img.id})">編集を保存</button>
            </div>

            <!-- タグ -->
            <div class="tag-section">
              <div class="result-text-label">タグ</div>
              <div class="tag-list" id="tags-${img.id}">${tagsHtml}</div>
              <div class="tag-input-row">
                <input type="text" class="tag-input" id="taginput-${img.id}"
                       placeholder="タグを入力してEnterで追加..."
                       onkeydown="if(event.key==='Enter'){addTag(${img.id});event.preventDefault();}" />
                <button class="btn btn-sm btn-ghost" onclick="addTag(${img.id})">追加</button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  if (query) {
    sorted.forEach(img => {
      if (countMatches(prepareText(getSearchText(img)), query) > 0) {
        const card = document.getElementById(`rc-${img.id}`);
        if (card) card.classList.add('open');
      }
    });
  }
}

function toggleCard(id) {
  const card = document.getElementById(`rc-${id}`);
  if (card) card.classList.toggle('open');
}

// ---- Phase 2: Persist & Edit ----
async function persistRecord(img) {
  dbRecords[img.name] = {
    filename:   img.name,
    ocrText:    img.ocrText    || '',
    editedText: img.editedText || '',
    tags:       [...(img.tags  || [])],
    isReviewed: img.isReviewed ?? false,
    updatedAt:  img.updatedAt  || new Date().toISOString()
  };
  await dbSave(dbRecords);
}

function saveEdit(id) {
  const img = images.find(i => i.id == id);
  if (!img) return;
  const textarea = document.getElementById(`edit-${id}`);
  if (!textarea) return;

  img.editedText = textarea.value;
  img.isReviewed = true;
  img.updatedAt  = new Date().toISOString();
  img.text       = img.editedText || img.ocrText || '';

  persistRecord(img);
  doSearch();
  renderTagFilterBadges();

  // ボタンにフィードバック
  const btn = document.querySelector(`#rc-${id} .save-edit-btn`);
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '保存しました';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  }

  // 未確認バッジを更新
  const card = document.getElementById(`rc-${id}`);
  if (card) {
    card.querySelectorAll('.badge-unreviewed').forEach(b => {
      b.className = 'badge-reviewed';
      b.textContent = '確認済';
    });
  }
}

function addTag(id) {
  const img = images.find(i => i.id == id);
  if (!img) return;
  const input = document.getElementById(`taginput-${id}`);
  if (!input) return;
  const tag = input.value.trim();
  if (!tag) return;
  if (img.tags.includes(tag)) { input.value = ''; return; }

  img.tags.push(tag);
  img.updatedAt = new Date().toISOString();
  input.value   = '';

  persistRecord(img);
  renderTagList(id, img);
  renderTagFilterBadges();
}

function removeTag(id, tag) {
  const img = images.find(i => i.id == id);
  if (!img) return;
  img.tags      = img.tags.filter(t => t !== tag);
  img.updatedAt = new Date().toISOString();

  persistRecord(img);
  renderTagList(id, img);
  renderTagFilterBadges();
}

function renderTagList(id, img) {
  const el = document.getElementById(`tags-${id}`);
  if (!el) return;
  el.innerHTML = img.tags && img.tags.length
    ? img.tags.map(t => `<span class="tag-chip editable">${escHtml(t)}<button class="tag-remove" data-tag="${escHtml(t)}" onclick="removeTag(${id}, this.dataset.tag)" title="削除">×</button></span>`).join('')
    : '<span class="no-tags-msg">タグなし</span>';

  // ヘッダーのタグ表示も更新
  const card = document.getElementById(`rc-${id}`);
  if (card) {
    const headerTagArea = card.querySelector('.header-tags');
    if (headerTagArea) {
      headerTagArea.innerHTML = img.tags.slice(0, 3).map(t => `<span class="tag-chip small">${escHtml(t)}</span>`).join('')
        + (img.tags.length > 3 ? `<span class="tag-chip small">+${img.tags.length - 3}</span>` : '');
    }
  }
}

// ---- Tag Filter ----
function renderTagFilterBadges() {
  const area     = document.getElementById('tagFilterArea');
  const badgesEl = document.getElementById('tagFilterBadges');
  if (!area || !badgesEl) return;

  const allTags = new Set();
  images.filter(i => i.status === 'done' || i.status === 'restored')
    .forEach(img => (img.tags || []).forEach(t => allTags.add(t)));

  // 消えたタグはアクティブフィルターから除去
  for (const t of activeTags) {
    if (!allTags.has(t)) activeTags.delete(t);
  }

  if (allTags.size === 0) {
    area.style.display = 'none';
    return;
  }

  area.style.display = 'block';
  badgesEl.innerHTML = Array.from(allTags).map(t => `
    <span class="tag-filter-chip ${activeTags.has(t) ? 'active' : ''}"
          onclick="toggleTagFilter(this.dataset.tag)"
          data-tag="${escHtml(t)}">${escHtml(t)}</span>
  `).join('');
}

function toggleTagFilter(tag) {
  if (activeTags.has(tag)) activeTags.delete(tag);
  else activeTags.add(tag);
  renderTagFilterBadges();
  doSearch();
}

// ---- DB Status & Folder ----
function updateDbStatus() {
  const dot  = document.getElementById('dbDot');
  const text = document.getElementById('dbStatusText');
  if (!dot || !text) return;

  if (hasFolderAccess()) {
    dot.className  = 'db-dot fs';
    text.textContent = `フォルダ接続済み: ${getFolderName()}`;
  } else {
    dot.className  = 'db-dot idb';
    text.textContent = 'IndexedDB（ブラウザに保存）';
  }
}

async function openFolder() {
  const ok = await openFolderPicker();
  if (!ok) return;

  updateDbStatus();

  // フォルダ内のJSONを読み込み、既存IDBとマージ
  try {
    const arr = await (async () => {
      if (!hasFolderAccess()) return null;
      // db.js の _loadFromFS を直接呼べないので dbLoad を再呼びしてマージ
      return null;
    })();

    // フォルダ選択後に dbSave で現在のレコードをフォルダへ書き出す
    await dbSave(dbRecords);

    // セッション内のpendingファイルで保存済みレコードがあれば復元
    let restoredCount = 0;
    for (const img of images) {
      if (img.status === 'pending' && dbRecords[img.name]) {
        const rec = dbRecords[img.name];
        if (rec.ocrText || rec.editedText) {
          img.status     = 'restored';
          img.ocrText    = rec.ocrText;
          img.editedText = rec.editedText;
          img.tags       = [...(rec.tags || [])];
          img.isReviewed = rec.isReviewed;
          img.text       = rec.editedText || rec.ocrText;
          img.progress   = 100;
          restoredCount++;
        }
      }
    }

    renderGrid();
    updateButtons();
    updateExportButtons();
    renderTagFilterBadges();
    doSearch();

    showToast(`フォルダを接続しました${restoredCount > 0 ? `（${restoredCount}件を復元）` : ''}`, 'success');
  } catch (e) {
    console.error('openFolder error:', e);
    showToast('フォルダの読み込みに失敗しました', 'error');
  }
}

// ---- Export ----
function exportCSV() {
  const rows = [['filename', 'ocrText', 'editedText', 'tags', 'updatedAt']];
  images.filter(i => i.status === 'done' || i.status === 'restored').forEach(img => {
    rows.push([
      img.name,
      img.ocrText    || '',
      img.editedText || '',
      (img.tags || []).join(';'),
      img.updatedAt  || ''
    ]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadFile('image-search-export.csv', '\uFEFF' + csv, 'text/csv');
}

function exportTxt() {
  const lines = [];
  images.filter(i => i.status === 'done' || i.status === 'restored').forEach(img => {
    lines.push(`=== ${img.name} ===`);
    lines.push(`[OCR]`);
    lines.push(img.ocrText    || '（なし）');
    lines.push(`[編集済]`);
    lines.push(img.editedText || '（なし）');
    lines.push(`[タグ] ${(img.tags || []).join(', ') || '（なし）'}`);
    lines.push(`[更新] ${img.updatedAt || '（なし）'}`);
    lines.push('');
  });
  downloadFile('image-search-export.txt', lines.join('\n'), 'text/plain;charset=utf-8');
}

function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Toast ----
function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className   = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

// ---- Text utilities ----
function normalizeText(str) {
  return (str || '').replace(/[^\S\n]/g, '');
}

function countMatches(text, query) {
  if (!query || !text) return 0;
  const normText  = normalizeText(text).toLowerCase();
  const normQuery = normalizeText(query).toLowerCase();
  if (!normQuery) return 0;
  let count = 0, pos = 0;
  while ((pos = normText.indexOf(normQuery, pos)) !== -1) { count++; pos += normQuery.length; }
  return count;
}

function highlightText(text, query) {
  const normText = normalizeText(text);
  if (!query) return escHtml(normText);
  const normQuery   = normalizeText(query);
  const escaped      = escHtml(normText);
  const escapedQuery = escHtml(normQuery);
  const regex = new RegExp(escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(regex, match => `<mark>${match}</mark>`);
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
