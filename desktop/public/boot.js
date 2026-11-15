// Chargé avant l'interface : si le module principal échoue à se charger, l'erreur s'affiche au lieu d'un écran vide.
(function () {
  function show(msg) {
    var box = document.createElement("pre");
    box.style.cssText = "position:fixed;inset:60px 20px auto 20px;padding:12px;border:1px solid #f87171;border-radius:8px;background:#1b1b2e;color:#fca5a5;white-space:pre-wrap;z-index:50";
    box.textContent = "Erreur de chargement : " + msg;
    (document.body || document.documentElement).appendChild(box);
  }
  window.addEventListener("error", function (e) { show((e.error && e.error.stack) || e.message || String(e)); });
  window.addEventListener("unhandledrejection", function (e) { show((e.reason && e.reason.stack) || String(e.reason)); });
  setTimeout(function () { if (!window.__eclipseReady) show("le script de l'interface ne s'est pas chargé (fichier manquant ou bloqué)."); }, 30000);
})();
