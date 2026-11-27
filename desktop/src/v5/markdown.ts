// Rendu des réponses : Markdown -> HTML NETTOYÉ (DOMPurify) ; le texte du modèle n'est jamais injecté tel quel.
// Blocs ```chart -> graphique SVG ; liens vers une vidéo ou un son -> lecteur intégré (espace Médias).
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { chartHtml, parseChart } from "./chart";

// par l'extension, ou, pour les liens de Poe (sans extension : https://…poecdn.net/base/audio/<empreinte>), par l'hôte
// réellement poecdn.net et le dossier audio/video/image du chemin
function poeKind(u: string): "audio" | "video" | "image" | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || !(x.hostname === "poecdn.net" || x.hostname.endsWith(".poecdn.net"))) return null;
    const m = x.pathname.match(/\/(audio|video|image)\//);
    return m ? (m[1] as "audio" | "video" | "image") : null;
  } catch { return null; }
}
const ext = (re: RegExp) => ({ test: (u: string) => re.test(u.split(/[?#]/)[0]) });
const VID = ext(/\.(mp4|webm|mov|m4v)$/i), AUD = ext(/\.(mp3|wav|ogg|oga|m4a|flac|aac)$/i), IMG = ext(/\.(png|jpe?g|webp|gif|avif)$/i);
const VIDEO = { test: (u: string) => VID.test(u) || poeKind(u) === "video" };
const AUDIO = { test: (u: string) => AUD.test(u) || poeKind(u) === "audio" };
const IMAGE = { test: (u: string) => IMG.test(u) || poeKind(u) === "image" };
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
      if (safeUrl(href) && poeKind(href) === "image")
        return `<a class="media-img" href="${esc(href)}" data-media="${esc(href)}"><img src="${esc(href)}" alt="image générée" loading="lazy"></a>`;
      return false;
    },
    image({ href, text }) {
      if (safeUrl(href) && VIDEO.test(href)) return `<video class="media" controls preload="metadata" src="${esc(href)}"></video>`;
      if (safeUrl(href) && AUDIO.test(href)) return `<audio class="media" controls preload="metadata" src="${esc(href)}"></audio>`;
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
