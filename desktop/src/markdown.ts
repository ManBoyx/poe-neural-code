// Rendu des réponses : Markdown -> HTML NETTOYÉ (DOMPurify) ; le texte du modèle n'est jamais injecté tel quel.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const html = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      const label = (lang || "").replace(/[^\w+#.-]/g, "");
      return `<div class="code"><div class="code-bar"><span>${label || "code"}</span><button class="copy" data-copy>Copier</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.parse(text, { async: false }) as string, { ADD_ATTR: ["data-copy", "target"] });
}
