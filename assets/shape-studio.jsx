import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";

/* ============================================================================
   MODEL
   ----------------------------------------------------------------------------
   Every coordinate is stored as { v: number, u: '%' | 'px' } so we can round-trip
   between CSS text and pixels without losing the author's chosen unit.

   Percentages resolve against the reference box: x against width, y against
   height. That is true for `to` (absolute) AND `by` (relative) values.
   ========================================================================== */

const uid = () => Math.random().toString(36).slice(2, 9);
const V = (v, u = "%") => ({ v, u });
const r2 = (n) => Math.round(n * 100) / 100;

const toPx = (val, basis) => (val.u === "%" ? (val.v * basis) / 100 : val.v);
const fromPx = (px, basis, u) => (u === "%" ? (basis ? (px * 100) / basis : 0) : px);
const setPx = (old, px, basis) => ({ v: r2(fromPx(px, basis, old.u)), u: old.u });
const fmt = (val) => `${r2(val.v)}${val.u}`;

const CP = (x, y, from = "origin") => ({ x, y, from });

/* ---------------------------------------------------------------- commands */

const COMMANDS = {
  move: "move",
  line: "line",
  hline: "hline",
  vline: "vline",
  curve: "curve",
  smooth: "smooth",
  arc: "arc",
  close: "close",
};

const BLURB = {
  move: "Lifts the pen and jumps. Starts a new subpath — nothing is drawn.",
  line: "Straight line to the endpoint.",
  hline: "Horizontal line. Only x changes; y is carried over.",
  vline: "Vertical line. Only y changes; x is carried over.",
  curve: "Bézier. One control point gives a quadratic, two give a cubic.",
  smooth: "Bézier that reflects the previous control point, so the join has no kink.",
  arc: "Elliptical arc. Radii, sweep, and size pick one of four possible arcs.",
  close: "Straight line back to the start of the current subpath.",
};

function makeCommand(type, cur, keepPoint = false) {
  const base = { id: uid(), type, rel: "to" };
  const x = V(r2(cur.xPct));
  const y = V(r2(cur.yPct));
  // A brand-new command lands a little past the current point so it is visible.
  // Switching an existing command's type keeps the point exactly where it was.
  const nx = keepPoint ? x : V(Math.min(100, r2(x.v + 25)));
  const ny = keepPoint ? y : V(Math.min(100, r2(y.v + 15)));

  switch (type) {
    case "close":
      return base;
    case "hline":
      return { ...base, x: nx, y };
    case "vline":
      return { ...base, x, y: ny };
    case "curve":
      return {
        ...base,
        x: nx,
        y: ny,
        cubic: true,
        c1: CP(V(r2(x.v + 8)), V(Math.max(0, r2(y.v - 22)))),
        c2: CP(V(r2(nx.v - 8)), V(Math.max(0, r2(ny.v - 22)))),
      };
    case "smooth":
      return {
        ...base,
        x: nx,
        y: ny,
        cubic: true,
        c1: CP(V(r2(nx.v - 8)), V(Math.min(100, r2(ny.v + 22)))),
      };
    case "arc":
      return {
        ...base,
        x: nx,
        y: ny,
        rx: V(20),
        ry: V(20),
        circle: true,
        sweep: "cw",
        size: "small",
        rotate: 0,
      };
    default:
      return { ...base, x: nx, y: ny };
  }
}

/* ============================================================================
   CSS SERIALISATION
   ========================================================================== */

function cpCss(cp, rel, compact) {
  const pair = `${fmt(cp.x)} ${fmt(cp.y)}`;
  // In `to` mode a bare pair is a <position>, i.e. measured from the origin.
  // In `by` mode a bare pair defaults to `from start`.
  if (compact) {
    if (rel === "to" && cp.from === "origin") return pair;
    if (rel === "by" && cp.from === "start") return pair;
  }
  return `${pair} from ${cp.from}`;
}

function cmdCss(c, compact) {
  switch (c.type) {
    case "close":
      return "close";
    case "hline":
      return `hline ${c.rel} ${fmt(c.x)}`;
    case "vline":
      return `vline ${c.rel} ${fmt(c.y)}`;
    case "curve": {
      const pts = [cpCss(c.c1, c.rel, compact)];
      if (c.cubic) pts.push(cpCss(c.c2, c.rel, compact));
      return `curve ${c.rel} ${fmt(c.x)} ${fmt(c.y)} with ${pts.join(" / ")}`;
    }
    case "smooth":
      return (
        `smooth ${c.rel} ${fmt(c.x)} ${fmt(c.y)}` +
        (c.cubic ? ` with ${cpCss(c.c1, c.rel, compact)}` : "")
      );
    case "arc": {
      let s = `arc ${c.rel} ${fmt(c.x)} ${fmt(c.y)} of ${fmt(c.rx)}`;
      if (!c.circle) s += ` ${fmt(c.ry)}`;
      if (!compact || c.sweep !== "ccw") s += ` ${c.sweep}`;
      if (!compact || c.size !== "small") s += ` ${c.size}`;
      if (c.rotate) s += ` rotate ${c.rotate}deg`;
      return s;
    }
    default:
      return `${c.type} ${c.rel} ${fmt(c.x)} ${fmt(c.y)}`;
  }
}

function shapeCss(shape, { compact = false, fillRule = true, multiline = true } = {}) {
  const head =
    (fillRule && shape.fillRule !== "nonzero" ? `${shape.fillRule} ` : "") +
    `from ${fmt(shape.from.x)} ${fmt(shape.from.y)}`;
  const parts = [head, ...shape.commands.map((c) => cmdCss(c, compact))];
  if (!multiline) return `shape(${parts.join(", ")})`;
  return `shape(\n  ${parts.join(",\n  ")}\n)`;
}

/* ============================================================================
   GEOMETRY — resolve the shape into pixels and an SVG path
   ----------------------------------------------------------------------------
   Smooth commands are expanded into explicit C/Q segments rather than S/T so we
   can draw the reflected control point that the browser infers.
   ========================================================================== */

function reflect(point, about) {
  return { x: 2 * about.x - point.x, y: 2 * about.y - point.y };
}

function resolveCp(cp, W, H, start, end) {
  const dx = toPx(cp.x, W);
  const dy = toPx(cp.y, H);
  if (cp.from === "origin") return { x: dx, y: dy };
  if (cp.from === "end") return { x: end.x + dx, y: end.y + dy };
  return { x: start.x + dx, y: start.y + dy };
}

function cpPatch(key, cp, p, W, H, start, end) {
  const anchor =
    cp.from === "origin" ? { x: 0, y: 0 } : cp.from === "end" ? end : start;
  return {
    [key]: {
      ...cp,
      x: setPx(cp.x, p.x - anchor.x, W),
      y: setPx(cp.y, p.y - anchor.y, H),
    },
  };
}

