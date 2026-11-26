/**
 * Graphiques dans la discussion : un bloc ```chart (JSON) écrit par le modèle devient un SVG.
 * {"type":"bar"|"line"|"pie","title":"…","labels":["…"],"series":[{"name":"…","data":[nombres]}]}
 * Règles (méthode dataviz) : couleurs catégorielles dans un ordre fixe (8 au plus, jamais recyclées), une seule échelle,
 * marques fines (barres à bout arrondi de 4 px posées sur la ligne de base, espace de 2 px, lignes de 2 px, points de
 * 8 px cerclés du fond), grille discrète, légende dès 2 séries, textes en couleur de texte, infobulle au survol
 * (data-tip, lue par le fil), et toujours un tableau des valeurs (contraste insuffisant de certaines teintes en clair).
 * Le SVG produit passe ensuite par DOMPurify avec le reste du message.
 */
export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  labels: string[];
  series: { name: string; data: number[] }[];
  unit?: string;
}

const MAX_SERIES = 8;
const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: number, unit?: string) => nf.format(v) + (unit ? ` ${unit}` : "");

/** Lit et borne la spécification ; null si elle n'est pas exploitable. */
export function parseChart(text: string): ChartSpec | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || !["bar", "line", "pie"].includes(j.type) || !Array.isArray(j.labels) || !Array.isArray(j.series)) return null;
  const labels = j.labels.slice(0, 60).map((l: unknown) => String(l).slice(0, 40));
  let series = j.series
    .filter((s: any) => s && Array.isArray(s.data))
    .map((s: any, i: number) => ({ name: String(s.name ?? `Série ${i + 1}`).slice(0, 40), data: labels.map((_: unknown, k: number) => (Number.isFinite(Number(s.data[k])) ? Number(s.data[k]) : 0)) }));
  if (!series.length || !labels.length) return null;
  // au-delà de 8 séries : les suivantes sont regroupées dans « Autres » (jamais de 9e couleur)
  if (series.length > MAX_SERIES) {
    const rest = series.slice(MAX_SERIES - 1);
    series = [...series.slice(0, MAX_SERIES - 1), { name: "Autres", data: labels.map((_: unknown, k: number) => rest.reduce((a: number, s: any) => a + s.data[k], 0)) }];
  }
  return { type: j.type, title: j.title ? String(j.title).slice(0, 120) : undefined, labels, series, unit: j.unit ? String(j.unit).slice(0, 12) : undefined };
}

