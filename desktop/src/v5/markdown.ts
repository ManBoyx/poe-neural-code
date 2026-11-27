// Rendu des réponses : Markdown -> HTML NETTOYÉ (DOMPurify) ; le texte du modèle n'est jamais injecté tel quel.
// Blocs ```chart -> graphique SVG ; liens vers une vidéo ou un son -> lecteur intégré (espace Médias).
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { chartHtml, parseChart } from "./chart";

// par l'extension, ou par le chemin des liens de Poe, qui n'ont pas d'extension (…poecdn.net/base/audio/<empreinte>)
const VIDEO = /\.(mp4|webm|mov|m4v)(\?|#|$)|poecdn\.net\/(?:[\w-]+\/)*video\//i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac)(\?|#|$)|poecdn\.net\/(?:[\w-]+\/)*audio\//i;
const IMAGE = /\.(png|jpe?g|webp|gif|avif)(\?|#|$)|poecdn\.net\/(?:[\w-]+\/)*image\//i;
export const safeUrl = (u: string) => /^(https?:|blob:|data:image\/(png|jpe?g|gif|webp|avif);)/i.test(u);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code({ text, lang }) {
      if ((lang || "").trim() === "chart") {
        try {
          const spec = parseChart(text);
          return spec ? chartHtml(spec) : `<div class="chart chart-wait">Graphique en préparation…</div>`;
        } catch {
          return `<div class="chart chart-wait">Graphique illisible.</div>`; // jamais de fil cassé par un graphique
        }
      }
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const html = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      const label = (lang || "").replace(/[^\w+#.-]/g, "");
      return `<div class="code"><div class="code-bar"><span>${label || "code"}</span><button class="copy" data-copy>Copier</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
    link({ href, text }) {
      if (safeUrl(href) && VIDEO.test(href)) return `<video class="media" controls preload="metadata" src="${esc(href)}"></video>`;
      if (safeUrl(href) && AUDIO.test(href)) return `<audio class="media" controls preload="metadata" src="${esc(href)}"></audio>`;
      if (safeUrl(href) && /^https?:/i.test(href) && IMAGE.test(href) && /poecdn\.net/i.test(href) && text === href)
        return `<a class="media-img" href="${esc(href)}" data-media="${esc(href)}"><img src="${esc(href)}" alt="image générée" loading="lazy"></a>`;
      return false;
    },
    image({ href, text }) {
      if (safeUrl(href) && VIDEO.test(href)) return `<video class="media" controls preload="metadata" src="${esc(href)}"></video>`;
      if (!safeUrl(href)) return esc(text || "");
      return `<a class="media-img" href="${esc(href)}" data-media="${esc(href)}"><img src="${esc(href)}" alt="${esc(text || "image générée")}" loading="lazy"></a>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

const cache = new Map<string, string>();
const CACHE_MAX = 80;

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.parse(text, { async: false }) as string, {
    ADD_TAGS: ["video", "audio", "figure", "figcaption", "details", "summary"],
    ADD_ATTR: ["data-copy", "data-tip", "data-media", "target", "controls", "preload", "loading"],
    // aucun style venant du modèle : une réponse ne doit pas pouvoir recouvrir ou maquiller une fenêtre de confiance
    FORBID_TAGS: ["style", "link", "meta", "base", "form", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(text, html);
  return html;
}

/** Médias trouvés dans un texte (galerie de l'espace Médias, colonne de droite). */
export function mediaIn(text: string): { kind: "image" | "video" | "audio"; url: string }[] {
  const out: { kind: "image" | "video" | "audio"; url: string }[] = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s)"'<>]+)/g)) {
    const url = m[1] || m[2];
    if (!url || !safeUrl(url)) continue;
    const kind = VIDEO.test(url) ? "video" : AUDIO.test(url) ? "audio" : m[0].startsWith("!") || IMAGE.test(url) ? "image" : null;
    if (kind && !out.some((o) => o.url === url)) out.push({ kind, url });
  }
  return out;
}

/** Graphiques trouvés dans un texte (colonne de droite). */
export function chartsIn(text: string): string[] {
  return [...text.matchAll(/```chart\s*\n([\s\S]*?)```/g)].map((m) => m[1]).filter((t) => parseChart(t));
}