function evaluate(shape, W, H) {
  const n = (v) => (Number.isFinite(v) ? r2(v) : 0);
  const start0 = { x: toPx(shape.from.x, W), y: toPx(shape.from.y, H) };

  let cur = { ...start0 };
  let sub = { ...start0 };
  let prevCtrl = null;
  let prevKind = null;

  let d = `M ${n(cur.x)} ${n(cur.y)}`;
  const segments = [];
  const handles = [
    {
      key: "from",
      kind: "anchor",
      target: "shape",
      pt: start0,
      apply: (p) => ({
        from: { x: setPx(shape.from.x, p.x, W), y: setPx(shape.from.y, p.y, H) },
      }),
    },
  ];

  for (const c of shape.commands) {
    const start = { ...cur };
    let end = { ...cur };
    let seg = "";
    const segHandles = [];
    const ghosts = [];
    let tangents = [];

    const endTo = () => ({ x: toPx(c.x, W), y: toPx(c.y, H) });
    const endBy = () => ({ x: start.x + toPx(c.x, W), y: start.y + toPx(c.y, H) });

    const endPatch = (p) => {
      if (c.rel === "to") return { x: setPx(c.x, p.x, W), y: setPx(c.y, p.y, H) };
      return { x: setPx(c.x, p.x - start.x, W), y: setPx(c.y, p.y - start.y, H) };
    };

    switch (c.type) {
      case "close": {
        end = { ...sub };
        seg = "Z";
        cur = { ...end };
        prevCtrl = null;
        prevKind = null;
        break;
      }
      case "move": {
        end = c.rel === "to" ? endTo() : endBy();
        seg = `M ${n(end.x)} ${n(end.y)}`;
        sub = { ...end };
        segHandles.push({ key: "end", kind: "move", apply: endPatch });
        prevCtrl = null;
        prevKind = null;
        break;
      }
      case "line": {
        end = c.rel === "to" ? endTo() : endBy();
        seg = `L ${n(end.x)} ${n(end.y)}`;
        segHandles.push({ key: "end", kind: "point", apply: endPatch });
        prevCtrl = null;
        prevKind = null;
        break;
      }
      case "hline": {
        const x = c.rel === "to" ? toPx(c.x, W) : start.x + toPx(c.x, W);
        end = { x, y: start.y };
        seg = `L ${n(end.x)} ${n(end.y)}`;
        segHandles.push({
          key: "end",
          kind: "point",
          axis: "x",
          apply: (p) => ({
            x: setPx(c.x, c.rel === "to" ? p.x : p.x - start.x, W),
          }),
        });
        prevCtrl = null;
        prevKind = null;
        break;
      }
      case "vline": {
        const y = c.rel === "to" ? toPx(c.y, H) : start.y + toPx(c.y, H);
        end = { x: start.x, y };
        seg = `L ${n(end.x)} ${n(end.y)}`;
        segHandles.push({
          key: "end",
          kind: "point",
          axis: "y",
          apply: (p) => ({
            y: setPx(c.y, c.rel === "to" ? p.y : p.y - start.y, H),
          }),
        });
        prevCtrl = null;
        prevKind = null;
        break;
      }
      case "curve": {
        end = c.rel === "to" ? endTo() : endBy();
        const p1 = resolveCp(c.c1, W, H, start, end);
        if (c.cubic) {
          const p2 = resolveCp(c.c2, W, H, start, end);
          seg = `C ${n(p1.x)} ${n(p1.y)} ${n(p2.x)} ${n(p2.y)} ${n(end.x)} ${n(end.y)}`;
          tangents = [[start, p1], [end, p2]];
          segHandles.push(
            { key: "end", kind: "point", apply: endPatch },
            {
              key: "c1",
              kind: "control",
              pt: p1,
              apply: (p) => cpPatch("c1", c.c1, p, W, H, start, end),
            },
            {
              key: "c2",
              kind: "control",
              pt: p2,
              apply: (p) => cpPatch("c2", c.c2, p, W, H, start, end),
            }
          );
          prevCtrl = p2;
          prevKind = "cubic";
        } else {
          seg = `Q ${n(p1.x)} ${n(p1.y)} ${n(end.x)} ${n(end.y)}`;
          tangents = [[start, p1], [end, p1]];
          segHandles.push(
            { key: "end", kind: "point", apply: endPatch },
            {
              key: "c1",
              kind: "control",
              pt: p1,
              apply: (p) => cpPatch("c1", c.c1, p, W, H, start, end),
            }
          );
          prevCtrl = p1;
          prevKind = "quad";
        }
        break;
      }
      case "smooth": {
        end = c.rel === "to" ? endTo() : endBy();
        if (c.cubic) {
          const mirrored =
            prevKind === "cubic" && prevCtrl ? reflect(prevCtrl, start) : { ...start };
          const p2 = resolveCp(c.c1, W, H, start, end);
          seg = `C ${n(mirrored.x)} ${n(mirrored.y)} ${n(p2.x)} ${n(p2.y)} ${n(end.x)} ${n(end.y)}`;
          tangents = [[start, mirrored], [end, p2]];
          ghosts.push(mirrored);
          segHandles.push(
            { key: "end", kind: "point", apply: endPatch },
            {
              key: "c1",
              kind: "control",
              pt: p2,
              apply: (p) => cpPatch("c1", c.c1, p, W, H, start, end),
            }
          );
          prevCtrl = p2;
          prevKind = "cubic";
        } else {
          const mirrored =
            prevKind === "quad" && prevCtrl ? reflect(prevCtrl, start) : { ...start };
          seg = `Q ${n(mirrored.x)} ${n(mirrored.y)} ${n(end.x)} ${n(end.y)}`;
          tangents = [[start, mirrored], [end, mirrored]];
          ghosts.push(mirrored);
          segHandles.push({ key: "end", kind: "point", apply: endPatch });
          prevCtrl = mirrored;
          prevKind = "quad";
        }
        break;
      }
      case "arc": {
        end = c.rel === "to" ? endTo() : endBy();
        const rx = Math.abs(toPx(c.rx, W));
        const ry = Math.abs(c.circle ? toPx(c.rx, H) : toPx(c.ry, H));
        // CSS cw  -> SVG sweep-flag 1 (positive-angle direction, y axis down)
        // CSS large -> SVG large-arc-flag 1
        const sweepFlag = c.sweep === "cw" ? 1 : 0;
        const largeFlag = c.size === "large" ? 1 : 0;
        seg =
          rx === 0 || ry === 0
            ? `L ${n(end.x)} ${n(end.y)}`
            : `A ${n(rx)} ${n(ry)} ${c.rotate || 0} ${largeFlag} ${sweepFlag} ${n(end.x)} ${n(end.y)}`;
        segHandles.push({ key: "end", kind: "point", apply: endPatch });
        prevCtrl = null;
        prevKind = null;
        break;
      }
      default:
        break;
    }

    if (c.type !== "close" && c.type !== "move") cur = { ...end };
    if (c.type === "move") cur = { ...end };

    const segPath =
      c.type === "close" || c.type === "move"
        ? `M ${n(start.x)} ${n(start.y)} L ${n(end.x)} ${n(end.y)}`
        : `M ${n(start.x)} ${n(start.y)} ${seg}`;

    d += ` ${seg}`;

    for (const h of segHandles) {
      handles.push({
        ...h,
        target: c.id,
        pt: h.pt || end,
        cmdId: c.id,
      });
    }

    segments.push({ id: c.id, type: c.type, start, end, segPath, tangents, ghosts });
  }

  return { d, segments, handles, start0 };
}

/* ============================================================================
   PARSER — read an existing shape() back into the editor
   ========================================================================== */

const UNIT_PX = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, rem: 16, em: 16, ch: 8, ex: 8 };

function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let buf = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function lp(tok) {
  const m = String(tok).match(/^(-?[\d.]+)(%|[a-z]+)?$/i);
  if (!m) throw new Error(`Can't read the value "${tok}"`);
  const v = parseFloat(m[1]);
  const u = (m[2] || "px").toLowerCase();
  if (u === "%") return V(v, "%");
  if (UNIT_PX[u]) return V(r2(v * UNIT_PX[u]), "px");
  throw new Error(`Unit "${u}" isn't supported here`);
}

const X_WORDS = { left: 0, right: 100, "x-start": 0, "x-end": 100, "inline-start": 0, "inline-end": 100 };
const Y_WORDS = { top: 0, bottom: 100, "y-start": 0, "y-end": 100, "block-start": 0, "block-end": 100 };

function parsePosition(toks) {
  const t = toks.map((s) => s.toLowerCase());
  if (t.length === 1) {
    if (t[0] === "center") return { x: V(50), y: V(50) };
    if (t[0] in X_WORDS) return { x: V(X_WORDS[t[0]]), y: V(50) };
    if (t[0] in Y_WORDS) return { x: V(50), y: V(Y_WORDS[t[0]]) };
    return { x: lp(t[0]), y: V(50) };
  }
  if (t.length === 4) {
    const pick = (word, off) =>
      word in X_WORDS
        ? { axis: "x", val: V(X_WORDS[word] === 0 ? lp(off).v : 100 - lp(off).v, lp(off).u) }
        : { axis: "y", val: V(Y_WORDS[word] === 0 ? lp(off).v : 100 - lp(off).v, lp(off).u) };
    const a = pick(t[0], t[1]);
    const b = pick(t[2], t[3]);
    const x = a.axis === "x" ? a.val : b.val;
    const y = a.axis === "y" ? a.val : b.val;
    return { x, y };
  }
  let [a, b] = t;
  if (a in Y_WORDS || b in X_WORDS) [a, b] = [b, a]; // `top left` order
  const x = a === "center" ? V(50) : a in X_WORDS ? V(X_WORDS[a]) : lp(a);
  const y = b === "center" ? V(50) : b in Y_WORDS ? V(Y_WORDS[b]) : lp(b);
  return { x, y };
}