/** Graduations « rondes » couvrant [min, max]. */
function ticks(min: number, max: number, n = 4): number[] {
  if (min === max) max = min + 1;
  const raw = (max - min) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function legend(spec: ChartSpec): string {
  if (spec.type !== "pie" && spec.series.length < 2) return "";
  const items = spec.type === "pie"
    ? pieParts(spec).map((p, i) => `<span class="lg"><i class="sw s${i + 1}"></i>${esc(p.label)} <b>${Math.round(p.share * 100)} %</b></span>`)
    : spec.series.map((s, i) => `<span class="lg"><i class="sw s${i + 1}"></i>${esc(s.name)}</span>`);
  return `<div class="chart-legend">${items.join("")}</div>`;
}

function table(spec: ChartSpec): string {
  const head = `<tr><th></th>${spec.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>`;
  const rows = spec.labels.map((l, k) => `<tr><td>${esc(l)}</td>${spec.series.map((s) => `<td>${esc(fmt(s.data[k], spec.unit))}</td>`).join("")}</tr>`).join("");
  return `<details class="chart-table"><summary>Tableau des valeurs</summary><table><thead>${head}</thead><tbody>${rows}</tbody></table></details>`;
}

const W = 640, H = 280, PAD = { l: 52, r: 16, t: 12, b: 34 };

function axes(min: number, max: number, labels: string[], xAt: (k: number) => number, unit?: string) {
  const tk = ticks(min, max);
  const lo = tk[0], hi = tk[tk.length - 1];
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const grid = tk.map((v) => `<line class="grid${v === 0 ? " zero" : ""}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${PAD.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(compact.format(v))}</text>`).join("");
  const every = Math.ceil(labels.length / 10); // au plus ~10 étiquettes en bas, sans chevauchement
  const xl = labels.map((l, k) => (k % every ? "" : `<text class="ax" x="${xAt(k)}" y="${H - PAD.b + 18}" text-anchor="middle">${esc(l.length > 12 ? l.slice(0, 11) + "…" : l)}</text>`)).join("");
  return { y, svg: grid + xl, lo, hi, unit };
}

function barChart(spec: ChartSpec): string {
  const all = spec.series.flatMap((s) => s.data);
  const n = spec.labels.length, m = spec.series.length;
  const band = (W - PAD.l - PAD.r) / n;
  const gap = 2; // espace de 2 px entre barres voisines
  const bw = Math.max(2, Math.min(28, (band * 0.72 - gap * (m - 1)) / m));
  const groupW = bw * m + gap * (m - 1);
  const xAt = (k: number) => PAD.l + band * k + band / 2;
  const ax = axes(Math.min(0, ...all), Math.max(0, ...all), spec.labels, xAt, spec.unit);
  const base = ax.y(0);
  let marks = "";
  spec.series.forEach((s, i) => s.data.forEach((v, k) => {
    const x = xAt(k) - groupW / 2 + i * (bw + gap);
    const top = ax.y(v);
    const h = Math.abs(base - top);
    const r = Math.min(4, bw / 2, h); // bout arrondi de 4 px, côté opposé à la ligne de base
    const up = v >= 0;
    const y0 = up ? top : base, y1 = up ? base : top;
    const d = h < 0.5 ? "" : up
      ? `M${x},${y1}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + bw - r}Q${x + bw},${y0} ${x + bw},${y0 + r}V${y1}Z`
      : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
    const tip = esc(`${spec.labels[k]} · ${m > 1 ? s.name + " : " : ""}${fmt(v, spec.unit)}`);
    marks += `<g data-tip="${tip}"><rect class="hit" x="${x - 1}" y="${PAD.t}" width="${bw + 2}" height="${H - PAD.t - PAD.b}"/>${d ? `<path class="f s${i + 1}" d="${d}"/>` : ""}</g>`;
  }));
  // étiquettes directes choisies : le maximum de chaque série (jamais un nombre sur chaque barre)
  let labels = "";
  if (m <= 2) spec.series.forEach((s, i) => {
    const k = s.data.indexOf(Math.max(...s.data));
    if (k < 0 || s.data[k] <= 0) return;
    labels += `<text class="dl" x="${xAt(k) - groupW / 2 + i * (bw + gap) + bw / 2}" y="${ax.y(s.data[k]) - 6}" text-anchor="middle">${esc(compact.format(s.data[k]))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title ?? "graphique en barres")}">${ax.svg}${marks}${labels}</svg>`;
}

function lineChart(spec: ChartSpec): string {
  const all = spec.series.flatMap((s) => s.data);
  const n = spec.labels.length;
  const xAt = (k: number) => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : ((W - PAD.l - PAD.r) * k) / (n - 1));
  const mn = Math.min(...all), mx = Math.max(...all);
  const ax = axes(mn >= 0 && mn < mx * 0.5 ? 0 : mn, mx, spec.labels, xAt, spec.unit);
  let marks = "";
  spec.series.forEach((s, i) => {
    const pts = s.data.map((v, k) => [xAt(k), ax.y(v)] as const);
    marks += `<polyline class="ln l${i + 1}" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    const showDots = n <= 24;
    pts.forEach(([x, y], k) => {
      const tip = esc(`${spec.labels[k]} · ${spec.series.length > 1 ? s.name + " : " : ""}${fmt(s.data[k], spec.unit)}`);
      marks += `<g data-tip="${tip}"><circle class="hit" cx="${x}" cy="${y}" r="12"/>${showDots ? `<circle class="dot s${i + 1}" cx="${x}" cy="${y}" r="4"/>` : ""}</g>`;
    });
    // étiquette directe en bout de ligne (4 séries au plus)
    if (spec.series.length <= 4) {
      const [x, y] = pts[pts.length - 1];
      marks += `<text class="dl" x="${Math.min(x, W - PAD.r - 4)}" y="${y - 10}" text-anchor="end">${esc(compact.format(s.data[s.data.length - 1]))}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title ?? "graphique en courbes")}">${ax.svg}${marks}</svg>`;
}

function pieParts(spec: ChartSpec): { label: string; value: number; share: number }[] {
  const vals = spec.labels.map((l, k) => ({ label: l, value: Math.max(0, spec.series[0].data[k]) })).sort((a, b) => b.value - a.value);
  const top = vals.length > 6 ? [...vals.slice(0, 5), { label: "Autres", value: vals.slice(5).reduce((a, v) => a + v.value, 0) }] : vals;
  const total = top.reduce((a, v) => a + v.value, 0) || 1;
  return top.map((v) => ({ ...v, share: v.value / total }));
}

function pieChart(spec: ChartSpec): string {
  const parts = pieParts(spec);
  const cx = 140, cy = 130, R = 110, r = 66; // anneau : la valeur se lit sur la longueur d'arc et dans la légende
  let a0 = -Math.PI / 2;
  let marks = "";
  parts.forEach((p, i) => {
    if (p.share <= 0) return;
    const a1 = a0 + p.share * Math.PI * 2 - (parts.length > 1 ? 0.012 : 0); // 2 px environ entre parts
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const d = p.share >= 0.999
      ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`
      : `M${pt(R, a0)}A${R},${R} 0 ${big} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${big} 0 ${pt(r, a0)}Z`;
    marks += `<g data-tip="${esc(`${p.label} : ${fmt(p.value, spec.unit)} (${Math.round(p.share * 100)} %)`)}"><path class="f s${i + 1}" d="${d}"/></g>`;
    a0 = a1 + (parts.length > 1 ? 0.012 : 0);
  });
  const total = parts.reduce((a, p) => a + p.value, 0);
  // total au centre, sauf pour des pourcentages (il vaudrait 100 et n'apprendrait rien)
  if (spec.unit !== "%") marks += `<text class="hero" x="${cx}" y="${cy + 2}" text-anchor="middle">${esc(compact.format(total))}</text><text class="ax" x="${cx}" y="${cy + 20}" text-anchor="middle">total</text>`;
  return `<svg viewBox="0 0 280 260" class="pie" role="img" aria-label="${esc(spec.title ?? "répartition")}">${marks}</svg>`;
}

export function chartHtml(spec: ChartSpec): string {
  const body = spec.type === "bar" ? barChart(spec) : spec.type === "line" ? lineChart(spec) : pieChart(spec);
  const title = spec.title || (spec.series.length === 1 && spec.type !== "pie" ? spec.series[0].name : "");
  return `<figure class="chart chart-${spec.type}">${title ? `<figcaption>${esc(title)}</figcaption>` : ""}${spec.type === "pie" ? `<div class="pie-wrap">${body}${legend(spec)}</div>` : body + legend(spec)}${table(spec)}</figure>`;
}

/** Barres simples pour l'écran de consommation (une série, étiquettes de date). */
export function usageBars(days: { label: string; value: number }[], unit: string): string {
  return chartHtml({ type: "bar", labels: days.map((d) => d.label), series: [{ name: unit, data: days.map((d) => d.value) }], unit });
}
