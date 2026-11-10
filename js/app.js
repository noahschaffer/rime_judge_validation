/*
 * Judge-validation UI: loads the judge's JSONL, draws a seeded random sample,
 * shows one example at a time and records the reviewer's verdicts.
 *
 * URL parameters:
 *   ?seed=abc123            which sample to use (share the URL to share a sample)
 *   ?sampling=stratified    equal share per combination of judge verdicts (default: random)
 *   ?n=100                  sample size
 *   ?data=path              JSONL to load instead of the default
 *
 * Progress is saved in localStorage per dataset + seed + sampling method, so
 * reloading the page (at the same address) picks up where you left off.
 */
(function () {
  'use strict';

  const { h } = RJVDom;
  const Core = RJVCore;
  const Graph = RJVGraph;

  // Tried in order. The published site ships only the gzipped copy (see README).
  const DEFAULT_DATA_URLS = ['assets/musiccaps_prompt_report.jsonl', 'assets/musiccaps_prompt_report.jsonl.gz'];
  const DEFAULT_SAMPLE_SIZE = 100;
  const STORE_PREFIX = 'rjv:v1:';

  /** How each criterion is presented. Export field order comes from core.js. */
  const CRITERIA = [
    {
      key: 'al_rules',
      label: 'AL rules',
      hint: 'Does each variant follow the rules for its abstraction level?',
      why: 'al_rules_why',
      reason: 'al_rules_reason',
    },
    {
      key: 'al_consistency',
      label: 'AL consistency',
      hint: 'Do adjacent variants (AL0 → AL1 → AL2) describe the same edit?',
      why: 'al_consistency_why',
      reason: 'al_consistency_reason',
      tags: 'al_consistency_failures',
    },
    {
      key: 'stylistic',
      label: 'Stylistic',
      hint: 'Does the edit suit the music described in the caption?',
      why: 'stylistic_why',
      reason: 'stylistic_reason',
    },
  ];

  const STATUS_TEXT = { done: 'complete', partial: 'in progress', empty: 'not started' };

  const state = {
    lines: null,
    source: '',
    fingerprint: '',
    frame: null, // rows grouped by judge verdicts, built on first need
    seed: '',
    sampling: 'random', // what the reviewer picked: 'random' | 'stratified'
    method: 'random', // what the current sample is: 'random' | 'stratified' | 'all'
    strata: null,
    excluded: 0,
    n: DEFAULT_SAMPLE_SIZE,
    items: [],
    total: 0,
    skipped: 0,
    annotations: {}, // source line index -> annotation
    current: 0,
    blind: false,
    storageOk: true,
  };

  const els = {};

  // ------------------------------------------------------------- utilities

  const storage = {
    get(key) {
      try {
        return localStorage.getItem(STORE_PREFIX + key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(STORE_PREFIX + key, value);
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  const fmtInt = (n) => Number(n).toLocaleString('en-US');

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function clampInt(value, lo, hi, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  function cleanSeed(s) {
    s = String(s == null ? '' : s).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
  }

  const cleanSampling = (s) => (s === 'random' || s === 'stratified' ? s : null);

  const pct = (part, whole) => {
    if (!whole) return '–';
    const p = (100 * part) / whole;
    if (p > 0 && p < 0.1) return '<0.1%';
    return `${p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)}%`;
  };

  const fmtWeight = (w) => w.toLocaleString('en-US', { maximumFractionDigits: w >= 100 ? 1 : 2 });

  /** Display name of a data file; a .gz copy is named after the file it holds. */
  const fileName = (path) =>
    decodeURIComponent(String(path).split(/[?#]/)[0].split('/').pop() || path).replace(/\.gz$/i, '');

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  /** Text with numbers wrapped in <span class="num"> so values stand out. */
  function withNumbers(text) {
    return String(text)
      .split(/([-+−]?\d+(?:\.\d+)?)/)
      .map((part, i) => (i % 2 ? h('span', { class: 'num' }, part) : part));
  }

  const annotationOf = (item) => state.annotations[item.line];
  const statusOf = (item) => Core.annotationStatus(annotationOf(item));

  function ensureAnnotation(item) {
    if (!state.annotations[item.line]) state.annotations[item.line] = Core.emptyAnnotation();
    return state.annotations[item.line];
  }

  /** Judge values mapped onto the reviewer's pass/fail scale (null when there is no counterpart). */
  function judgeAsPassFail(value) {
    if (value === 'pass' || value === 'appropriate') return 'pass';
    if (value === 'fail' || value === 'inappropriate') return 'fail';
    return null;
  }

  function judgeTone(value) {
    const pf = judgeAsPassFail(value);
    if (pf) return pf;
    return value === 'unclear' ? 'warn' : 'none';
  }

  // --------------------------------------------------------------- loading

  /** Text of a Blob, unpacking it first when it holds gzip data (checked by its magic bytes). */
  async function blobToText(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text();
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser cannot unpack .gz files; use a recent Chrome, Edge, Firefox or Safari');
    }
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  async function fetchText(url, onProgress) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const total = Number(res.headers.get('Content-Length')) || 0;
    const chunks = [];
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    return blobToText(new Blob(chunks));
  }

  function showLoader(title, detail) {
    els.loader.hidden = false;
    els.loadTitle.textContent = title;
    els.loadProgress.hidden = false;
    els.picker.hidden = true;
    els.loadBar.classList.add('indeterminate');
    els.loadFill.style.width = '';
    els.loadDetail.textContent = detail || '';
  }

  function setLoadProgress(loaded, total) {
    if (total && loaded <= total) {
      els.loadBar.classList.remove('indeterminate');
      els.loadFill.style.width = `${(100 * loaded) / total}%`;
      els.loadDetail.textContent = `${fmtBytes(loaded)} of ${fmtBytes(total)}`;
    } else {
      els.loadDetail.textContent = `${fmtBytes(loaded)} loaded`;
    }
  }

  function showPicker(url, err) {
    els.loader.hidden = false;
    els.loadTitle.textContent = 'Choose the judge results file';
    els.loadProgress.hidden = true;
    els.picker.hidden = false;
    els.cancelPicker.hidden = !state.items.length;
    const reason = [];
    if (url && location.protocol === 'file:') {
      reason.push(
        'This page was opened straight from disk, so the browser will not let it read ',
        h('code', null, url),
        '. Choose that file below, or serve this folder (for example ',
        h('code', null, 'python3 -m http.server'),
        ') and open the page from ',
        h('code', null, 'http://localhost:8000'),
        '.',
      );
    } else if (url) {
      reason.push('Could not load ', h('code', null, url), ` (${err.message}). Choose the file below instead.`);
    } else if (err) {
      reason.push(`${err.message}. Choose a different file.`);
    } else {
      reason.push(
        'Pick a judge results JSONL, or a results file you downloaded from this page earlier to keep working on it.',
      );
    }
    els.pickerReason.replaceChildren(...reason);
  }

  function hideLoader() {
    els.loader.hidden = true;
  }

  async function openFile(file) {
    // Before anything is loaded (the first-run picker) honour ?seed= like a normal
    // load; later, prefer the seed last used with that file so its progress returns.
    const preferUrl = !state.items.length;
    showLoader(`Reading ${file.name}…`, fmtBytes(file.size));
    try {
      const text = await blobToText(file);
      openDataset(text, fileName(file.name), { preferUrl });
    } catch (err) {
      showPicker(null, err);
    }
  }

  // --------------------------------------------------------------- session

  function sessionKey() {
    // A file small enough to show whole has one session whatever the seed.
    if (state.method === 'all') return `session:${state.fingerprint}:all`;
    const suffix = state.method === 'stratified' ? ':stratified' : '';
    return `session:${state.fingerprint}:${state.seed}${suffix}`;
  }

  /** Draw a sample from `dataset` ({ lines, frame }); the verdict frame is built once and cached. */
  function drawSample(dataset, seed, sampling) {
    if (sampling !== 'stratified') return Core.sampleRecords(dataset.lines, seed, state.n);
    if (!dataset.frame) dataset.frame = Core.buildFrame(dataset.lines);
    return Core.stratifiedSample(dataset.lines, seed, state.n, dataset.frame);
  }

  function saveSession() {
    if (!state.items.length) return;
    const annotations = {};
    for (const item of state.items) {
      const a = annotationOf(item);
      if (a && !Core.isAnnotationEmpty(a)) annotations[item.line] = a;
    }
    const ok = storage.set(
      sessionKey(),
      JSON.stringify({
        source: state.source,
        current: state.current,
        annotations,
        savedAt: new Date().toISOString(),
      }),
    );
    if (ok !== state.storageOk) {
      state.storageOk = ok;
      renderSaveStatus();
    }
  }

  function loadSession() {
    try {
      const saved = JSON.parse(storage.get(sessionKey()) || 'null');
      return saved && typeof saved === 'object' ? saved : {};
    } catch (e) {
      return {};
    }
  }

  function openDataset(text, source, { preferUrl }) {
    const lines = text.split('\n');
    const fingerprint = Core.hashString(text);
    const params = new URLSearchParams(location.search);
    const urlSeed = cleanSeed(params.get('seed'));
    // A shared link with a seed but no sampling parameter is a random sample.
    const urlSampling = cleanSampling(params.get('sampling')) || (urlSeed ? 'random' : null);
    const lastSeed = cleanSeed(storage.get(`lastSeed:${fingerprint}`));
    const lastSampling = cleanSampling(storage.get(`lastSampling:${fingerprint}`));
    const seed = (preferUrl ? urlSeed || lastSeed : lastSeed || urlSeed) || Core.newSeed();
    const sampling = (preferUrl ? urlSampling || lastSampling : lastSampling || urlSampling) || 'random';

    const dataset = { lines, source, fingerprint, frame: null };
    const sample = drawSample(dataset, seed, sampling);
    if (!sample.items.length) {
      showPicker(null, new Error(`${source} does not contain any JSON records`));
      return;
    }
    if (state.items.length) saveSession();
    Object.assign(state, dataset, { sampling });
    startSession(seed, sample);
    hideLoader();
  }

  function startSession(seed, sample) {
    state.seed = seed;
    sample = sample || drawSample(state, seed, state.sampling);
    state.method = sample.method;
    state.items = sample.items;
    state.total = sample.total;
    state.skipped = sample.skipped;
    state.strata = sample.strata || null;
    state.excluded = sample.excluded || 0;

    const saved = loadSession();
    const savedAnnotations = saved.annotations || {};
    state.annotations = {};
    for (const item of state.items) {
      const stored = savedAnnotations[item.line];
      const a = stored ? Core.normalizeAnnotation(stored) : Core.annotationFromRecord(item.rec);
      if (a) state.annotations[item.line] = a;
    }
    state.current = clampInt(saved.current, 0, state.items.length - 1, 0);

    storage.set(`lastSeed:${state.fingerprint}`, seed);
    storage.set(`lastSampling:${state.fingerprint}`, state.sampling);
    syncUrl();
    renderHeader();
    renderStrip();
    renderSaveStatus();
    go(state.current, { force: true });
  }

  function syncUrl() {
    const params = new URLSearchParams(location.search);
    params.set('seed', state.seed);
    if (state.sampling === 'stratified') params.set('sampling', 'stratified');
    else params.delete('sampling');
    try {
      history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
    } catch (e) {
      /* file:// pages may refuse URL changes; the seed is still remembered locally */
    }
  }

  // ------------------------------------------------------------ navigation

  function go(index, { force = false } = {}) {
    if (!state.items.length) return;
    index = Math.max(0, Math.min(state.items.length - 1, index));
    if (index === state.current && !force) return;
    state.current = index;
    renderExample();
    updateStrip();
    saveSession();
    for (const el of [els.main, els.paneGraph, els.paneText, els.review]) el.scrollTop = 0;
    if (window.matchMedia('(max-width: 820px)').matches) window.scrollTo(0, 0);
  }

  function nextIncomplete() {
    const n = state.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (state.current + k) % n;
      if (statusOf(state.items[i]) !== 'done') {
        go(i);
        return;
      }
    }
  }

  // ------------------------------------------------------------- rendering

  function renderHeader() {
    const n = state.items.length;
    const census = state.method === 'all';
    // Sample first: when the line is cut off, the file name is the part that goes.
    const parts = census
      ? [`all ${fmtInt(n)} rows`, state.source]
      : [
          `${state.method === 'stratified' ? 'Stratified sample' : 'Random sample'} of ${n}`,
          `seed ${state.seed}`,
          state.source,
          `${fmtInt(state.total)} rows`,
        ];
    if (state.skipped) parts.push(`${state.skipped} unreadable rows skipped`);
    els.srcInfo.textContent = parts.join(' · ');
    els.srcInfo.title = census
      ? parts.join('\n')
      : `${parts.join('\n')}\n\nShare this page's URL (it includes the seed) to give someone the same sample.`;

    els.sampling.value = state.sampling;
    els.sampling.disabled = census;
    els.newSample.disabled = census;
    els.samplingWrap.title = census
      ? `This file has ${state.n} rows or fewer, so every row is shown and there is nothing to sample.`
      : 'Random: every row equally likely. Stratified: each combination of judge verdicts gets an equal share.';
    updateProgress();
  }

  // -------------------------------------------------------- sample details

  const VERDICT_ORDER = ['pass', 'appropriate', 'fail', 'inappropriate', 'unclear'];

  function orderVerdicts(values) {
    const rank = (v) => (v === 'none' ? 999 : VERDICT_ORDER.includes(v) ? VERDICT_ORDER.indexOf(v) : 99);
    return [...values].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  const verdictChip = (v) =>
    h('span', { class: `chip ${judgeTone(v === 'none' ? null : v)}` }, v === 'none' ? 'no verdict' : v);

  /** Per criterion: how often the judge gave each verdict in the whole file vs. in this sample. */
  function compositionTable() {
    const frame = state.frame;
    const n = state.items.length;
    const body = [];
    for (const c of CRITERIA) {
      const inFile = frame.marginals[c.key] || {};
      const inSample = {};
      for (const item of state.items) {
        const v = Core.verdictKey(item.rec[c.key]);
        inSample[v] = (inSample[v] || 0) + 1;
      }
      const values = orderVerdicts(new Set([...Object.keys(inFile), ...Object.keys(inSample)]));
      values.forEach((v, i) => {
        body.push(h('tr', null,
          i === 0 ? h('th', { scope: 'rowgroup', rowspan: values.length }, c.label) : null,
          h('td', null, verdictChip(v)),
          h('td', { class: 'n' }, fmtInt(inFile[v] || 0), h('span', { class: 'pct' }, pct(inFile[v] || 0, frame.readable))),
          h('td', { class: 'n' }, fmtInt(inSample[v] || 0), h('span', { class: 'pct' }, pct(inSample[v] || 0, n)))));
      });
    }
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Criterion'),
          h('th', { scope: 'col' }, 'Judge'),
          h('th', { scope: 'col', class: 'n' }, 'In file'),
          h('th', { scope: 'col', class: 'n' }, 'In sample'))),
        h('tbody', null, body)));
  }

  function strataTable() {
    const rows = state.strata.map((s) =>
      h('tr', null,
        s.values.map((v) => h('td', null, verdictChip(v))),
        h('td', { class: 'n' }, fmtInt(s.population)),
        h('td', { class: 'n' }, fmtInt(s.sampled)),
        h('td', { class: 'n' }, s.weight == null ? '–' : fmtWeight(s.weight))));
    if (state.excluded) {
      rows.push(h('tr', { class: 'muted-row' },
        h('td', { colspan: CRITERIA.length }, 'No verdict on some criterion (not sampled)'),
        h('td', { class: 'n' }, fmtInt(state.excluded)),
        h('td', { class: 'n' }, '0'),
        h('td', { class: 'n' }, '–')));
    }
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
          CRITERIA.map((c) => h('th', { scope: 'col' }, c.label)),
          h('th', { scope: 'col', class: 'n' }, 'In file'),
          h('th', { scope: 'col', class: 'n' }, 'Drawn'),
          h('th', { scope: 'col', class: 'n' }, 'Weight'))),
        h('tbody', null, rows)));
  }

  function openSampleDialog() {
    if (!state.items.length) return;
    if (!state.frame) state.frame = Core.buildFrame(state.lines);
    const n = state.items.length;
    const body = [];
    if (state.method === 'all') {
      els.sampleTitle.textContent = 'All rows';
      body.push(h('p', null,
        `This file has ${fmtInt(n)} rows, no more than the sample size of ${state.n}, so every row is shown in file order.`));
    } else if (state.method === 'random') {
      els.sampleTitle.textContent = `Random sample · seed ${state.seed}`;
      body.push(h('p', null,
        `${n} rows drawn uniformly at random from ${fmtInt(state.total)}: every row had the same chance of being picked, so rates in the sample estimate rates in the whole file directly.`));
    } else {
      els.sampleTitle.textContent = `Stratified sample · seed ${state.seed}`;
      body.push(
        h('p', null,
          `Rows are grouped by the judge's verdicts on all three criteria. Each combination gets an equal share of the ${n} (all of its rows when it has fewer), so cases the judge failed are well represented. Rows are drawn at random within each combination and shown in random order.`),
        h('p', null,
          'Each exported row also gets ', h('code', null, 'sample_stratum'), ' and ', h('code', null, 'sample_weight'),
          ' (rows in its combination ÷ rows drawn from it). Weight by ', h('code', null, 'sample_weight'),
          ' to estimate rates for the whole file; unweighted counts overstate the rare combinations.'));
      if (state.excluded) {
        body.push(h('p', { class: 'muted' },
          `${fmtInt(state.excluded)} rows where the judge returned no verdict for some criterion are left out.`));
      }
    }
    body.push(h('h3', null, 'Judge verdicts in the file and in this sample'), compositionTable());
    if (state.method === 'stratified' && state.strata) body.push(h('h3', null, 'Combinations'), strataTable());
    els.sampleBody.replaceChildren(...body);
    els.sampleDialog.showModal();
  }

  function updateProgress() {
    const n = state.items.length;
    const done = state.items.filter((item) => statusOf(item) === 'done').length;
    els.progressText.replaceChildren(h('b', null, done), ` / ${n} complete`);
    els.nextIncomplete.hidden = done === n;
  }

  function renderStrip() {
    const n = state.items.length;
    els.strip.style.setProperty('--cols', String(Math.min(n, 100)));
    els.strip.style.setProperty('--cols-narrow', String(Math.min(n, 25)));
    els.strip.replaceChildren(
      ...state.items.map((_, i) => h('button', { type: 'button', class: 'cell', tabindex: '-1', 'data-index': i })),
    );
    updateStrip();
  }

  function updateStrip() {
    Array.from(els.strip.children).forEach((cell, i) => {
      const status = statusOf(state.items[i]);
      cell.className = `cell ${status}${i === state.current ? ' current' : ''}`;
      cell.title = `Example ${i + 1}: ${STATUS_TEXT[status]}`;
      cell.setAttribute('aria-label', cell.title);
      if (i === state.current) cell.setAttribute('aria-current', 'true');
      else cell.removeAttribute('aria-current');
    });
  }

  function updateStatusPill() {
    const status = statusOf(state.items[state.current]);
    els.statusPill.className = `status-pill ${status}`;
    els.statusPill.textContent = status === 'done' ? 'Complete' : status === 'partial' ? 'In progress' : 'Not started';
  }

  function renderExample() {
    const item = state.items[state.current];
    const rec = item.rec;
    const last = state.items.length - 1;

    els.exPos.textContent = `${state.current + 1} of ${state.items.length}`;
    const clip = typeof rec.clip_id === 'string' ? rec.clip_id : '';
    els.statusPill = h('span', { class: 'status-pill' });
    els.exMeta.replaceChildren(
      h('span', null, 'plan ', h('code', null, rec.plan_id ?? '—')),
      h('span', null, 'clip ', h('code', null, clip || '—'),
        /^[A-Za-z0-9_-]{11}$/.test(clip)
          ? [' ', h('a', {
              href: `https://www.youtube.com/watch?v=${clip}`,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: 'Open the source video on YouTube (MusicCaps clip ids are YouTube ids)',
            }, 'YouTube ↗')]
          : null),
      h('span', null, `source line ${fmtInt(item.line + 1)}`),
      els.statusPill,
    );
    updateStatusPill();
    els.prev.disabled = els.prev2.disabled = state.current === 0;
    els.next.disabled = els.next2.disabled = state.current === last;

    els.graph.replaceChildren(Graph.renderGraph(rec.graph_description));
    els.graphRaw.textContent = rec.graph_description == null ? '(missing)' : String(rec.graph_description);
    if (els.graph.querySelector('.g-error')) els.graphRaw.closest('details').open = true;

    els.caption.textContent = rec.caption == null ? '(no caption)' : String(rec.caption);

    const variants = Array.isArray(rec.prompt_variants) ? rec.prompt_variants : [];
    const count = Math.max(3, variants.length);
    els.prompts.replaceChildren(
      ...Array.from({ length: count }, (_, i) => {
        const text = variants[i];
        return h('li', { class: 'prompt' },
          h('span', { class: 'al-badge' }, `AL${i}`),
          typeof text === 'string'
            ? h('p', { class: 'prompt-text' }, withNumbers(text))
            : h('p', { class: 'prompt-text prompt-missing' }, '(missing)'));
      }),
    );

    renderCriteria();
  }

  function renderCriteria() {
    const item = state.items[state.current];
    const ann = annotationOf(item) || Core.emptyAnnotation();
    els.criteria.replaceChildren(...CRITERIA.map((c) => renderCriterion(c, item.rec, ann)));
  }

  /** Re-render one criterion card in place (keeps the other cards' textareas untouched). */
  function refreshCriterion(key, focusSelector) {
    const c = CRITERIA.find((x) => x.key === key);
    const old = els.criteria.querySelector(`.crit[data-key="${key}"]`);
    if (!c || !old) return;
    const item = state.items[state.current];
    const fresh = renderCriterion(c, item.rec, annotationOf(item) || Core.emptyAnnotation());
    const oldText = old.querySelector('textarea');
    const newText = fresh.querySelector('textarea');
    if (oldText.style.height) newText.style.height = oldText.style.height;
    old.replaceWith(fresh);
    const target = focusSelector && fresh.querySelector(focusSelector);
    if (target) target.focus();
  }

  function renderCriterion(c, rec, ann) {
    const verdict = ann[c.key];
    const hideJudge = state.blind && !verdict;
    const textarea = h('textarea', {
      id: `just-${c.key}`,
      'data-key': c.key,
      rows: 3,
      placeholder: 'Justification',
    });
    textarea.value = ann[`${c.key}_justification`] || '';

    return h('section', { class: 'crit', 'data-key': c.key, 'aria-labelledby': `crit-${c.key}` },
      h('header', { class: 'crit-head' },
        h('h3', { id: `crit-${c.key}` }, c.label, h('code', { class: 'crit-key' }, c.key)),
        h('p', { class: 'crit-hint' }, c.hint)),
      hideJudge
        ? h('div', { class: 'judge judge-hidden' }, 'Judge verdict hidden until you choose yours.')
        : renderJudge(c, rec),
      h('div', { class: 'you-row' },
        h('span', { class: 'who' }, 'You'),
        h('div', { class: 'seg', role: 'group', 'aria-label': `Your verdict: ${c.label}` },
          verdictButton(c, 'pass', verdict),
          verdictButton(c, 'fail', verdict)),
        renderAgreement(c, rec, verdict)),
      h('label', { class: 'sr-only', for: `just-${c.key}` }, `Justification for ${c.label}`),
      textarea);
  }

  function verdictButton(c, value, current) {
    return h('button', {
      type: 'button',
      class: value,
      'data-key': c.key,
      'data-verdict': value,
      'aria-pressed': current === value ? 'true' : 'false',
    },
    h('span', { class: 'opt-icon', 'aria-hidden': 'true' }, value === 'pass' ? '✓' : '✕'),
    value === 'pass' ? 'Pass' : 'Fail');
  }

  function renderJudge(c, rec) {
    const value = rec[c.key];
    const tags = [];
    if (Array.isArray(rec[c.tags])) tags.push(...rec[c.tags]);
    if (typeof rec[c.reason] === 'string' && rec[c.reason]) tags.push(rec[c.reason]);
    const why = typeof rec[c.why] === 'string' ? rec[c.why].trim() : '';
    return h('div', { class: 'judge' },
      h('div', { class: 'judge-row' },
        h('span', { class: 'who' }, 'Judge'),
        h('span', { class: `chip ${judgeTone(value)}` }, value == null ? 'no verdict' : String(value)),
        tags.map((t) => h('span', { class: 'tag' }, String(t)))),
      why ? renderWhy(why) : null);
  }

  /** The judge's rationale, with its "1:" / "0->1:" variant prefix shown as a badge. */
  function renderWhy(text) {
    const m = /^(\d+)(?:\s*->\s*(\d+))?\s*:\s*/.exec(text);
    if (!m) return h('p', { class: 'why' }, text);
    const ref = m[2] != null ? `AL${m[1]} → AL${m[2]}` : `AL${m[1]}`;
    return h('p', { class: 'why' }, h('span', { class: 'why-ref' }, ref), text.slice(m[0].length));
  }

  function renderAgreement(c, rec, verdict) {
    const judge = judgeAsPassFail(rec[c.key]);
    if (!verdict || !judge) return h('span', { class: 'agree' });
    return verdict === judge
      ? h('span', { class: 'agree' }, 'Agrees with judge')
      : h('span', { class: 'agree disagree' }, 'Disagrees with judge');
  }

  function renderSaveStatus() {
    if (state.storageOk) {
      els.saveStatus.className = 'save-status';
      els.saveStatus.replaceChildren(
        'Saved automatically in this browser. ',
        h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' move between examples.');
    } else {
      els.saveStatus.className = 'save-status error';
      els.saveStatus.textContent =
        'This browser is not letting the page save progress. Download your results before closing the tab.';
    }
  }

  // --------------------------------------------------------------- actions

  function setVerdict(key, value) {
    const item = state.items[state.current];
    const ann = ensureAnnotation(item);
    ann[key] = ann[key] === value ? null : value;
    saveSession();
    refreshCriterion(key, `button[data-verdict="${value}"]`);
    afterEdit();
  }

  function setJustification(key, text) {
    const ann = ensureAnnotation(state.items[state.current]);
    ann[`${key}_justification`] = text;
    saveSession();
    afterEdit();
  }

  function afterEdit() {
    updateStrip();
    updateProgress();
    updateStatusPill();
  }

  function download() {
    const n = state.items.length;
    if (!n) return;
    const incomplete = state.items.filter((item) => statusOf(item) !== 'done').length;
    if (
      incomplete &&
      !window.confirm(
        `${incomplete} of ${n} examples are missing at least one verdict; those are exported as null.\n\nDownload anyway?`,
      )
    ) {
      return;
    }
    const text = Core.buildExport(state.items, state.annotations);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const name = exportName();
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloaded ${n} rows to ${name}`);
  }

  /**
   * e.g. musiccaps_prompt_report.validated.stratified.seed-k3x9q2.2026-11-10.jsonl. A reopened
   * results file shown whole keeps its original name with today's date.
   */
  function exportName() {
    const date = new Date().toISOString().slice(0, 10);
    const stem = state.source.replace(/\.(jsonl|ndjson|json|txt)$/i, '');
    if (state.method === 'all') {
      const prev = /^(.*\.validated(?:\.stratified)?\.seed-[A-Za-z0-9_-]+)\.\d{4}-\d{2}-\d{2}$/.exec(stem);
      return `${prev ? prev[1] : `${stem}.validated`}.${date}.jsonl`;
    }
    const base = stem.replace(/\.validated\..*$/, '') || 'results';
    const tag = state.method === 'stratified' ? 'stratified.' : '';
    return `${base}.validated.${tag}seed-${state.seed}.${date}.jsonl`;
  }

  function newSample() {
    const kind = state.sampling === 'stratified' ? 'stratified sample' : 'random sample';
    const started = state.items.some((item) => !Core.isAnnotationEmpty(annotationOf(item)));
    const back = new URLSearchParams({ seed: state.seed });
    if (state.sampling === 'stratified') back.set('sampling', 'stratified');
    const message = started
      ? `Draw a new ${kind} of ${state.items.length}?\n\nYour work on seed "${state.seed}" stays saved in this browser; open the page with ?${back} to return to it.`
      : `Draw a new ${kind} of ${state.items.length}?`;
    if (!window.confirm(message)) return;
    saveSession();
    startSession(Core.newSeed());
    toast(`New ${kind}, seed ${state.seed}`);
  }

  function setSampling(next) {
    if (next === state.sampling || !state.items.length) return;
    saveSession();
    state.sampling = next;
    startSession(state.seed);
    toast(`${next === 'stratified' ? 'Stratified' : 'Random'} sample, seed ${state.seed}. Each sample keeps its own progress.`);
  }

  // ---------------------------------------------------------------- wiring

  function cacheEls() {
    const byId = (id) => document.getElementById(id);
    Object.assign(els, {
      srcInfo: byId('src-info'),
      progressText: byId('progress-text'),
      nextIncomplete: byId('btn-next-incomplete'),
      blind: byId('blind-toggle'),
      open: byId('btn-open'),
      samplingWrap: byId('sampling-wrap'),
      sampling: byId('sampling-select'),
      sampleInfo: byId('btn-sample-info'),
      sampleDialog: byId('sample-dialog'),
      sampleTitle: byId('sample-dialog-title'),
      sampleBody: byId('sample-dialog-body'),
      newSample: byId('btn-new'),
      download: byId('btn-download'),
      strip: byId('strip'),
      prev: byId('btn-prev'),
      next: byId('btn-next'),
      prev2: byId('btn-prev-2'),
      next2: byId('btn-next-2'),
      exPos: byId('ex-pos'),
      exMeta: byId('ex-meta'),
      main: byId('main'),
      paneGraph: byId('pane-graph'),
      paneText: byId('pane-text'),
      review: byId('review'),
      graph: byId('graph'),
      graphRaw: byId('graph-raw'),
      caption: byId('caption'),
      prompts: byId('prompts'),
      criteria: byId('criteria'),
      saveStatus: byId('save-status'),
      loader: byId('loader'),
      loadTitle: byId('load-title'),
      loadProgress: byId('load-progress'),
      loadBar: byId('load-fill').parentElement,
      loadFill: byId('load-fill'),
      loadDetail: byId('load-detail'),
      picker: byId('picker'),
      pickerReason: byId('picker-reason'),
      drop: byId('drop'),
      cancelPicker: byId('btn-cancel-picker'),
      fileInput: byId('file-input'),
      toast: byId('toast'),
    });
  }

  function bindEvents() {
    els.prev.addEventListener('click', () => go(state.current - 1));
    els.next.addEventListener('click', () => go(state.current + 1));
    els.prev2.addEventListener('click', () => go(state.current - 1));
    els.next2.addEventListener('click', () => go(state.current + 1));
    els.nextIncomplete.addEventListener('click', nextIncomplete);
    els.download.addEventListener('click', download);
    els.newSample.addEventListener('click', newSample);
    els.sampling.addEventListener('change', () => setSampling(cleanSampling(els.sampling.value) || 'random'));
    els.sampleInfo.addEventListener('click', openSampleDialog);
    els.sampleDialog.addEventListener('click', (e) => {
      if (e.target === els.sampleDialog) els.sampleDialog.close(); // backdrop
    });
    els.open.addEventListener('click', () => els.fileInput.click());
    els.cancelPicker.addEventListener('click', hideLoader);

    els.strip.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) go(Number(cell.dataset.index));
    });

    els.blind.addEventListener('change', () => {
      state.blind = els.blind.checked;
      storage.set('blind', state.blind ? '1' : '0');
      if (state.items.length) renderCriteria();
    });

    els.criteria.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-verdict]');
      if (btn) setVerdict(btn.dataset.key, btn.dataset.verdict);
    });
    els.criteria.addEventListener('input', (e) => {
      if (e.target.matches('textarea[data-key]')) setJustification(e.target.dataset.key, e.target.value);
    });

    els.fileInput.addEventListener('change', () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      els.fileInput.value = '';
      if (file) openFile(file);
    });
    els.drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.drop.classList.add('over');
    });
    els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
    els.drop.addEventListener('drop', (e) => {
      e.preventDefault();
      els.drop.classList.remove('over');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) openFile(file);
    });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!state.items.length || !els.loader.hidden || els.sampleDialog.open) return;
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(state.current - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(state.current + 1);
      }
    });

    window.addEventListener('beforeunload', (e) => {
      const unsaved = !state.storageOk && state.items.some((item) => !Core.isAnnotationEmpty(annotationOf(item)));
      if (unsaved) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  async function boot() {
    cacheEls();
    bindEvents();
    state.blind = storage.get('blind') === '1';
    els.blind.checked = state.blind;

    const params = new URLSearchParams(location.search);
    state.n = clampInt(params.get('n'), 1, 10000, DEFAULT_SAMPLE_SIZE);
    const urls = params.get('data') ? [params.get('data')] : DEFAULT_DATA_URLS;

    showLoader(`Loading ${fileName(urls[0])}…`);
    let firstError = null;
    for (const url of urls) {
      let text;
      try {
        text = await fetchText(url, setLoadProgress);
      } catch (err) {
        firstError = firstError || err;
        continue;
      }
      openDataset(text, fileName(url), { preferUrl: true });
      return;
    }
    showPicker(urls[0], firstError);
  }

  boot();
})();