function parseControlPoint(toks, rel) {
  let from = rel === "to" ? "origin" : "start";
  const i = toks.findIndex((t) => t.toLowerCase() === "from");
  let coords = toks;
  if (i >= 0) {
    from = toks[i + 1].toLowerCase();
    coords = toks.slice(0, i);
  }
  const pos = parsePosition(coords);
  return CP(pos.x, pos.y, from);
}

function parseCommand(clause) {
  const toks = clause.replace(/\//g, " / ").trim().split(/\s+/);
  const type = toks[0].toLowerCase();
  if (type === "close") return { id: uid(), type: "close", rel: "to" };
  if (!(type in COMMANDS)) throw new Error(`Unknown command "${toks[0]}"`);

  let rel = toks[1] ? toks[1].toLowerCase() : "to";
  if (rel !== "to" && rel !== "by") throw new Error(`"${type}" needs "to" or "by"`);
  let rest = toks.slice(2);

  if (type === "hline" || type === "vline") {
    const val = rest[0].toLowerCase();
    const words = type === "hline" ? X_WORDS : Y_WORDS;
    const parsed = val === "center" ? V(50) : val in words ? V(words[val]) : lp(val);
    return type === "hline"
      ? { id: uid(), type, rel, x: parsed, y: V(0) }
      : { id: uid(), type, rel, x: V(0), y: parsed };
  }

  if (type === "arc") {
    const ofAt = rest.findIndex((t) => t.toLowerCase() === "of");
    const endToks = ofAt >= 0 ? rest.slice(0, ofAt) : rest;
    const pos = parsePosition(endToks);
    const tail = ofAt >= 0 ? rest.slice(ofAt + 1) : [];
    const radii = [];
    let sweep = "ccw";
    let size = "small";
    let rotate = 0;
    for (let i = 0; i < tail.length; i++) {
      const t = tail[i].toLowerCase();
      if (t === "cw" || t === "ccw") sweep = t;
      else if (t === "large" || t === "small") size = t;
      else if (t === "rotate") rotate = parseFloat(tail[++i]) || 0;
      else radii.push(lp(t));
    }
    return {
      id: uid(),
      type,
      rel,
      x: pos.x,
      y: pos.y,
      rx: radii[0] || V(20),
      ry: radii[1] || radii[0] || V(20),
      circle: radii.length < 2,
      sweep,
      size,
      rotate,
    };
  }

  const withAt = rest.findIndex((t) => t.toLowerCase() === "with");
  const endToks = withAt >= 0 ? rest.slice(0, withAt) : rest;
  const pos = parsePosition(endToks);
  const cmd = { id: uid(), type, rel, x: pos.x, y: pos.y };

  if (type === "curve" || type === "smooth") {
    if (withAt < 0) {
      if (type === "curve") throw new Error("curve needs a `with` control point");
      return { ...cmd, cubic: false, c1: CP(V(0), V(0), "start") };
    }
    const cps = splitTop(rest.slice(withAt + 1).join(" "), "/").map((s) =>
      parseControlPoint(s.split(/\s+/), rel)
    );
    if (type === "smooth") return { ...cmd, cubic: true, c1: cps[0] };
    return {
      ...cmd,
      cubic: cps.length > 1,
      c1: cps[0],
      c2: cps[1] || CP(V(0), V(0), rel === "to" ? "origin" : "start"),
    };
  }
  return cmd;
}

function parseShape(text) {
  const m = text.match(/shape\s*\(([\s\S]*)\)/i);
  if (!m) throw new Error("Expected a shape( … ) value");
  if (/calc|min\(|max\(|clamp/i.test(m[1]))
    throw new Error("Math functions can't be edited on the canvas yet");
  const parts = splitTop(m[1], ",");
  if (!parts.length) throw new Error("Empty shape()");

  let head = parts[0].trim().split(/\s+/);
  let fillRule = "nonzero";
  if (["nonzero", "evenodd"].includes(head[0].toLowerCase())) {
    fillRule = head.shift().toLowerCase();
  }
  if (head.shift().toLowerCase() !== "from") throw new Error("shape() must start with `from`");
  const from = parsePosition(head);
  const commands = parts.slice(1).map(parseCommand);
  return { fillRule, from, commands };
}

/* ============================================================================
   SVG IMPORT
   ----------------------------------------------------------------------------
   SVG path commands map onto shape() almost one-for-one, which is the whole
   reason shape() looks the way it does:

     M/m -> move (or the `from` point)   C/c -> curve with two control points
     L/l -> line                         S/s -> smooth, cubic
     H/h -> hline                        Q/q -> curve with one control point
     V/v -> vline                        T/t -> smooth, quadratic
     Z/z -> close                        A/a -> arc

   Uppercase becomes `to`, lowercase becomes `by`. SVG's relative control points
   are measured from the current point, which is exactly `from start`; absolute
   ones are `from origin`.
   ========================================================================== */

const PATH_ARGC = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const NUMBER_RE = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/;

function scanPathData(d) {
  const s = String(d).trim();
  let i = 0;
  const ws = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  const number = () => {
    ws();
    const m = NUMBER_RE.exec(s.slice(i));
    if (!m) throw new Error(`Expected a number near "${s.slice(i, i + 12)}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  // Arc flags are single characters and may be written without separators,
  // as in "a5 5 0 015 5" — so they cannot go through the number scanner.
  const flag = () => {
    ws();
    const c = s[i];
    if (c !== "0" && c !== "1") throw new Error(`Expected an arc flag near "${s.slice(i, i + 12)}"`);
    i++;
    return c === "1";
  };

  const out = [];
  let cmd = null;
  let guard = 0;
  ws();
  while (i < s.length) {
    if (guard++ > 20000) throw new Error("That path data doesn't terminate");
    if (/[a-z]/i.test(s[i])) cmd = s[i++];
    else if (!cmd) throw new Error("Path data has to start with a command letter");
    else if (cmd === "M") cmd = "L"; // repeated coordinates after a moveto are lines
    else if (cmd === "m") cmd = "l";

    const key = cmd.toLowerCase();
    if (!(key in PATH_ARGC)) throw new Error(`Unknown path command "${cmd}"`);

    const args = [];
    if (key === "a") {
      args.push(number(), number(), number(), flag(), flag(), number(), number());
    } else {
      for (let k = 0; k < PATH_ARGC[key]; k++) args.push(number());
    }
    out.push({ cmd, key, args });
    if (key === "z") cmd = null;
    ws();
  }
  if (!out.length) throw new Error("No path commands found");
  return out;
}

function pathDataToShape(d) {
  const segs = scanPathData(d);
  const commands = [];
  const pts = [];
  let cur = { x: 0, y: 0 };
  let sub = { x: 0, y: 0 };
  let from = null;

  const px = (n) => V(r2(n), "px");

  for (const { cmd, key, args } of segs) {
    const rel = cmd === cmd.toLowerCase() && key !== "z";
    const mode = rel ? "by" : "to";
    const anchor = rel ? "start" : "origin";
    const abs = (x, y) => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    const ctrl = (x, y) => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    const base = { id: uid(), rel: mode };
    let end = { ...cur };

    switch (key) {
      case "m":
        end = abs(args[0], args[1]);
        if (!from) from = { ...end };
        else commands.push({ ...base, type: "move", x: px(args[0]), y: px(args[1]) });
        sub = { ...end };
        break;
      case "l":
        end = abs(args[0], args[1]);
        commands.push({ ...base, type: "line", x: px(args[0]), y: px(args[1]) });
        break;
      case "h":
        end = { x: rel ? cur.x + args[0] : args[0], y: cur.y };
        commands.push({ ...base, type: "hline", x: px(args[0]), y: px(cur.y) });
        break;
      case "v":
        end = { x: cur.x, y: rel ? cur.y + args[0] : args[0] };
        commands.push({ ...base, type: "vline", x: px(cur.x), y: px(args[0]) });
        break;
      case "c":
        end = abs(args[4], args[5]);
        pts.push(ctrl(args[0], args[1]), ctrl(args[2], args[3]));
        commands.push({
          ...base,
          type: "curve",
          x: px(args[4]),
          y: px(args[5]),
          cubic: true,
          c1: CP(px(args[0]), px(args[1]), anchor),
          c2: CP(px(args[2]), px(args[3]), anchor),
        });
        break;
      case "s":
        end = abs(args[2], args[3]);
        pts.push(ctrl(args[0], args[1]));
        commands.push({
          ...base,
          type: "smooth",
          x: px(args[2]),
          y: px(args[3]),
          cubic: true,
          c1: CP(px(args[0]), px(args[1]), anchor),
        });
        break;
      case "q":
        end = abs(args[2], args[3]);
        pts.push(ctrl(args[0], args[1]));
        commands.push({
          ...base,
          type: "curve",
          x: px(args[2]),
          y: px(args[3]),
          cubic: false,
          c1: CP(px(args[0]), px(args[1]), anchor),
          c2: CP(px(0), px(0), anchor),
        });
        break;
      case "t":
        end = abs(args[0], args[1]);
        commands.push({
          ...base,
          type: "smooth",
          x: px(args[0]),
          y: px(args[1]),
          cubic: false,
          c1: CP(px(0), px(0), anchor),
        });
        break;
      case "a":
        end = abs(args[5], args[6]);
        commands.push({
          ...base,
          type: "arc",
          x: px(args[5]),
          y: px(args[6]),
          rx: px(Math.abs(args[0])),
          ry: px(Math.abs(args[1])),
          circle: Math.abs(args[0]) === Math.abs(args[1]),
          rotate: r2(args[2]),
          size: args[3] ? "large" : "small",
          sweep: args[4] ? "cw" : "ccw",
        });
        break;
      case "z":
        end = { ...sub };
        commands.push({ id: uid(), type: "close", rel: "to" });
        break;
      default:
        break;
    }

    cur = { ...end };
    pts.push({ ...end });
  }

  if (!from) from = { x: 0, y: 0 };
  const all = [from, ...pts].map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const bbox = {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  return {
    shape: { fillRule: "nonzero", from: { x: px(from.x), y: px(from.y) }, commands },
    bbox,
  };
}

/* Rescale a pixel-valued shape into percentages of a frame. Absolute values are
   offset then divided; deltas and radii are only divided. */
function rescale(shape, frame) {
  const { x0, y0, w, h } = frame;
  const A = (val, o, size) => (val.u === "px" ? V(r2(((val.v - o) * 100) / size), "%") : val);
  const D = (val, size) => (val.u === "px" ? V(r2((val.v * 100) / size), "%") : val);
  const cp = (c) =>
    c.from === "origin"
      ? { ...c, x: A(c.x, x0, w), y: A(c.y, y0, h) }
      : { ...c, x: D(c.x, w), y: D(c.y, h) };

  const commands = shape.commands.map((c) => {
    if (c.type === "close") return c;
    const absolute = c.rel === "to";
    const n = {
      ...c,
      x: absolute ? A(c.x, x0, w) : D(c.x, w),
      y: absolute ? A(c.y, y0, h) : D(c.y, h),
    };
    if (c.type === "arc") {
      // rx resolves against the box width and ry against its height, so a
      // circle only stays circular if both scale by the same factor.
      n.rx = D(c.rx, w);
      n.ry = D(c.ry, h);
      n.circle = false;
    }
    if (c.c1) n.c1 = cp(c.c1);
    if (c.c2) n.c2 = cp(c.c2);
    return n;
  });

  return {
    ...shape,
    from: { x: A(shape.from.x, x0, w), y: A(shape.from.y, y0, h) },
    commands,
  };
}

/* Turn the SVG shape elements into path data so one code path handles them all. */
function elementToPathData(tag, a) {
  const n = (k, d = 0) => {
    const v = parseFloat(a[k]);
    return Number.isFinite(v) ? v : d;
  };
  switch (tag) {
    case "path":
      return a.d || null;
    case "line":
      return `M${n("x1")},${n("y1")}L${n("x2")},${n("y2")}`;
    case "polyline":
    case "polygon": {
      const nums = String(a.points || "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((v) => Number.isFinite(v));
      if (nums.length < 4) return null;
      let out = `M${nums[0]},${nums[1]}`;
      for (let i = 2; i < nums.length - 1; i += 2) out += `L${nums[i]},${nums[i + 1]}`;
      return tag === "polygon" ? out + "Z" : out;
    }
    case "rect": {
      const x = n("x");
      const y = n("y");
      const w = n("width");
      const h = n("height");
      if (!(w > 0) || !(h > 0)) return null;
      const hasRx = a.rx !== undefined && a.rx !== "";
      const hasRy = a.ry !== undefined && a.ry !== "";
      let rx = Math.min(hasRx ? n("rx") : hasRy ? n("ry") : 0, w / 2);
      let ry = Math.min(hasRy ? n("ry") : hasRx ? n("rx") : 0, h / 2);
      if (!(rx > 0) || !(ry > 0)) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}` +
        `V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}` +
        `H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
        `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
      );
    }
    case "circle": {
      const cx = n("cx");
      const cy = n("cy");
      const rr = n("r");
      if (!(rr > 0)) return null;
      return `M${cx - rr},${cy}A${rr},${rr} 0 1 1 ${cx + rr},${cy}A${rr},${rr} 0 1 1 ${cx - rr},${cy}Z`;
    }
    case "ellipse": {
      const cx = n("cx");
      const cy = n("cy");
      const rx = n("rx");
      const ry = n("ry");
      if (!(rx > 0) || !(ry > 0)) return null;
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}Z`;
    }
    default:
      return null;
  }
}

const SVG_SHAPE_SELECTOR = "path,polygon,polyline,rect,circle,ellipse,line";

function readSvgMarkup(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("That isn't valid SVG markup");
  const svg = doc.querySelector("svg") || doc.documentElement;
  const els = Array.from(doc.querySelectorAll(SVG_SHAPE_SELECTOR));
  if (!els.length) throw new Error("No path, polygon, rect, circle or ellipse found in that SVG");

  const notes = [];
  const datas = [];
  let transformed = 0;
  for (const el of els) {
    let node = el;
    while (node && node.getAttribute) {
      if (node.getAttribute("transform")) {
        transformed++;
        break;
      }
      node = node.parentElement;
    }
    const attrs = {};
    for (const at of Array.from(el.attributes || [])) attrs[at.name] = at.value;
    const d = elementToPathData(el.tagName.toLowerCase().replace(/^svg:/, ""), attrs);
    if (d) datas.push(d);
  }
  if (!datas.length) throw new Error("Those elements had nothing drawable in them");
  if (datas.length > 1)
    notes.push(`${datas.length} elements merged into one shape — overlaps now resolve through the fill rule`);
  if (transformed) notes.push(`transform on ${transformed} element(s) was ignored`);

  let frame = null;
  const vb = svg && svg.getAttribute && svg.getAttribute("viewBox");
  if (vb) {
    const [x0, y0, w, h] = vb.trim().split(/[\s,]+/).map(Number);
    if (w > 0 && h > 0) frame = { x0, y0, w, h };
  }
  if (!frame && svg && svg.getAttribute) {
    const w = parseFloat(svg.getAttribute("width"));
    const h = parseFloat(svg.getAttribute("height"));
    if (w > 0 && h > 0) frame = { x0: 0, y0: 0, w, h };
  }
  if (!frame) notes.push("no viewBox, so the shape was fitted to its own bounding box");

  const rule =
    els[0].getAttribute("fill-rule") || els[0].getAttribute("clip-rule") || "nonzero";
  return { d: datas.join(" "), frame, fillRule: rule === "evenodd" ? "evenodd" : "nonzero", notes };
}

function detectFormat(text) {
  const t = text.trim();
  if (!t) return null;
  if (/shape\s*\(/i.test(t)) return "css";
  if (/<\s*(svg|path|polygon|polyline|rect|circle|ellipse)\b/i.test(t)) return "svg";
  if (/^[Mm][\s,.\d+-]/.test(t)) return "path";
  return null;
}

function importAny(text, { units = "percent" } = {}) {
  const kind = detectFormat(text);
  if (!kind)
    throw new Error("Paste a shape() value, an <svg> element, or a path d attribute");

  if (kind === "css") return { shape: parseShape(text), frame: null, notes: [], kind };

  let d = text.trim();
  let frame = null;
  let fillRule = "nonzero";
  const notes = [];

  if (kind === "svg") {
    const read = readSvgMarkup(text);
    d = read.d;
    frame = read.frame;
    fillRule = read.fillRule;
    notes.push(...read.notes);
  }

  const { shape, bbox } = pathDataToShape(d);
  shape.fillRule = fillRule;
  const box = frame || bbox;
  if (!(box.w > 0) || !(box.h > 0)) throw new Error("That path has no area to scale into");

  if (units === "percent") return { shape: rescale(shape, box), frame: box, notes, kind };
  notes.push("kept in pixels, so the shape will not scale with the box");
  return { shape, frame: box, notes, kind };
}

/* ============================================================================
   PRESETS
   ========================================================================== */

const PRESETS = {
  Triangle: "shape(from 50% 0%, line to 100% 100%, line to 0% 100%, close)",
  Star:
    "shape(from 50% 2%, line to 61% 35%, line to 97% 35%, line to 68% 57%, " +
    "line to 79% 91%, line to 50% 70%, line to 21% 91%, line to 32% 57%, " +
    "line to 3% 35%, line to 39% 35%, close)",
  Heart:
    "shape(from 10% 35%, arc to 50% 35% of 1% cw, arc to 90% 35% of 1% cw, " +
    "curve to 50% 95% with 90% 65% from origin, " +
    "curve to 10% 35% with 10% 65% from origin, close)",
  Ticket:
    "shape(from 0% 0%, hline to 100%, vline to 42%, arc to 100% 58% of 6% ccw, " +
    "vline to 100%, hline to 0%, vline to 58%, arc to 0% 42% of 6% ccw, close)",
  Blob:
    "shape(from 44% 3%, " +
    "curve to 97% 38% with 72% 3% from origin / 97% 14% from origin, " +
    "smooth to 62% 96% with 88% 90% from origin, " +
    "smooth to 9% 62% with 12% 88% from origin, " +
    "smooth to 44% 3% with 20% 3% from origin, close)",
  Wave:
    "shape(from 0% 0%, hline to 100%, vline to 70%, " +
    "curve to 66% 82% with 88% 62% from origin / 80% 84% from origin, " +
    "smooth to 33% 74% with 46% 66% from origin, " +
    "smooth to 0% 84% with 12% 82% from origin, close)",
  Chevron:
    "shape(from 0% 0%, line to 78% 0%, line to 100% 50%, line to 78% 100%, " +
    "line to 0% 100%, line to 22% 50%, close)",
  Frame:
    "shape(evenodd from 0% 0%, hline to 100%, vline to 100%, hline to 0%, close, " +
    "move to 18% 18%, hline to 82%, vline to 82%, hline to 18%, close)",
};

const DEFAULT = parseShape(PRESETS.Blob);

const FORMAT_LABEL = { css: "shape()", svg: "SVG markup", path: "path data" };

/* ============================================================================
   CANVAS
   ========================================================================== */

const PAD = 28;

function Canvas({ geo, shape, W, H, onDrag, hover, setHover, snap, showGrid }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width) setScale((W + PAD * 2) / rect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W]);

  const toLocal = useCallback((e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }, []);

  const startDrag = (handle) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = handle;
    const move = (ev) => {
      const h = dragRef.current;
      if (!h) return;
      let p = toLocal(ev);
      if (snap > 0 && !ev.altKey) {
        p = { x: Math.round(p.x / snap) * snap, y: Math.round(p.y / snap) * snap };
      }
      onDrag(h.target, h.apply(p));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const k = scale;
  const gridX = Array.from({ length: 11 }, (_, i) => (i * W) / 10);
  const gridY = Array.from({ length: 11 }, (_, i) => (i * H) / 10);

  return (
    <svg
      ref={svgRef}
      className="bed"
      viewBox={`${-PAD} ${-PAD} ${W + PAD * 2} ${H + PAD * 2}`}
      preserveAspectRatio="xMidYMid meet"
      role="application"
      aria-label="Shape plotting bed"
    >
      {showGrid && (
        <g className="grid">
          {gridX.map((x, i) => (
            <line key={`x${i}`} x1={x} y1={0} x2={x} y2={H} strokeWidth={i % 5 === 0 ? 1.4 * k : 0.7 * k} />
          ))}
          {gridY.map((y, i) => (
            <line key={`y${i}`} x1={0} y1={y} x2={W} y2={y} strokeWidth={i % 5 === 0 ? 1.4 * k : 0.7 * k} />
          ))}
        </g>
      )}

      <rect className="box" x={0} y={0} width={W} height={H} strokeWidth={1.5 * k} />

      <path className="fill" d={geo.d} fillRule={shape.fillRule} />

      {/* tangent lines from each anchor to its control point */}
      {geo.segments.map((s) =>
        s.tangents.map(([a, b], i) => (
          <line
            key={`${s.id}t${i}`}
            className="tangent"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            strokeWidth={1 * k}
            strokeDasharray={`${3 * k} ${3 * k}`}
          />
        ))
      )}

      {/* per-segment stroke: visible line plus a fat invisible hit area */}
      {geo.segments.map((s) => (
        <g key={s.id}>
          <path
            className={`seg ${hover === s.id ? "is-hot" : ""} ${
              s.type === "move" ? "is-jump" : ""
            }`}
            d={s.segPath}
            strokeWidth={(hover === s.id ? 4 : 2.25) * k}
            strokeDasharray={s.type === "move" ? `${5 * k} ${4 * k}` : undefined}
          />
          <path
            className="hit"
            d={s.segPath}
            strokeWidth={14 * k}
            onPointerEnter={() => setHover(s.id)}
            onPointerLeave={() => setHover(null)}
          />
        </g>
      ))}

      {/* control points inferred by `smooth` — shown, but not editable */}
      {geo.segments.map((s) =>
        s.ghosts.map((g, i) => (
          <circle key={`${s.id}g${i}`} className="ghost" cx={g.x} cy={g.y} r={4 * k} strokeWidth={1.2 * k} />
        ))
      )}

      {geo.handles.map((h) => {
        const isCtrl = h.kind === "control";
        const key = `${h.target}-${h.key}`;
        const nudge = (e) => {
          const step = e.shiftKey ? 10 : 1;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
          if (!d) return;
          e.preventDefault();
          onDrag(h.target, h.apply({ x: h.pt.x + d[0], y: h.pt.y + d[1] }));
        };
        return (
          <g
            key={key}
            className="handle"
            tabIndex={0}
            role="slider"
            aria-label={`${h.kind} point`}
            aria-valuetext={`${Math.round(h.pt.x)}, ${Math.round(h.pt.y)} pixels`}
            onPointerDown={startDrag(h)}
            onKeyDown={nudge}
          >
            <circle className="halo" cx={h.pt.x} cy={h.pt.y} r={11 * k} />
            {isCtrl ? (
              <rect
                className="ctrl"
                x={h.pt.x - 4.5 * k}
                y={h.pt.y - 4.5 * k}
                width={9 * k}
                height={9 * k}
                strokeWidth={1.6 * k}
              />
            ) : (
              <circle
                className={`node ${h.key === "from" ? "is-origin" : ""} ${
                  h.kind === "move" ? "is-jump" : ""
                } ${hover === h.cmdId ? "is-hot" : ""}`}
                cx={h.pt.x}
                cy={h.pt.y}
                r={(h.key === "from" ? 6.5 : 5) * k}
                strokeWidth={2 * k}
                onPointerEnter={() => h.cmdId && setHover(h.cmdId)}
                onPointerLeave={() => setHover(null)}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ============================================================================
   SMALL CONTROLS
   ========================================================================== */

function NumUnit({ value, onChange, label, step = 1 }) {
  return (
    <span className="numunit" title={label}>
      {label && <em>{label}</em>}
      <input
        type="number"
        step={step}
        value={value.v}
        onChange={(e) => onChange({ ...value, v: parseFloat(e.target.value) || 0 })}
      />
      <button
        type="button"
        className="unit"
        onClick={() => onChange({ ...value, u: value.u === "%" ? "px" : "%" })}
        title="Switch unit"
      >
        {value.u}
      </button>
    </span>
  );
}

function Pick({ value, onChange, options, title }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/* ============================================================================
   COMMAND ROW
   ========================================================================== */

function CommandRow({ cmd, index, patch, changeType, remove, moveBy, duplicate, hover, setHover, compact }) {
  const c = cmd;
  const isHot = hover === c.id;
  const setCp = (key) => (field) => (val) => patch({ [key]: { ...c[key], [field]: val } });

  const cpRow = (key, labelText) => {
    const cp = c[key];
    const set = setCp(key);
    return (
      <div className="cprow" key={key}>
        <span className="cplabel">{labelText}</span>
        <NumUnit value={cp.x} onChange={set("x")} label="x" />
        <NumUnit value={cp.y} onChange={set("y")} label="y" />
        <Pick
          value={cp.from}
          onChange={(v) => patch({ [key]: { ...cp, from: v } })}
          options={["origin", "start", "end"]}
          title="What the control point is measured from"
        />
      </div>
    );
  };

  return (
    <li
      className={`row ${isHot ? "is-hot" : ""}`}
      onPointerEnter={() => setHover(c.id)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="rowhead">
        <span className="idx">{index + 1}</span>
        <Pick
          value={c.type}
          onChange={changeType}
          options={Object.keys(COMMANDS)}
          title={BLURB[c.type]}
        />
        {c.type !== "close" && (
          <Pick
            value={c.rel}
            onChange={(v) => patch({ rel: v })}
            options={["to", "by"]}
            title="to = from the box origin, by = from the previous point"
          />
        )}
        <span className="spacer" />
        <button type="button" onClick={() => moveBy(-1)} title="Move earlier" aria-label="Move earlier">↑</button>
        <button type="button" onClick={() => moveBy(1)} title="Move later" aria-label="Move later">↓</button>
        <button type="button" onClick={duplicate} title="Duplicate" aria-label="Duplicate">⧉</button>
        <button type="button" onClick={remove} title="Delete" aria-label="Delete">✕</button>
      </div>

      {c.type !== "close" && (
        <div className="rowbody">
          {c.type !== "vline" && <NumUnit value={c.x} onChange={(v) => patch({ x: v })} label="x" />}
          {c.type !== "hline" && <NumUnit value={c.y} onChange={(v) => patch({ y: v })} label="y" />}

          {c.type === "curve" && (
            <label className="check">
              <input type="checkbox" checked={c.cubic} onChange={(e) => patch({ cubic: e.target.checked })} />
              cubic
            </label>
          )}
          {c.type === "smooth" && (
            <label className="check">
              <input type="checkbox" checked={c.cubic} onChange={(e) => patch({ cubic: e.target.checked })} />
              cubic
            </label>
          )}

          {c.type === "arc" && (
            <>
              <NumUnit value={c.rx} onChange={(v) => patch({ rx: v })} label="rx" />
              {!c.circle && <NumUnit value={c.ry} onChange={(v) => patch({ ry: v })} label="ry" />}
              <label className="check">
                <input type="checkbox" checked={c.circle} onChange={(e) => patch({ circle: e.target.checked })} />
                circle
              </label>
              <Pick value={c.sweep} onChange={(v) => patch({ sweep: v })} options={["cw", "ccw"]} title="Sweep direction" />
              <Pick value={c.size} onChange={(v) => patch({ size: v })} options={["small", "large"]} title="Which of the two arcs" />
              <span className="numunit" title="Ellipse rotation">
                <em>rot</em>
                <input
                  type="number"
                  step="5"
                  value={c.rotate}
                  onChange={(e) => patch({ rotate: parseFloat(e.target.value) || 0 })}
                />
                <span className="unit static">deg</span>
              </span>
            </>
          )}
        </div>
      )}

      {(c.type === "curve" || (c.type === "smooth" && c.cubic)) && (
        <div className="cpgroup">
          {c.type === "smooth"
            ? cpRow("c1", "control")
            : [cpRow("c1", "control 1"), c.cubic ? cpRow("c2", "control 2") : null]}
        </div>
      )}

      <code className="frag">{cmdCss(c, compact)}</code>
    </li>
  );
}

/* ============================================================================
   APP
   ========================================================================== */

export default function ShapeStudio() {
  const [shape, setShape] = useState(DEFAULT);
  const [W, setW] = useState(320);
  const [H, setH] = useState(320);
  const [hover, setHover] = useState(null);
  const [snap, setSnap] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [compact, setCompact] = useState(false);
  const [property, setProperty] = useState("clip-path");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importUnits, setImportUnits] = useState("percent");
  const [copied, setCopied] = useState("");
  const [animate, setAnimate] = useState(false);

  const geo = useMemo(() => evaluate(shape, W, H), [shape, W, H]);

  const supported = useMemo(() => {
    try {
      return CSS.supports("clip-path", "shape(from 0 0, line to 10px 10px)");
    } catch {
      return false;
    }
  }, []);

  const onDrag = useCallback((target, patch) => {
    setShape((s) =>
      target === "shape"
        ? { ...s, ...patch }
        : { ...s, commands: s.commands.map((c) => (c.id === target ? { ...c, ...patch } : c)) }
    );
  }, []);

  const patchCmd = (id) => (patch, replace = false) =>
    setShape((s) => ({
      ...s,
      commands: s.commands.map((c) => (c.id === id ? (replace ? { ...patch, id } : { ...c, ...patch }) : c)),
    }));

  const addCommand = (type) =>
    setShape((s) => {
      const last = geo.segments[geo.segments.length - 1];
      const at = last ? last.end : geo.start0;
      const cur = { xPct: W ? (at.x * 100) / W : 50, yPct: H ? (at.y * 100) / H : 50 };
      return { ...s, commands: [...s.commands, makeCommand(type, cur)] };
    });

  const changeType = (id, type) =>
    setShape((s) => ({
      ...s,
      commands: s.commands.map((c) => {
        if (c.id !== id) return c;
        const seg = geo.segments.find((g) => g.id === id);
        const at = seg ? seg.end : geo.start0;
        return { ...makeCommand(type, { xPct: W ? (at.x * 100) / W : 50, yPct: H ? (at.y * 100) / H : 50 }, true), id };
      }),
    }));

  const hoveredType = hover ? (shape.commands.find((c) => c.id === hover) || {}).type : null;

  const removeCmd = (id) =>
    setShape((s) => ({ ...s, commands: s.commands.filter((c) => c.id !== id) }));

  const moveCmd = (index, delta) =>
    setShape((s) => {
      const next = [...s.commands];
      const j = index + delta;
      if (j < 0 || j >= next.length) return s;
      [next[index], next[j]] = [next[j], next[index]];
      return { ...s, commands: next };
    });

  const dupCmd = (index) =>
    setShape((s) => {
      const next = [...s.commands];
      next.splice(index + 1, 0, { ...JSON.parse(JSON.stringify(next[index])), id: uid() });
      return { ...s, commands: next };
    });

  const value = shapeCss(shape, { compact, fillRule: property !== "offset-path" });
  const inline = shapeCss(shape, { compact, fillRule: property !== "offset-path", multiline: false });
  const declaration = `${property}: ${value};`;

  const copy = (text, tag) => {
    const done = () => {
      setCopied(tag);
      setTimeout(() => setCopied(""), 1400);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
    else done();
  };

  const doImport = () => {
    try {
      const res = importAny(importText, { units: importUnits === "pixels" ? "px" : "percent" });
      setShape(res.shape);
      // Percentages only hold their proportions if the editing box keeps the
      // source's aspect ratio, so match it on the way in.
      if (res.frame && importUnits === "percent") {
        const aspect = res.frame.w / res.frame.h;
        const w = aspect >= 1 ? 340 : Math.round(340 * aspect);
        const h = aspect >= 1 ? Math.round(340 / aspect) : 340;
        setW(Math.max(80, w));
        setH(Math.max(80, h));
      }
      setImportError("");
      setImportNote(
        [`Loaded ${{ css: "a shape() value", svg: "an SVG", path: "path data" }[res.kind]}`]
          .concat(res.notes)
          .join(" — ")
      );
    } catch (err) {
      setImportError(err.message);
      setImportNote("");
    }
  };

  const loadPreset = (name) => {
    setShape(parseShape(PRESETS[name]));
    setImportError("");
  };

  const detected = detectFormat(importText);
  const fillRuleMatters = property === "offset-path" && shape.fillRule !== "nonzero";

  return (
    <div className="studio">
      <style>{CSS_TEXT}</style>

      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Shape plotter</h1>
            <p>Drag the path, read the CSS.</p>
          </div>
        </div>

        <div className="topctl">
          <label className="field">
            <span>property</span>
            <Pick
              value={property}
              onChange={setProperty}
              options={["clip-path", "border-shape", "offset-path"]}
            />
          </label>
          <label className="field">
            <span>fill-rule</span>
            <Pick value={shape.fillRule} onChange={(v) => setShape((s) => ({ ...s, fillRule: v }))} options={["nonzero", "evenodd"]} />
          </label>
          <label className="field">
            <span>box</span>
            <span className="dims">
              <input type="number" value={W} min={80} max={600} onChange={(e) => setW(+e.target.value || 320)} />
              <i>×</i>
              <input type="number" value={H} min={80} max={600} onChange={(e) => setH(+e.target.value || 320)} />
            </span>
          </label>
        </div>
      </header>

      <main className="grid">
        <section className="stage">
          <div className="stagebar">
            <div className="presets">
              {Object.keys(PRESETS).map((p) => (
                <button key={p} type="button" onClick={() => loadPreset(p)}>
                  {p}
                </button>
              ))}
            </div>
            <div className="toggles">
              <label className="check">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                grid
              </label>
              <label className="check" title="Hold Alt while dragging to bypass">
                <input type="checkbox" checked={snap > 0} onChange={(e) => setSnap(e.target.checked ? W / 40 : 0)} />
                snap
              </label>
            </div>
          </div>

          <div className="bedwrap">
            <Canvas
              geo={geo}
              shape={shape}
              W={W}
              H={H}
              onDrag={onDrag}
              hover={hover}
              setHover={setHover}
              snap={snap}
              showGrid={showGrid}
            />
          </div>

          <div className="previews">
            <figure>
              <div
                className={`clipped ${property === "border-shape" ? "is-bordered" : ""}`}
                style={{
                  width: W,
                  height: H,
                  ...(property === "clip-path" ? { clipPath: inline } : null),
                  ...(property === "border-shape" ? { borderShape: inline } : null),
                }}
              >
                <div className="clipped-art" />
                {property === "offset-path" && (
                  <span
                    className={`traveller ${animate ? "is-running" : ""}`}
                    style={{ offsetPath: shapeCss(shape, { compact, fillRule: false, multiline: false }) }}
                  />
                )}
              </div>
              <figcaption>
                {property === "offset-path" ? (
                  <button type="button" className="ghostbtn" onClick={() => setAnimate((a) => !a)}>
                    {animate ? "Stop the traveller" : "Send a box along the path"}
                  </button>
                ) : (
                  <>Live {property} on a {W}×{H} box</>
                )}
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="panel">
          <div className="panelhead">
            <h2>Commands</h2>
            <span className="hint">{shape.commands.length} steps</span>
          </div>

          <div className="fromrow">
            <span className="cplabel">from</span>
            <NumUnit value={shape.from.x} onChange={(v) => setShape((s) => ({ ...s, from: { ...s.from, x: v } }))} label="x" />
            <NumUnit value={shape.from.y} onChange={(v) => setShape((s) => ({ ...s, from: { ...s.from, y: v } }))} label="y" />
          </div>

          <ol className="rows">
            {shape.commands.map((c, i) => (
              <CommandRow
                key={c.id}
                cmd={c}
                index={i}
                compact={compact}
                patch={patchCmd(c.id)}
                changeType={(t) => changeType(c.id, t)}
                remove={() => removeCmd(c.id)}
                moveBy={(d) => moveCmd(i, d)}
                duplicate={() => dupCmd(i)}
                hover={hover}
                setHover={setHover}
              />
            ))}
          </ol>

          <div className="adds">
            {Object.keys(COMMANDS).map((t) => (
              <button key={t} type="button" onClick={() => addCommand(t)} title={BLURB[t]}>
                + {t}
              </button>
            ))}
          </div>

          <p className="why">
            {hoveredType
              ? BLURB[hoveredType]
              : "Drag a point on the bed, or hover a step to light up the segment it draws. Arrow keys nudge a focused point."}
          </p>
        </section>

        <section className="out">
          <div className="panelhead">
            <h2>CSS</h2>
            <label className="check" title="Drop keywords that match the spec defaults">
              <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
              compact
            </label>
            <span className="spacer" />
            <button type="button" className="ghostbtn" onClick={() => copy(declaration, "css")}>
              {copied === "css" ? "Copied" : "Copy CSS"}
            </button>
            <button type="button" className="ghostbtn" onClick={() => copy(geo.d, "svg")}>
              {copied === "svg" ? "Copied" : "Copy SVG path"}
            </button>
          </div>

          {fillRuleMatters && (
            <p className="warn">
              offset-path rejects a fill-rule, so <code>{shape.fillRule}</code> is left out of the value below.
            </p>
          )}
          {!supported && (
            <p className="warn">
              This browser can't render <code>shape()</code> yet, so the preview box below stays unclipped. The
              plotting bed above still draws the real geometry.
            </p>
          )}

          <pre className="code">{declaration}</pre>

          <div className="importer">
            <div className="importhead">
              <label htmlFor="imp">Paste a shape(), an SVG, or a path d attribute</label>
              {detected && <span className={`badge is-${detected}`}>{FORMAT_LABEL[detected]}</span>}
            </div>
            <textarea
              id="imp"
              rows={3}
              spellCheck={false}
              value={importText}
              placeholder={'clip-path: shape(from 0% 0%, line to 100% 100%, close);\n<svg viewBox="0 0 24 24"><path d="M12 2 L22 22 H2 Z"/></svg>\nM12 2 L22 22 H2 Z'}
              onChange={(e) => setImportText(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && doImport()}
            />
            <div className="importrow">
              <label className="check" title="Percentages scale with the box; pixels stay put">
                <span>coordinates</span>
                <Pick
                  value={importUnits}
                  onChange={setImportUnits}
                  options={["percent", "pixels"]}
                />
              </label>
              <span className="spacer" />
              <button type="button" className="ghostbtn" onClick={doImport} disabled={!detected}>
                Load
              </button>
            </div>
            {importError && <p className="warn">{importError}</p>}
            {!importError && importNote && <p className="note">{importNote}</p>}
          </div>
        </section>
      </main>
    </div>
  );
}

/* ============================================================================
   STYLE
   ========================================================================== */

const CSS_TEXT = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

.studio {
  --chrome: #1b2426;
  --chrome-2: #232e30;
  --chrome-3: #2c3a3c;
  --edge: #3c4c4e;
  --text: #e8ece9;
  --muted: #90a3a0;
  --bed: #dbe1dd;
  --bed-line: #b6c0bb;
  --pen-a: #e4326b;
  --pen-b: #0fa3ba;
  --amber: #e0a33c;
  font-family: Archivo, 'Segoe UI', system-ui, sans-serif;
  background: var(--chrome);
  color: var(--text);
  min-height: 100%;
  padding: 18px;
  font-size: 14px;
  line-height: 1.45;
}
.studio *, .studio *::before, .studio *::after { box-sizing: border-box; }
.studio h1, .studio h2, .studio p, .studio ol, .studio figure { margin: 0; }
.studio ol { list-style: none; padding: 0; }
.studio code, .studio pre, .studio input, .studio select, .studio .unit, .studio .idx {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}
.studio button, .studio select, .studio input { font-size: 12px; color: inherit; }
.studio button { cursor: pointer; }
.studio :focus-visible { outline: 2px solid var(--pen-b); outline-offset: 2px; }

/* header ------------------------------------------------------------------ */
.top {
  display: flex; flex-wrap: wrap; gap: 16px;
  align-items: flex-end; justify-content: space-between;
  padding-bottom: 14px; border-bottom: 1px solid var(--edge);
}
.brand { display: flex; gap: 12px; align-items: center; }
.mark {
  width: 26px; height: 26px; border-radius: 50%;
  background: radial-gradient(circle at 32% 32%, var(--pen-a) 0 42%, transparent 43%),
              radial-gradient(circle at 68% 68%, var(--pen-b) 0 42%, transparent 43%);
  border: 1px solid var(--edge);
}
.top h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.top p { font-size: 12px; color: var(--muted); }
.topctl { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field > span { font-size: 11px; color: var(--muted); }
.dims { display: flex; align-items: center; gap: 4px; }
.dims input { width: 58px; }
.dims i { color: var(--muted); font-style: normal; }

.studio select, .studio input[type=number], .studio input[type=text], .studio .importrow input {
  background: var(--chrome-2); border: 1px solid var(--edge);
  border-radius: 4px; padding: 4px 6px; color: var(--text);
}
.studio input[type=number] { width: 62px; }

/* layout ------------------------------------------------------------------ */
.grid {
  display: grid; gap: 16px; padding-top: 16px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 380px);
  grid-template-areas: 'stage panel' 'out panel';
  align-items: start;
}
.stage { grid-area: stage; }
.panel { grid-area: panel; }
.out { grid-area: out; }
@media (max-width: 900px) {
  .grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'stage' 'panel' 'out'; }
}

/* stage ------------------------------------------------------------------- */
.stagebar {
  display: flex; flex-wrap: wrap; gap: 10px;
  align-items: center; justify-content: space-between; margin-bottom: 10px;
}
.presets { display: flex; flex-wrap: wrap; gap: 5px; }
.presets button {
  background: transparent; border: 1px solid var(--edge);
  border-radius: 999px; padding: 3px 10px; color: var(--muted);
}
.presets button:hover { color: var(--text); border-color: var(--pen-b); }
.toggles { display: flex; gap: 12px; }
.check { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; color: var(--muted); }
.check input { accent-color: var(--pen-b); }

.bedwrap { background: var(--bed); border-radius: 3px; padding: 6px; }
.bed { display: block; width: 100%; height: auto; touch-action: none; }
.grid line { stroke: var(--bed-line); }
.box { fill: none; stroke: #8d9a95; stroke-dasharray: 6 4; }
.fill { fill: rgba(228, 50, 107, 0.10); }
.tangent { stroke: var(--pen-b); opacity: 0.75; }
.seg { fill: none; stroke: var(--pen-a); stroke-linecap: round; stroke-linejoin: round; }
.seg.is-hot { stroke: #111c1e; }
.seg.is-jump { stroke: #9aa7a2; }
.hit { fill: none; stroke: transparent; cursor: pointer; }
.ghost { fill: none; stroke: var(--pen-b); opacity: 0.55; stroke-dasharray: 2 2; }
.handle { cursor: grab; }
.handle:active { cursor: grabbing; }
.halo { fill: transparent; }
.node { fill: #fff; stroke: var(--pen-a); }
.node.is-origin { fill: var(--pen-a); }
.node.is-jump { stroke: #7e8b86; }
.node.is-hot { fill: var(--pen-a); }
.ctrl { fill: var(--bed); stroke: var(--pen-b); }

.previews { margin-top: 14px; }
.previews figure { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.previews figcaption { font-size: 11px; color: var(--muted); }
.clipped { position: relative; max-width: 100%; }
.clipped.is-bordered { border: 10px solid var(--pen-a); }
.clipped-art {
  width: 100%; height: 100%;
  background:
    repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 9px, transparent 9px 18px),
    linear-gradient(150deg, var(--pen-a), #7a2f8f 52%, var(--pen-b));
}
.traveller {
  position: absolute; top: 0; left: 0; width: 16px; height: 16px;
  background: var(--amber); offset-distance: 0%;
}
.traveller.is-running { animation: travel 4.5s linear infinite; }
@keyframes travel { to { offset-distance: 100%; } }
@media (prefers-reduced-motion: reduce) { .traveller.is-running { animation: none; } }

/* panel ------------------------------------------------------------------- */
.panel, .out {
  background: var(--chrome-2); border: 1px solid var(--edge);
  border-radius: 6px; padding: 12px;
}
.panelhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.panelhead h2 { font-size: 12px; font-weight: 600; color: var(--muted); }
.hint { font-size: 11px; color: var(--muted); margin-left: auto; }
.spacer { flex: 1; }

.fromrow, .cprow {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 6px 8px; border-radius: 4px; background: var(--chrome-3);
}
.fromrow { margin-bottom: 10px; border-left: 3px solid var(--pen-a); }
.cplabel { font-size: 11px; color: var(--muted); min-width: 54px; }

.rows { display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto; }
.row {
  border: 1px solid var(--edge); border-radius: 5px;
  padding: 7px 8px; background: var(--chrome);
}
.row.is-hot { border-color: var(--pen-a); background: #212d2c; }
.rowhead { display: flex; gap: 6px; align-items: center; }
.rowhead button {
  background: transparent; border: none; color: var(--muted);
  padding: 2px 4px; border-radius: 3px; line-height: 1;
}
.rowhead button:hover { color: var(--text); background: var(--chrome-3); }
.idx { font-size: 11px; color: var(--muted); min-width: 16px; }
.rowbody { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 7px; }
.cpgroup { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }

.numunit { display: inline-flex; align-items: center; gap: 3px; }
.numunit em { font-size: 10px; color: var(--muted); font-style: normal; }
.numunit input { width: 56px; }
.unit {
  background: var(--chrome-3); border: 1px solid var(--edge);
  border-radius: 3px; padding: 2px 5px; color: var(--muted); font-size: 11px;
}
.unit:hover { color: var(--pen-b); }
.unit.static { cursor: default; }

.frag {
  display: block; margin-top: 7px; font-size: 11px;
  color: var(--pen-b); word-break: break-word;
}
.adds { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.adds button {
  background: var(--chrome-3); border: 1px solid var(--edge);
  border-radius: 4px; padding: 3px 8px; color: var(--muted);
}
.adds button:hover { color: var(--text); border-color: var(--pen-b); }
.why { margin-top: 10px; font-size: 11px; color: var(--muted); min-height: 2.4em; }

/* output ------------------------------------------------------------------ */
.ghostbtn {
  background: transparent; border: 1px solid var(--edge);
  border-radius: 4px; padding: 3px 9px; color: var(--muted);
}
.ghostbtn:hover { color: var(--text); border-color: var(--pen-b); }
.code {
  background: var(--chrome); border: 1px solid var(--edge); border-radius: 5px;
  padding: 11px; font-size: 12px; line-height: 1.6; color: #cfe6e4;
  white-space: pre-wrap; word-break: break-word; overflow-x: auto;
}
.warn {
  font-size: 11px; color: var(--amber); margin-bottom: 8px;
  border-left: 2px solid var(--amber); padding-left: 8px;
}
.warn code { color: inherit; }
.importer { margin-top: 12px; }
.importhead { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.importer textarea {
  width: 100%; background: var(--chrome); border: 1px solid var(--edge);
  border-radius: 4px; padding: 7px 8px; color: var(--text);
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px;
  line-height: 1.55; resize: vertical;
}
.importer textarea::placeholder { color: #63736f; }
.badge {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--edge); color: var(--muted);
}
.badge.is-svg, .badge.is-path { color: var(--pen-b); border-color: var(--pen-b); }
.badge.is-css { color: var(--pen-a); border-color: var(--pen-a); }
.ghostbtn[disabled] { opacity: 0.4; cursor: not-allowed; }
.note { font-size: 11px; color: var(--pen-b); margin-top: 7px; }
.importer label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 5px; }
.importrow { display: flex; gap: 8px; align-items: center; margin-top: 7px; }
.importrow .check { gap: 6px; }
.importrow input { flex: 1; min-width: 0; font-size: 11px; }
`;
