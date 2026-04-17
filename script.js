// ---- State ----
let images = []; // { id, file, src, name, status, text, progress }
let selectedLangs = new Set(['jpn', 'eng']);
let ocrWorker = null;
let currentImg = null; // 処理中の画像（loggerから参照）
let currentPctBase = 0;
let currentPctStep = 1;
let currentPassNum = 1; // 1=通常パス, 2=反転パス

// ---- 画像前処理 ----
// mode: 'normal'   → グレースケール + コントラスト強化（黒文字認識）
//       'invert'   → 適応的しきい値処理（白文字×色付き背景の認識）
//       'rotate90' → 時計回り90°回転 + コントラスト強化（縦書き文字を横向きにして認識）
function preprocessForOCR(imgSrc, mode) {
  return new Promise(resolve => {
    const imgEl = new Image();
    imgEl.onload = () => {
      const scale = 3;
      const W = imgEl.naturalWidth  * scale;
      const H = imgEl.naturalHeight * scale;

      // ---- コントラスト強化の共通処理 ----
      function applyContrast(data) {
        const f = (259 * (85 + 255)) / (255 * (259 - 85));
        for (let i = 0; i < data.length; i += 4) {
          let g = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
          g = Math.min(255, Math.max(0, Math.round(f * (g - 128) + 128)));
          data[i] = data[i+1] = data[i+2] = g;
        }
      }

      if (mode === 'rotate90') {
        // ---- Pass 3: 時計回り90°回転（縦書きを横向きにして認識） ----
        // 回転後はW×Hが入れ替わる
        const canvas = document.createElement('canvas');
        canvas.width = H; canvas.height = W;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // 時計回り90°: translate(H,0) → rotate(π/2)
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
          // ---- Pass 1: グレースケール + コントラスト強化 ----
          ctx.drawImage(imgEl, 0, 0, W, H);
          const imageData = ctx.getImageData(0, 0, W, H);
          applyContrast(imageData.data);
          ctx.putImageData(imageData, 0, 0);

        } else {
          // ---- Pass 2: 適応的しきい値処理（白文字×色付き背景） ----
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

// ---- 2パスのOCR結果をマージ（ゴミテキスト除去付き） ----
function mergeOCRTexts(text1, text2) {
  const normKey = s => s.trim().replace(/\s+/g, '');

  // ゴミ行の判定（文字が単調に繰り返されている行を除外）
  function isGarbage(line) {
    const t = line.trim();
    if (!t) return true;
    // 意味のある文字が1文字もない行（記号・制御文字のみ）
    if (!/[\u3040-\u30ff\u4e00-\u9fff\uff10-\uff19a-zA-Z0-9０-９%・.,。、（）()「」【】\-\/\\]/.test(t)) return true;
    // 6文字以上で、ユニーク文字の比率が30%未満 → 繰り返しゴミ（例: 「にたにたにた…」）
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
let convertCircled = true; // 丸数字→アラビア数字変換フラグ

// ---- 丸数字変換 ----
function convertCircledNumbers(text) {
  if (!text) return text;
  // ① - ⑳ (U+2460–U+2473) → 1–20
  text = text.replace(/[\u2460-\u2473]/g,
    ch => String(ch.codePointAt(0) - 0x2460 + 1));
  // ⓪ (U+24EA) → 0、⓿ (U+24FF) → 0
  text = text.replace(/[\u24EA\u24FF]/g, '0');
  // ⓫–⓴ (U+246A–U+2473 already covered; U+24EB–U+24F4) → 11–20 (negative circled)
  text = text.replace(/[\u24EB-\u24F4]/g,
    ch => String(ch.codePointAt(0) - 0x24EB + 11));
  // ⓵–⓾ (U+24F5–U+24FE) → 1–10 (double circled)
  text = text.replace(/[\u24F5-\u24FE]/g,
    ch => String(ch.codePointAt(0) - 0x24F5 + 1));
  // ㉑–㉟ (U+3251–U+325F) → 21–35
  text = text.replace(/[\u3251-\u325F]/g,
    ch => String(ch.codePointAt(0) - 0x3251 + 21));
  // ㊱–㊿ (U+32B1–U+32BF) → 36–50
  text = text.replace(/[\u32B1-\u32BF]/g,
    ch => String(ch.codePointAt(0) - 0x32B1 + 36));
  return text;
}

// トグル変更時に再描画
function onToggleCircled() {
  convertCircled = document.getElementById('circledToggle').checked;
  doSearch();
}

// テキストを表示・検索用に加工（変換ON/OFFを反映）
function prepareText(rawText) {
  return convertCircled ? convertCircledNumbers(rawText) : rawText;
}

// ---- Language badge toggle ----
document.querySelectorAll('.lang-badge').forEach(badge => {
  badge.addEventListener('click', async () => {
    const lang = badge.dataset.lang;
    if (selectedLangs.has(lang)) {
      if (selectedLangs.size <= 1) return; // at least one
      selectedLangs.delete(lang);
      badge.classList.remove('selected');
    } else {
      selectedLangs.add(lang);
      badge.classList.add('selected');
    }
    // 言語変更時はワーカーを破棄して次回再生成させる
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
  });
});

// ---- Drop Zone (drag & drop only — ファイル/フォルダ選択は外のボタンで行う) ----
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

// ---- ファイルサイズ表示用ユーティリティ ----
function formatSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function sizeLevel(bytes) {
  if (bytes > 8 * 1024 * 1024) return 'danger'; // 8MB超
  if (bytes > 3 * 1024 * 1024) return 'warn';   // 3MB超
  return 'ok';
}

function addFiles(files) {
  files.forEach(file => {
    const id = Date.now() + Math.random();
    const reader = new FileReader();
    reader.onload = e => {
      images.push({
        id, file, src: e.target.result, name: file.name,
        fileSize: file.size, // バイト数を保存
        status: 'pending', text: '', progress: 0
      });
      renderGrid();
      updateButtons();
      updateWarnings(); // 警告を更新
    };
    reader.readAsDataURL(file);
  });
}

function removeImage(id) {
  images = images.filter(img => img.id !== id);
  renderGrid();
  updateButtons();
  updateWarnings();
  doSearch();
}

function clearAll() {
  images = [];
  renderGrid();
  updateButtons();
  updateWarnings();
  showEmptyState();
  document.getElementById('searchInput').value = '';
  document.getElementById('searchInput').disabled = true;
  document.getElementById('searchInput').placeholder = '先に画像を読み取ってください...';
  document.getElementById('searchStat').textContent = '';
}

function renderGrid() {
  const grid = document.getElementById('imageGrid');
  if (images.length === 0) { grid.innerHTML = ''; grid.classList.remove('scrollable'); return; }
  // 20枚超の場合はスクロールバーを表示
  grid.classList.toggle('scrollable', images.length > 20);
  grid.innerHTML = images.map(img => {
    const sz = img.fileSize || 0;
    const lvl = sizeLevel(sz);
    const sizeThumbClass = lvl !== 'ok' ? `size-${lvl}` : '';
    return `
    <div class="img-thumb ${img.status} ${sizeThumbClass}" id="thumb-${img.id}">
      <img src="${img.src}" alt="${escHtml(img.name)}" />
      <div class="thumb-info">
        <div class="thumb-name" title="${escHtml(img.name)}">
          ${escHtml(img.name)}
        </div>
        <div class="thumb-status" style="display:flex;align-items:center;gap:4px;">
          ${statusBadge(img)}
          <span class="size-chip ${lvl}">${formatSize(sz)}</span>
        </div>
      </div>
      <button class="remove-thumb" onclick="removeImage(${img.id})" title="削除"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      <div class="thumb-progress">
        <div class="thumb-progress-fill" style="width:${img.progress}%"></div>
      </div>
    </div>`;
  }).join('');
}

function statusBadge(img) {
  const ic = (d) => `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  if (img.status === 'pending')    return `<span style="color:#9ca3af;display:flex;align-items:center;gap:3px;">${ic('<circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/>')} 待機中</span>`;
  if (img.status === 'processing') return `<span style="color:var(--brand);display:flex;align-items:center;gap:3px;">${ic('<polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>')} 読取中 ${img.progress}%</span>`;
  if (img.status === 'done')       return `<span style="color:#10b981;display:flex;align-items:center;gap:3px;">${ic('<polyline points="20,6 9,17 4,12"/>')} 完了</span>`;
  if (img.status === 'error')      return `<span style="color:#ef4444;display:flex;align-items:center;gap:3px;">${ic('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>')} エラー</span>`;
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
  const hasAny = images.length > 0;
  document.getElementById('ocrBtn').disabled = !hasPending;
  document.getElementById('clearBtn').disabled = !hasAny;
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

  // ---- サマリーバー ----
  const totalLevel  = totalMB > 30 ? 'danger' : totalMB > 20 ? 'warn' : 'ok';
  summaryEl.style.display = 'flex';
  summaryEl.className = 'file-summary';
  const svgImg  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>`;
  const svgDb   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`;
  const svgOk   = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>`;
  const svgWarn = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const svgX    = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  const levelIcon = totalLevel === 'ok' ? svgOk : totalLevel === 'warn' ? svgWarn : svgX;
  const levelLabel = totalLevel === 'ok' ? '問題なし' : totalLevel === 'warn' ? '上限に近い' : '推奨超過';
  summaryEl.innerHTML = `
    <div class="fs-item" style="display:flex;align-items:center;gap:4px;">${svgImg} <strong>${count}</strong> 枚</div>
    <div class="fs-item" style="display:flex;align-items:center;gap:4px;">${svgDb} 合計 <strong>${totalMB.toFixed(1)} MB</strong>
      <span class="fs-badge ${totalLevel}" style="display:inline-flex;align-items:center;gap:3px;">${levelIcon} ${levelLabel}</span>
    </div>
    <div style="font-size:11px;color:#9ca3af;">合計サイズの推奨上限: 20MB</div>
  `;

  // ---- 警告メッセージ ----
  const msgs = [];

  const svgDanger = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  const svgWarnMsg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

  if (dangerFiles.length > 0) {
    msgs.push({ level: 'danger', icon: svgDanger, text:
      `<strong>${dangerFiles.length}枚のファイルが8MBを超えています。</strong><br>` +
      dangerFiles.map(f => `${escHtml(f.name)}（${formatSize(f.fileSize)}）`).join('、') +
      '<br>処理中にブラウザがクラッシュする可能性があります。リサイズして再アップロードすることをお勧めします。'
    });
  }

  if (warnFiles.length > 0) {
    msgs.push({ level: 'warn', icon: svgWarnMsg, text:
      `<strong>${warnFiles.length}枚のファイルが3MBを超えています。</strong>（推奨上限）<br>` +
      warnFiles.map(f => `${escHtml(f.name)}（${formatSize(f.fileSize)}）`).join('、') +
      '<br>処理に時間がかかる場合があります。'
    });
  }

  if (totalMB > 30) {
    msgs.push({ level: 'danger', icon: svgDanger, text:
      `<strong>合計ファイルサイズが ${totalMB.toFixed(1)} MB です。</strong><br>` +
      '推奨上限（20MB）を大きく超えています。枚数を減らすか、サイズの小さい画像を使用してください。'
    });
  } else if (totalMB > 20) {
    msgs.push({ level: 'warn', icon: svgWarnMsg, text:
      `<strong>合計ファイルサイズが ${totalMB.toFixed(1)} MB です。</strong>推奨上限（20MB）を超えています。`
    });
  }


  warningsEl.innerHTML = msgs.map(m =>
    `<div class="warn-item ${m.level}">
      <span class="wi-icon">${m.icon}</span>
      <span>${m.text}</span>
    </div>`
  ).join('');
}

// ---- OCR ----
async function startOCR() {
  const pendingImages = images.filter(i => i.status === 'pending');
  if (pendingImages.length === 0) return;

  document.getElementById('ocrBtn').disabled = true;
  document.getElementById('globalProgress').style.display = 'block';

  // jpn が選択されている場合、縦書き用モデル jpn_vert を自動追加
  const langSet = new Set(selectedLangs);
  if (langSet.has('jpn')) langSet.add('jpn_vert');
  const langStr = Array.from(langSet).join('+');

  try {
    // Create worker once
    if (!ocrWorker) {
      document.getElementById('gpLabel').textContent = '言語モデルを読み込み中...（初回のみ時間がかかります）';
      ocrWorker = await Tesseract.createWorker(langStr, 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5',
        langPath:   'https://tessdata.projectnaptha.com/4.0.0',
        logger: m => {
          if (m.status === 'recognizing text' && currentImg) {
            // 3パスに均等分割（各パス約33%）
            const third = currentPctStep / 3;
            const passOffset = (currentPassNum - 1) * third;
            currentImg.progress = Math.round((passOffset + m.progress * third) / currentPctStep * 100);
            updateThumb(currentImg);
            document.getElementById('gpFill').style.width =
              (currentPctBase + passOffset + m.progress * third) + '%';
          }
        }
      });
      // PSM 11: SPARSE_TEXT — レイアウト不問でテキストを探す（グラフ・図形内の文字に有効）
      await ocrWorker.setParameters({ tessedit_pageseg_mode: '11' });
    }

    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      img.status = 'processing';
      img.progress = 0;
      updateThumb(img);

      const pctBase = i / pendingImages.length * 100;
      const pctStep = 100 / pendingImages.length;

      document.getElementById('gpLabel').textContent =
        `読み取り中... (${i + 1} / ${pendingImages.length}) — ${img.name}`;

      try {
        currentImg     = img;
        currentPctBase = pctBase;
        currentPctStep = pctStep;

        // --- Pass 1: 通常（コントラスト強化） ---
        currentPassNum = 1;
        const src1 = await preprocessForOCR(img.src, 'normal');
        const res1 = await ocrWorker.recognize(src1);

        // --- Pass 2: 適応的しきい値（白文字×色付き背景） ---
        currentPassNum = 2;
        const src2 = await preprocessForOCR(img.src, 'invert');
        const res2 = await ocrWorker.recognize(src2);

        // --- Pass 3: 時計回り90°回転（縦書き→横書きとして認識） ---
        currentPassNum = 3;
        const src3 = await preprocessForOCR(img.src, 'rotate90');
        const res3 = await ocrWorker.recognize(src3);

        img.text = mergeOCRTexts(
          mergeOCRTexts(res1.data.text || '', res2.data.text || ''),
          res3.data.text || ''
        );
        img.status = 'done';
        img.progress = 100;
      } catch (err) {
        console.error('OCR error:', err);
        img.status = 'error';
        img.text = '';
      } finally {
        currentImg = null;
      }
      updateThumb(img);
    }

    document.getElementById('gpFill').style.width = '100%';
    document.getElementById('gpLabel').textContent = 'すべての画像の読み取りが完了しました';
    setTimeout(() => { document.getElementById('globalProgress').style.display = 'none'; }, 2000);

    // 検索バーを有効化
    const si = document.getElementById('searchInput');
    si.disabled = false;
    si.placeholder = 'キーワードを入力して検索...';
    si.focus();
    doSearch();

  } catch (err) {
    console.error(err);
    document.getElementById('gpLabel').textContent = 'エラーが発生しました: ' + err.message;
  }

  updateButtons();
}

// ---- Search ----
function doSearch() {
  const query     = document.getElementById('searchInput').value.trim();
  const resultsEl = document.getElementById('results');
  const doneImages = images.filter(i => i.status === 'done');

  if (doneImages.length === 0) {
    showEmptyState();
    document.getElementById('searchStat').textContent = '';
    return;
  }

  if (!query) {
    document.getElementById('searchStat').textContent = `${doneImages.length} 件の画像が検索可能です`;
    renderResults(doneImages, '');
    return;
  }

  const matchedImages = doneImages.filter(img =>
    normalizeText(prepareText(img.text)).toLowerCase()
      .includes(normalizeText(query).toLowerCase())
  );

  document.getElementById('searchStat').textContent =
    `「${query}」が見つかった画像: ${matchedImages.length} / ${doneImages.length} 件`;

  renderResults(doneImages, query);
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

  if (imgs.length === 0) {
    showEmptyState(); return;
  }

  // Sort: matched first
  const sorted = [...imgs].sort((a, b) => {
    const aMatch = query ? countMatches(prepareText(a.text), query) : 0;
    const bMatch = query ? countMatches(prepareText(b.text), query) : 0;
    return bMatch - aMatch;
  });

  resultsEl.innerHTML = sorted.map(img => {
    const prepared = prepareText(img.text);
    const matchCount = query ? countMatches(prepared, query) : 0;
    const isMatch = matchCount > 0;
    const highlightedText = query ? highlightText(prepared, query) : escHtml(normalizeText(prepared));

    return `
    <div class="result-card ${query ? (isMatch ? 'matched' : 'no-match') : ''}" id="rc-${img.id}">
      <div class="result-header" onclick="toggleCard('${img.id}')">
        <img class="result-thumb" src="${img.src}" alt="${escHtml(img.name)}" />
        <div class="result-meta">
          <div class="result-name">${escHtml(img.name)}</div>
          <div class="result-count ${query ? (isMatch ? 'found' : 'none') : 'none'}">
            ${query
              ? (isMatch ? `「${escHtml(query)}」が ${matchCount} 箇所見つかりました` : `「${escHtml(query)}」は見つかりませんでした`)
              : (img.text ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>テキスト読み取り済み' : '（テキストなし）')
            }
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
            <div class="result-text-label">読み取ったテキスト</div>
            <div class="result-text">${highlightedText || '<span style="color:#9ca3af">（テキストが検出されませんでした）</span>'}</div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Auto-open matched cards when searching
  if (query) {
    sorted.forEach(img => {
      if (countMatches(prepareText(img.text), query) > 0) {
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

// スペース・タブを除去（改行は保持）してテキストを正規化
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
  // 表示テキストもスペース除去済みのものを使う
  const normText = normalizeText(text);
  if (!query) return escHtml(normText);
  const normQuery = normalizeText(query);
  const escaped = escHtml(normText);
  const escapedQuery = escHtml(normQuery);
  const regex = new RegExp(escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(regex, match => `<mark>${match}</mark>`);
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

