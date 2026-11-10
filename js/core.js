/*
 * Core logic for the judge-validation page: hashing, seeded sampling,
 * annotation bookkeeping and JSONL export. No DOM access, so it can be
 * exercised from Node as well as the browser.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RJVCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Criteria in export order. */
  var CRITERIA = ['al_rules', 'al_consistency', 'stylistic'];

  /** Output keys appended to every exported line, in order. */
  var USER_KEYS = [];
  CRITERIA.forEach(function (c) {
    USER_KEYS.push('user_' + c, 'user_' + c + '_justification');
  });

  /** Extra keys appended after the user keys for rows from a stratified sample. */
  var SAMPLE_KEYS = ['sample_stratum', 'sample_weight'];
  var APPENDED_KEYS = USER_KEYS.concat(SAMPLE_KEYS);

  /** A judge verdict as a stratum value; missing or empty verdicts become 'none'. */
  function verdictKey(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : 'none';
  }

  /** e.g. "al_rules=pass|al_consistency=fail|stylistic=appropriate" */
  function stratumKey(values) {
    return CRITERIA.map(function (c, i) {
      return c + '=' + values[i];
    }).join('|');
  }

  // ---------------------------------------------------------------- hashing

  /** cyrb53: fast 53-bit string hash (as a number). */
  function cyrb53(str) {
    var h1 = 0xdeadbeef;
    var h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  /** Content fingerprint used to namespace saved progress per dataset. */
  function hashString(str) {
    return cyrb53(str).toString(36);
  }

  /** Deterministic PRNG (mulberry32) seeded from an arbitrary string. */
  function rngFromSeed(seedStr) {
    var a = cyrb53(String(seedStr)) >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Short random seed such as "k3x9q2". */
  function newSeed() {
    var n;
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.getRandomValues) {
      var buf = new Uint32Array(1);
      c.getRandomValues(buf);
      n = buf[0];
    } else {
      n = Math.floor(Math.random() * 4294967296);
    }
    return (n % 2176782336).toString(36).padStart(6, '0'); // 36^6
  }

  // --------------------------------------------------------------- sampling

  /**
   * Pick `n` records from `lines` using a permutation seeded by `seed`.
   * Blank lines and lines that are not JSON objects are skipped. When the file
   * has `n` or fewer non-blank lines, all of them are used in file order.
   * Returns { method: 'random' | 'all', items: [{ line, raw, rec }], skipped, total }.
   */
  function sampleRecords(lines, seed, n) {
    var pool = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) pool.push(i);
    }
    var items = [];
    var skipped = 0;

    function take(idx) {
      var raw = lines[idx].trim();
      var rec;
      try {
        rec = JSON.parse(raw);
      } catch (e) {
        skipped++;
        return;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        skipped++;
        return;
      }
      items.push({ line: idx, raw: raw, rec: rec });
    }

    if (pool.length <= n) {
      pool.forEach(take);
    } else {
      // Partial Fisher-Yates: the first k picks are the same for any n >= k.
      var rand = rngFromSeed(seed);
      for (var k = 0; k < pool.length && items.length < n; k++) {
        var j = k + Math.floor(rand() * (pool.length - k));
        var tmp = pool[k];
        pool[k] = pool[j];
        pool[j] = tmp;
        take(pool[k]);
      }
    }
    return { method: pool.length <= n ? 'all' : 'random', items: items, skipped: skipped, total: pool.length };
  }

  /**
   * One pass over the file grouping rows by the judge's verdict pattern.
   * Rows with a missing verdict are kept apart (`missing`) and never stratified.
   * `marginals[criterion][verdict]` counts every readable row.
   */
  function buildFrame(lines) {
    var byKey = {};
    var strata = [];
    var missing = [];
    var marginals = {};
    var unreadable = 0;
    var total = 0;
    CRITERIA.forEach(function (c) {
      marginals[c] = {};
    });
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      total++;
      var rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch (e) {
        unreadable++;
        continue;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        unreadable++;
        continue;
      }
      var values = CRITERIA.map(function (c) {
        return verdictKey(rec[c]);
      });
      values.forEach(function (v, k) {
        marginals[CRITERIA[k]][v] = (marginals[CRITERIA[k]][v] || 0) + 1;
      });
      if (values.indexOf('none') >= 0) {
        missing.push(i);
        continue;
      }
      var key = stratumKey(values);
      if (!byKey[key]) {
        byKey[key] = { key: key, values: values, lines: [] };
        strata.push(byKey[key]);
      }
      byKey[key].lines.push(i);
    }
    strata.sort(function (a, b) {
      return b.lines.length - a.lines.length || (a.key < b.key ? -1 : 1);
    });
    return {
      strata: strata,
      missing: missing,
      marginals: marginals,
      unreadable: unreadable,
      total: total,
      readable: total - unreadable,
    };
  }

  /**
   * Equal allocation with caps ("water filling"): every stratum gets the same
   * share of `n`, a stratum smaller than its share gives all of its rows, and
   * what it cannot take is shared among the rest. Leftover units (fewer than
   * the open strata) go one each to the largest strata.
   */
  function allocateEqual(sizes, n) {
    var alloc = sizes.map(function () {
      return 0;
    });
    var remaining = Math.min(n, sizes.reduce(function (a, b) {
      return a + b;
    }, 0));
    var open = sizes.map(function (_, h) {
      return h;
    }).filter(function (h) {
      return sizes[h] > 0;
    });
    while (remaining > 0 && open.length) {
      var share = Math.floor(remaining / open.length);
      if (share === 0) {
        open.sort(function (a, b) {
          return sizes[b] - sizes[a] || a - b;
        });
        open.slice(0, remaining).forEach(function (h) {
          alloc[h]++;
        });
        break;
      }
      open.forEach(function (h) {
        var give = Math.min(share, sizes[h] - alloc[h]);
        alloc[h] += give;
        remaining -= give;
      });
      open = open.filter(function (h) {
        return alloc[h] < sizes[h];
      });
    }
    return alloc;
  }

  /**
   * Stratified random sample: rows are grouped by the judge's verdicts on all
   * criteria, each group gets an equal share of `n` (see allocateEqual), and a
   * seeded simple random sample is drawn within each group. Each item carries
   * `sample: { stratum, weight }` where weight = rows in group / rows drawn.
   * Review order is shuffled so groups are not shown in runs.
   */
  function stratifiedSample(lines, seed, n, frame) {
    frame = frame || buildFrame(lines);
    if (frame.total <= n) return sampleRecords(lines, seed, n);

    var alloc = allocateEqual(frame.strata.map(function (s) {
      return s.lines.length;
    }), n);
    var picked = [];
    frame.strata.forEach(function (s, h) {
      var k = alloc[h];
      if (!k) return;
      var pool = s.lines.slice();
      var rand = rngFromSeed(seed + '|' + s.key);
      for (var i = 0; i < k; i++) {
        var j = i + Math.floor(rand() * (pool.length - i));
        var tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
        picked.push({ line: pool[i], sample: { stratum: s.key, weight: s.lines.length / k } });
      }
    });
    var order = rngFromSeed(seed + '|order');
    for (var m = picked.length - 1; m > 0; m--) {
      var r = Math.floor(order() * (m + 1));
      var t = picked[m];
      picked[m] = picked[r];
      picked[r] = t;
    }
    var items = picked.map(function (p) {
      var raw = lines[p.line].trim();
      return { line: p.line, raw: raw, rec: JSON.parse(raw), sample: p.sample };
    });
    return {
      method: 'stratified',
      items: items,
      skipped: frame.unreadable,
      total: frame.total,
      excluded: frame.missing.length,
      strata: frame.strata.map(function (s, h) {
        return {
          key: s.key,
          values: s.values,
          population: s.lines.length,
          sampled: alloc[h],
          weight: alloc[h] ? s.lines.length / alloc[h] : null,
        };
      }),
    };
  }

  // ------------------------------------------------------------ annotations

  function emptyAnnotation() {
    var a = {};
    CRITERIA.forEach(function (c) {
      a[c] = null;
      a[c + '_justification'] = '';
    });
    return a;
  }

  function normVerdict(v) {
    if (typeof v !== 'string') return null;
    v = v.trim().toLowerCase();
    return v === 'pass' || v === 'fail' ? v : null;
  }

  /** Coerce anything stored or imported into a well-formed annotation. */
  function normalizeAnnotation(src) {
    var a = emptyAnnotation();
    if (!src || typeof src !== 'object') return a;
    CRITERIA.forEach(function (c) {
      a[c] = normVerdict(src[c]);
      var j = src[c + '_justification'];
      a[c + '_justification'] = typeof j === 'string' ? j : '';
    });
    return a;
  }

  /**
   * If a record already carries user_* fields (e.g. a previously exported
   * results file was loaded), turn them into an annotation; otherwise null.
   */
  function annotationFromRecord(rec) {
    var found = USER_KEYS.some(function (k) {
      return Object.prototype.hasOwnProperty.call(rec, k);
    });
    if (!found) return null;
    var src = {};
    CRITERIA.forEach(function (c) {
      src[c] = rec['user_' + c];
      src[c + '_justification'] = rec['user_' + c + '_justification'];
    });
    return normalizeAnnotation(src);
  }

  /** 'done' when every criterion has a verdict, 'partial' when anything is filled. */
  function annotationStatus(a) {
    if (!a) return 'empty';
    var verdicts = 0;
    var text = false;
    CRITERIA.forEach(function (c) {
      if (a[c]) verdicts++;
      if ((a[c + '_justification'] || '').trim()) text = true;
    });
    if (verdicts === CRITERIA.length) return 'done';
    return verdicts || text ? 'partial' : 'empty';
  }

  function isAnnotationEmpty(a) {
    return annotationStatus(a) === 'empty';
  }

  // ----------------------------------------------------------------- export

  /** JSON.stringify with every non-ASCII code unit escaped (matches Python's default). */
  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, function (ch) {
      return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
  }

  /** Serialise with Python json.dumps separators (", " and ": "). */
  function pyJson(value) {
    if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).map(function (k) {
        return asciiJson(k) + ': ' + pyJson(value[k]);
      }).join(', ') + '}';
    }
    return asciiJson(value === undefined ? null : value);
  }

  /** [[key, value], ...] for the six user fields, in export order. */
  function userFields(annotation) {
    var a = normalizeAnnotation(annotation);
    var out = [];
    CRITERIA.forEach(function (c) {
      out.push(['user_' + c, a[c]]);
      out.push(['user_' + c + '_justification', a[c + '_justification'].trim()]);
    });
    return out;
  }

  function hasAppendedKeys(obj) {
    return APPENDED_KEYS.some(function (k) {
      return Object.prototype.hasOwnProperty.call(obj, k);
    });
  }

  /**
   * Source line with any fields this tool appended earlier (user_*, sample_*)
   * removed, so a re-export does not duplicate keys. Returns null when that
   * cannot be done losslessly (the caller then re-serialises the parsed object).
   */
  function baseSourceLine(raw) {
    var rec = JSON.parse(raw);
    if (!hasAppendedKeys(rec)) return raw;
    var cut = raw.lastIndexOf(', "' + USER_KEYS[0] + '": ');
    if (cut < 0) return null;
    var candidate = raw.slice(0, cut) + '}';
    try {
      var base = JSON.parse(candidate);
      if (hasAppendedKeys(base)) return null;
      // Everything after the cut must have been appended fields only.
      var extra = Object.keys(rec).filter(function (k) {
        return !Object.prototype.hasOwnProperty.call(base, k);
      });
      var onlyAppended = extra.every(function (k) {
        return APPENDED_KEYS.indexOf(k) >= 0;
      });
      return onlyAppended && Object.keys(base).length + extra.length === Object.keys(rec).length
        ? candidate
        : null;
    } catch (e) {
      return null;
    }
  }

  /** Sampling metadata a previously exported stratified row already carries, if any. */
  function sampleMetaFromRecord(rec) {
    if (!rec || typeof rec.sample_stratum !== 'string' || typeof rec.sample_weight !== 'number') return null;
    return { stratum: rec.sample_stratum, weight: rec.sample_weight };
  }

  /**
   * The source JSONL line with the six user fields appended at the end, then
   * sample_stratum and sample_weight when `sample` is given. The original text
   * is kept byte-for-byte; if the line cannot be appended to safely, the
   * parsed object is re-serialised with the fields set instead.
   */
  function buildExportLine(raw, annotation, sample) {
    raw = String(raw).trim();
    var fields = userFields(annotation);
    if (sample) fields.push(['sample_stratum', sample.stratum], ['sample_weight', sample.weight]);
    var extra = fields.map(function (f) {
      return asciiJson(f[0]) + ': ' + asciiJson(f[1]);
    }).join(', ');

    var base = baseSourceLine(raw);
    if (base !== null) {
      var head = base.replace(/\}\s*$/, '');
      if (head !== base && head.charAt(0) === '{') {
        var line = head + (/^\{\s*$/.test(head) ? '' : ', ') + extra + '}';
        try {
          var check = JSON.parse(line);
          var ok = fields.every(function (f) {
            return check[f[0]] === f[1];
          });
          if (ok) return line;
        } catch (e) {
          /* fall through */
        }
      }
    }
    var rec = JSON.parse(raw);
    fields.forEach(function (f) {
      rec[f[0]] = f[1];
    });
    return pyJson(rec);
  }

  /**
   * Whole export file: one line per sampled item, in review order. Items from
   * a stratified sample carry their stratum and weight; rows reopened from an
   * earlier stratified export keep the values they were exported with.
   */
  function buildExport(items, annotations) {
    return items.map(function (it) {
      return buildExportLine(it.raw, annotations[it.line], it.sample || sampleMetaFromRecord(it.rec));
    }).join('\n') + '\n';
  }

  return {
    CRITERIA: CRITERIA,
    USER_KEYS: USER_KEYS,
    SAMPLE_KEYS: SAMPLE_KEYS,
    hashString: hashString,
    rngFromSeed: rngFromSeed,
    newSeed: newSeed,
    verdictKey: verdictKey,
    sampleRecords: sampleRecords,
    buildFrame: buildFrame,
    allocateEqual: allocateEqual,
    stratifiedSample: stratifiedSample,
    sampleMetaFromRecord: sampleMetaFromRecord,
    emptyAnnotation: emptyAnnotation,
    normalizeAnnotation: normalizeAnnotation,
    annotationFromRecord: annotationFromRecord,
    annotationStatus: annotationStatus,
    isAnnotationEmpty: isAnnotationEmpty,
    asciiJson: asciiJson,
    pyJson: pyJson,
    userFields: userFields,
    buildExportLine: buildExportLine,
    buildExport: buildExport,
  };
});
