/*
 * Parser and renderer for the edit-graph DSL stored in `graph_description`:
 *
 *   isolate_target: separate_audio(audio, description="guitar") -> target_stem, residual
 *   eq: target_stem -> apply_lowpass_filter(cutoff_frequency_hz=5721.8) -> prepared_stem
 *   bus: send_return(prepared_stem, dry=1.0, send=0.6, return=0.6) [apply_delay_effect(...)] -> processed_stem
 *   remix_target: mix_stems(stem=processed_stem, residual=residual) -> final_audio
 *
 * Each line is a named step: an optional input-variable list, calls joined by
 * "->", and an output-variable list. A call can carry a bracketed sub-chain
 * (the wet path of a send/return bus). Parsing and layout are DOM-free so they
 * can be checked from Node; rendering builds a CSS-grid signal-flow diagram.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RJVGraph = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class GraphSyntaxError extends Error {
    constructor(message) {
      super(message);
      this.name = 'GraphSyntaxError';
    }
  }

  // ------------------------------------------------------------- tokenizer

  const TOKEN =
    /(->)|([()[\],=:])|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/y;

  function unquote(s) {
    if (s[0] === '"') {
      try {
        return JSON.parse(s);
      } catch (e) {
        /* fall through to the lenient path */
      }
    }
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  function tokenize(src) {
    const toks = [];
    let pos = 0;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t') {
        pos++;
        continue;
      }
      TOKEN.lastIndex = pos;
      const m = TOKEN.exec(src);
      if (!m) throw new GraphSyntaxError(`unexpected "${ch}" at column ${pos + 1}`);
      if (m[1]) toks.push({ t: '->', pos });
      else if (m[2]) toks.push({ t: m[2], pos });
      else if (m[3]) toks.push({ t: 'str', v: unquote(m[3]), pos });
      else if (m[4]) toks.push({ t: 'num', v: Number(m[4]), raw: m[4], pos });
      else toks.push({ t: 'id', v: m[5], pos });
      pos = TOKEN.lastIndex;
    }
    return toks;
  }

  // ---------------------------------------------------------------- parser

  class Parser {
    constructor(toks) {
      this.toks = toks;
      this.i = 0;
    }
    peek(o = 0) {
      return this.toks[this.i + o];
    }
    is(t, o = 0) {
      const k = this.peek(o);
      return !!k && k.t === t;
    }
    eat(t) {
      if (!this.is(t)) throw this.err(`expected "${t}"`);
      return this.toks[this.i++];
    }
    err(msg) {
      const k = this.peek();
      return new GraphSyntaxError(k ? `${msg} at column ${k.pos + 1}` : `${msg} at end of line`);
    }
    pipeline() {
      const segs = [this.segment()];
      while (this.is('->')) {
        this.i++;
        segs.push(this.segment());
      }
      return segs;
    }
    segment() {
      if (this.is('id') && this.is('(', 1)) return this.call();
      if (this.is('id')) {
        const names = [this.eat('id').v];
        while (this.is(',')) {
          this.i++;
          names.push(this.eat('id').v);
        }
        return { kind: 'vars', names };
      }
      throw this.err('expected a call or a variable name');
    }
    call() {
      const fn = this.eat('id').v;
      this.eat('(');
      const args = [];
      while (!this.is(')')) {
        args.push(this.arg());
        if (!this.is(',')) break;
        this.i++;
      }
      this.eat(')');
      let chain = null;
      if (this.is('[')) {
        this.i++;
        chain = this.pipeline();
        this.eat(']');
        if (chain.some((s) => s.kind !== 'call')) {
          throw new GraphSyntaxError(`only calls are allowed inside ${fn}[...]`);
        }
      }
      return { kind: 'call', fn, args, chain };
    }
    arg() {
      let name = null;
      if (this.is('id') && this.is('=', 1)) {
        name = this.eat('id').v;
        this.i++;
      }
      const k = this.peek();
      if (!k || (k.t !== 'num' && k.t !== 'str' && k.t !== 'id')) throw this.err('expected a value');
      this.i++;
      return { name, type: k.t, value: k.v, raw: k.t === 'num' ? k.raw : undefined, ref: false };
    }
  }

  function makeStep(name, segs) {
    const ops = segs.slice();
    const inputs = ops.length > 1 && ops[0].kind === 'vars' ? ops.shift().names : [];
    const outputs = ops.length > 1 && ops[ops.length - 1].kind === 'vars' ? ops.pop().names : [];
    if (!ops.length) throw new GraphSyntaxError(`step "${name}" has no operations`);
    if (ops.some((op) => op.kind !== 'call')) {
      throw new GraphSyntaxError(`step "${name}" has a variable list in the middle of its chain`);
    }
    return { name, inputs, outputs, ops };
  }

  /** Work out which step feeds which, plus the graph's external inputs and final outputs. */
  function resolve(steps) {
    const producer = new Map(); // variable -> index of the step that last wrote it
    const external = [];
    const edges = []; // { from: stepIndex | -1 (external), to: stepIndex, name }
    steps.forEach((step, i) => {
      const reads = [...step.inputs];
      const visit = (op) => {
        for (const a of op.args) {
          if (a.type !== 'id') continue;
          // Positional names are data inputs; keyword names only when they name a known variable.
          if (a.name === null || producer.has(a.value)) {
            a.ref = true;
            reads.push(a.value);
          }
        }
        (op.chain || []).forEach(visit);
      };
      step.ops.forEach(visit);
      step.reads = [...new Set(reads)];
      for (const v of step.reads) {
        if (producer.has(v)) {
          edges.push({ from: producer.get(v), to: i, name: v });
        } else {
          if (!external.includes(v)) external.push(v);
          edges.push({ from: -1, to: i, name: v });
        }
      }
      step.outputs.forEach((v) => producer.set(v, i));
    });
    const finals = [];
    steps.forEach((step, i) => {
      for (const v of step.outputs) {
        if (!edges.some((e) => e.from === i && e.name === v)) finals.push({ from: i, name: v });
      }
    });
    return { steps, external, edges, finals };
  }

  function parseGraph(text) {
    const steps = [];
    for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const p = new Parser(tokenize(line));
      let name = null;
      if (p.is('id') && p.is(':', 1)) {
        name = p.eat('id').v;
        p.i++;
      }
      const segs = p.pipeline();
      if (p.peek()) throw p.err('unexpected token');
      steps.push(makeStep(name || `step_${steps.length + 1}`, segs));
    }
    if (!steps.length) throw new GraphSyntaxError('the graph is empty');
    return resolve(steps);
  }

  // ---------------------------------------------------------------- layout

  /**
   * Rows run top to bottom: [input terminal], steps..., [output terminal].
   * Variables flowing to the next row become connectors in the main lane;
   * variables that skip rows (e.g. `residual`) get their own bypass lane.
   */
  function layoutGraph(g) {
    const rows = [];
    if (g.external.length) rows.push({ kind: 'input', names: g.external });
    const offset = rows.length;
    g.steps.forEach((step) => rows.push({ kind: 'step', step }));
    if (g.finals.length) rows.push({ kind: 'output', names: g.finals.map((f) => f.name) });
    const outRow = rows.length - 1;

    const links = g.edges.map((e) => ({
      from: e.from < 0 ? 0 : e.from + offset,
      to: e.to + offset,
      name: e.name,
    }));
    g.finals.forEach((f) => links.push({ from: f.from + offset, to: outRow, name: f.name }));

    const groups = new Map();
    for (const l of links) {
      const key = `${l.from}>${l.to}`;
      if (!groups.has(key)) groups.set(key, { from: l.from, to: l.to, names: [] });
      const grp = groups.get(key);
      if (!grp.names.includes(l.name)) grp.names.push(l.name);
    }
    const conns = [];
    const bypasses = [];
    for (const grp of groups.values()) (grp.to === grp.from + 1 ? conns : bypasses).push(grp);

    // Interval colouring: bypasses that do not overlap share a lane.
    bypasses.sort((a, b) => a.from - b.from || a.to - b.to);
    const laneEnds = [];
    for (const b of bypasses) {
      let lane = laneEnds.findIndex((end) => end <= b.from);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = b.to;
      b.lane = lane;
    }
    rows.forEach((r, i) => {
      r.span = bypasses.some((b) => b.from === i || b.to === i);
    });
    return { rows, conns, bypasses, lanes: laneEnds.length };
  }

  // ------------------------------------------------------------ formatting

  const FN_NAMES = {
    separate_audio: 'Separate audio',
    mix_stems: 'Mix stems',
    send_return: 'Send / return bus',
    apply_lowshelf_filter: 'Low-shelf filter',
    apply_highshelf_filter: 'High-shelf filter',
    apply_lowpass_filter: 'Low-pass filter',
    apply_highpass_filter: 'High-pass filter',
    apply_peak_filter: 'Peak filter',
    apply_compressor_effect: 'Compressor',
    apply_limiter_effect: 'Limiter',
    apply_gain: 'Gain',
  };

  function prettyFn(fn) {
    if (FN_NAMES[fn]) return FN_NAMES[fn];
    const s = fn.replace(/^apply_/, '').replace(/_(effect|filter)$/, (m, w) => (w === 'filter' ? ' filter' : '')).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function category(fn) {
    if (/separate|mix_stems|send_return|split|merge|bus|route/.test(fn)) return 'route';
    if (/filter|shelf|pass|eq|notch|peak/.test(fn)) return 'eq';
    if (/compress|limit|gate|expand|transient/.test(fn)) return 'dyn';
    if (/reverb|delay|echo/.test(fn)) return 'space';
    if (/chorus|phaser|flanger|tremolo|vibrato/.test(fn)) return 'mod';
    return 'tone'; // gain, distortion, harmony, pitch, ...
  }

  const UNITS = { hz: 'Hz', db: 'dB', ms: 'ms', seconds: 's', sec: 's', s: 's' };
  const LABELS = { q: 'Q', cutoff_frequency: 'cutoff', centre_frequency: 'centre freq', center_frequency: 'center freq' };

  function paramMeta(name) {
    if (!name) return { label: '', unit: '' };
    if (name === 'ratio') return { label: 'ratio', unit: ':1' };
    if (name === 'semitones') return { label: 'shift', unit: ' st', signed: true };
    let label = name;
    let unit = '';
    const m = /^(.+?)_(hz|db|ms|seconds|sec|s)$/i.exec(name);
    if (m) {
      label = m[1];
      unit = ' ' + UNITS[m[2].toLowerCase()];
    }
    return { label: LABELS[label] || label.replace(/_/g, ' '), unit };
  }

  /** Compact display value; the full-precision value is kept in a tooltip. */
  function fmtNum(v) {
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    const digits = a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
    let s = v.toFixed(digits);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  // ------------------------------------------------------------- rendering

  const LEVEL_HELP = {
    dry: 'Level of the unprocessed signal passed straight through',
    send: 'Level sent into the effect chain',
    return: 'Level of the effect chain output mixed back in',
  };

  function renderGraph(text) {
    const { h } = globalThis.RJVDom;
    let layout;
    try {
      layout = layoutGraph(parseGraph(text));
    } catch (err) {
      return h('div', { class: 'g-error', role: 'note' },
        h('strong', null, 'Could not draw this graph'),
        ` (${err.message}). The raw description is below.`);
    }

    const param = (a) => {
      const meta = paramMeta(a.name);
      let value;
      let full;
      if (a.type === 'num') {
        const sign = meta.signed && a.value > 0 ? '+' : '';
        value = h('span', { class: 'g-num' }, sign + fmtNum(a.value) + meta.unit);
        full = a.raw;
      } else if (a.type === 'str') {
        value = h('span', { class: 'g-str' }, a.value);
        full = JSON.stringify(a.value);
      } else {
        value = h('span', { class: a.ref ? 'g-ref' : 'g-lit' }, a.value);
        full = a.value;
      }
      return h('span', { class: 'g-param', title: a.name ? `${a.name} = ${full}` : full },
        meta.label ? h('span', { class: 'g-k' }, meta.label) : null,
        value);
    };

    const head = (op) =>
      h('div', { class: 'g-op-head' },
        h('span', { class: 'g-op-name' }, prettyFn(op.fn)),
        h('code', { class: 'g-op-fn' }, op.fn));

    const mini = () => h('div', { class: 'g-mini', 'aria-hidden': 'true' });

    const chainOf = (ops) => {
      const out = [];
      ops.forEach((op, i) => {
        if (i) out.push(mini());
        out.push(op.chain ? bus(op) : plain(op));
      });
      return out;
    };

    const plain = (op) => {
      const params = op.args.filter((a) => !(a.name === null && a.ref));
      return h('div', { class: `g-op cat-${category(op.fn)}` },
        head(op),
        params.length ? h('div', { class: 'g-params' }, params.map(param)) : null);
    };

    const bus = (op) => {
      const level = (k) => op.args.find((a) => a.name === k && a.type === 'num');
      const dry = level('dry');
      const send = level('send');
      const ret = level('return');
      const rest = op.args.filter((a) => !(a.name === null && a.ref) && a !== dry && a !== send && a !== ret);
      const tag = (k, a) =>
        h('span', { class: `g-level g-level-${k}`, title: `${LEVEL_HELP[k]} (${k} = ${a.raw})` },
          `${k} ×${fmtNum(a.value)}`);
      return h('div', { class: `g-op g-bus cat-${category(op.fn)}` },
        head(op),
        rest.length ? h('div', { class: 'g-params' }, rest.map(param)) : null,
        h('div', { class: dry ? 'g-bus-body' : 'g-bus-body no-dry' },
          dry ? h('div', { class: 'g-bus-dry' }, tag('dry', dry)) : null,
          h('div', { class: 'g-bus-wet' },
            send ? [tag('send', send), mini()] : null,
            chainOf(op.chain),
            ret ? [mini(), tag('return', ret)] : null),
          h('div', { class: 'g-bus-sum' },
            h('span', { class: 'g-sum-icon', 'aria-hidden': 'true' }, '+'),
            dry ? 'dry + return' : 'return')));
    };

    const step = (s) =>
      h('section', { class: 'g-step', 'aria-label': `Step ${s.name}` },
        h('div', { class: 'g-step-name' }, s.name),
        chainOf(s.ops));

    const terminal = (row) =>
      h('div', { class: `g-term g-term-${row.kind}` },
        h('span', { class: 'g-term-kind' }, row.kind === 'input' ? 'Input' : 'Output'),
        h('code', null, row.names.join(', ')));

    const place = (el, row, col) => {
      el.style.gridRow = String(row);
      el.style.gridColumn = col;
      return el;
    };

    const { rows, conns, bypasses, lanes } = layout;
    const flow = h('div', { class: 'g-flow' });
    flow.style.gridTemplateColumns = 'minmax(0, 1fr)' + ' var(--g-lane)'.repeat(lanes);

    rows.forEach((row, i) => {
      flow.append(place(row.kind === 'step' ? step(row.step) : terminal(row), 2 * i + 1, row.span ? '1 / -1' : '1'));
      if (i < rows.length - 1 && !conns.some((c) => c.from === i)) {
        flow.append(place(h('div', { class: 'g-gap' }), 2 * i + 2, '1'));
      }
    });
    for (const c of conns) {
      const between = rows[c.from].kind === 'step' && rows[c.to].kind === 'step';
      flow.append(place(
        h('div', { class: 'g-conn' }, between ? h('code', { class: 'g-var' }, c.names.join(', ')) : null),
        2 * c.from + 2, '1'));
    }
    for (const b of bypasses) {
      flow.append(place(
        h('div', { class: 'g-bypass', title: `${b.names.join(', ')} skips the steps alongside it` },
          h('code', { class: 'g-var' }, b.names.join(', '))),
        `${2 * b.from + 2} / ${2 * b.to + 1}`, String(2 + b.lane)));
    }
    return h('div', { class: 'g-root' }, flow);
  }

  return {
    GraphSyntaxError,
    tokenize,
    parseGraph,
    layoutGraph,
    renderGraph,
    prettyFn,
    paramMeta,
    fmtNum,
    category,
  };
});
