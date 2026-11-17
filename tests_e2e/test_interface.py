"""Parcours de l'interface Eclipse Desktop avec le faux fournisseur (aucune IA réelle)."""
import os
import signal
import time

from playwright.sync_api import expect

from .conftest import tauri_stub


def test_demarrage_et_accueil(page):
    expect(page.get_by_text("Dossier de travail")).to_be_visible()
    expect(page.get_by_text("Économie de tokens")).to_be_visible()
    expect(page.locator(".model-btn")).to_contain_text("m1")


def test_nouvelle_discussion_cree_son_dossier(page, server):
    page.get_by_role("button", name="Nouvelle discussion").first.click()
    expect(page.locator(".chip").first).to_contain_text("discussion-")
    folders = os.listdir(server["data"] / "discussions")
    assert len(folders) == 1 and folders[0].startswith("discussion-")


def test_message_carte_autorisation_puis_reponse(page, server):
    page.locator("textarea").fill("Que contient ce projet ?")
    page.keyboard.press("Enter")
    card = page.locator(".perm")
    expect(card).to_be_visible(timeout=10_000)
    expect(card).to_contain_text("ls -la")
    page.get_by_role("button", name="Autoriser une fois").click()
    expect(page.locator(".msg.assistant").last).to_contain_text("Voulez-vous que je crée les tests", timeout=10_000)
    expect(page.locator(".code-bar").first).to_contain_text("python")
    expect(page.locator(".conv-title").first).to_have_text("Que contient ce projet ?")


def test_refus_d_autorisation(page):
    page.locator("textarea").fill("Liste")
    page.keyboard.press("Enter")
    expect(page.locator(".perm")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Refuser").click()
    expect(page.locator(".perm")).to_have_count(0, timeout=10_000)


def test_panneau_memoire(page):
    page.get_by_title("Mémoire du dossier").click()
    expect(page.locator(".memory")).to_contain_text("Le site utilise Flask plutôt que Django.")
    expect(page.locator(".memory")).to_contain_text("Décisions")
    page.locator(".memory input").fill("pytest")
    expect(page.locator(".hit").first).to_contain_text("pytest")


def test_panneau_fichiers_et_apercu(page):
    page.get_by_title("Fichiers du dossier").click()
    page.locator(".file", has_text="app.py").click()
    expect(page.locator(".code.preview")).to_contain_text("from flask import Flask")
    page.keyboard.press("Escape")
    expect(page.locator(".code.preview")).to_have_count(0)


def test_piece_jointe_image(page, server, tmp_path):
    img = tmp_path / "capture.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 64)
    page.locator(".composer-bar input[type=file]").set_input_files(str(img))
    expect(page.locator(".att")).to_contain_text("capture.png")
    page.locator("textarea").fill("Regarde")
    page.keyboard.press("Enter")
    expect(page.locator(".msg.user").last).to_contain_text("pièces jointes : capture.png")
    stored = list((server["data"] / "attachments").rglob("*capture.png"))
    assert len(stored) == 1


def test_palette_ctrl_k(page):
    page.keyboard.press("Control+k")
    page.keyboard.type("mémoire")
    expect(page.locator(".pal-item")).to_have_count(1)
    page.keyboard.press("Enter")
    expect(page.locator(".memory")).to_be_visible()


def test_theme_clair(page):
    page.keyboard.press("Control+k")
    page.keyboard.type("thème")
    page.keyboard.press("Enter")
    expect(page.locator("html")).to_have_attribute("data-theme", "light")
    expect(page.locator("body")).to_have_css("background-color", "rgb(251, 251, 252)")


def test_panne_du_moteur_affiche_la_banniere(page, server):
    os.killpg(server["proc"].pid, signal.SIGKILL)
    expect(page.locator(".banner")).to_contain_text("ne répond plus", timeout=25_000)
    expect(page.get_by_role("button", name="Réessayer")).to_be_visible()


# --- Application desktop simulée (Tauri) : moteur lent, absent, relance ----------------------------------------------

def test_moteur_lent_ecran_de_demarrage_puis_interface(browser, server):
    pg = browser.new_page()
    pg.add_init_script(tauri_stub(
        "(cmd) => cmd === 'engine_info' ? new Promise(r => setTimeout(() => r({port: %d, token: '%s'}), 35000))"
        " : Promise.reject('non simulé')" % (server["port"], server["token"])))
    t0 = time.time()
    pg.goto(server["url"] + "/")
    expect(pg.get_by_text("Démarrage du moteur Eclipse")).to_be_visible()
    expect(pg.get_by_text("plus long que d'habitude")).to_be_visible(timeout=25_000)
    pg.wait_for_timeout(max(0, 31_000 - (time.time() - t0) * 1000))
    expect(pg.get_by_text("Erreur de chargement")).to_have_count(0)  # l'ancien délai de 30 s de boot.js ne se déclenche plus
    expect(pg.get_by_text("Que voulez-vous faire")).to_be_visible(timeout=15_000)


def test_moteur_absent_puis_relance(browser, server):
    pg = browser.new_page()
    pg.add_init_script(tauri_stub(
        "(cmd) => cmd === 'engine_info' ? Promise.reject('moteur Eclipse introuvable dans l\\'installation')"
        " : cmd === 'engine_restart' ? Promise.resolve({port: %d, token: '%s'}) : Promise.reject('non simulé')"
        % (server["port"], server["token"])))
    pg.goto(server["url"] + "/")
    expect(pg.get_by_text("Le moteur Eclipse n'a pas démarré")).to_be_visible()
    expect(pg.get_by_text("moteur Eclipse introuvable")).to_be_visible()
    pg.get_by_role("button", name="Relancer le moteur").click()
    expect(pg.get_by_text("Que voulez-vous faire")).to_be_visible(timeout=10_000)


# --- Étape B ---------------------------------------------------------------------------------------------------------

def test_arobase_autocompletion_et_fichier_tronque(page, server):
    (server["project"] / "gros.txt").write_text("x" * 50_000, encoding="utf-8")  # créé APRÈS l'ouverture
    box = page.locator("textarea")
    box.click()
    page.keyboard.type("Regarde @gro")
    expect(page.locator(".sg").first).to_contain_text("@gros.txt")
    expect(page.locator(".sg").first).to_contain_text("sera tronqué")
    page.keyboard.press("Enter")
    expect(box).to_have_value("Regarde @gros.txt ")
    expect(page.locator(".ref.cut")).to_contain_text("tronqué à 40 k car.")
    page.keyboard.type("et @absent.py")
    expect(page.locator(".ref.missing")).to_contain_text("introuvable")


def test_commandes_slash(page):
    box = page.locator("textarea")
    box.click()
    page.keyboard.type("/me")
    expect(page.locator(".sg").first).to_contain_text("/memory")
    page.keyboard.press("Enter")  # action sans argument : exécutée tout de suite
    expect(page.locator(".memory")).to_be_visible()
    expect(box).to_have_value("")
    page.keyboard.type("/inconnue")
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("Commande inconnue")


def test_commande_prompt_review(page):
    page.locator("textarea").fill("/review src/")
    page.keyboard.press("Enter")
    expect(page.locator(".msg.user").last).to_have_text("/review src/")


def test_export_markdown_navigateur(page):
    page.locator("textarea").fill("Bonjour")
    page.keyboard.press("Enter")
    expect(page.locator(".perm")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Autoriser une fois").click()
    expect(page.locator(".msg.assistant").last).to_contain_text("Voulez-vous", timeout=10_000)
    with page.expect_download() as dl:
        page.keyboard.press("Control+k")
        page.keyboard.type("exporter")
        page.keyboard.press("Enter")
    d = dl.value
    assert d.suggested_filename == "Bonjour.md"
    text = open(d.path(), encoding="utf-8").read()
    assert "## Vous\n\nBonjour" in text and "> Outil `list_dir`" in text


def test_recherche_dans_le_contenu(page):
    page.locator("textarea").fill("Parlons de cryptographie")
    page.keyboard.press("Enter")
    expect(page.locator(".perm")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Refuser").click()
    page.locator(".side-search input").fill("cryptographie")
    expect(page.locator(".hitconv").first).to_contain_text("cryptographie")


def test_diff_global_et_tout_annuler(page, server):
    (server["project"] / "nouveau.md").write_text("créé par l'IA\n", encoding="utf-8")
    (server["project"] / "README.md").write_text("# Démo modifiée\n", encoding="utf-8")
    page.keyboard.press("Control+k")
    page.keyboard.type("modifications des fichiers")
    page.keyboard.press("Enter")
    modal = page.locator(".modal", has_text="Modifications de la discussion")
    expect(modal.locator(".chg.A", has_text="nouveau.md")).to_be_visible()
    expect(modal.locator(".diff")).to_contain_text("+# Démo modifiée")
    modal.get_by_role("button", name="Tout annuler").click()
    page.locator(".modal", has_text="Tout annuler ?").get_by_role("button", name="Annuler 3 modification(s)").click()
    expect(page.locator(".toast")).to_contain_text("restauré")
    assert not (server["project"] / "nouveau.md").exists()
    assert (server["project"] / "README.md").read_text(encoding="utf-8") == "# Démo\n"


# --- Étape C ---------------------------------------------------------------------------------------------------------

def test_memoire_modifier_et_epingler(page):
    page.get_by_title("Mémoire du dossier").click()
    note = page.locator(".note-item", has_text="Flask")
    note.get_by_role("button", name="Modifier").click()
    page.locator(".ni-edit").fill("Le site utilise Flask 3 plutôt que Django.")
    page.keyboard.press("Control+Enter")
    expect(page.locator(".note-item", has_text="Flask 3")).to_be_visible()
    page.locator(".note-item", has_text="Flask 3").get_by_role("button", name="Épingler").click()
    expect(page.locator(".memory section").first).to_contain_text("Épinglées")
    expect(page.locator(".note-item.pinned")).to_contain_text("Flask 3")


def test_conso_tokens_evites_et_methode(page):
    page.get_by_title("Consommation").click()
    expect(page.locator(".usage")).to_contain_text("Tokens évités (estimation)")
    page.get_by_text("Comment c'est calculé").click()
    expect(page.locator(".method p")).to_contain_text("Estimation, pas une mesure du fournisseur")


# --- Étape D : mise à jour 0.2.x -> 0.3.0 (application desktop simulée) -------------------------------------------------

UPDATE = ("{version: '0.3.0', current: '0.2.0', date: '2026-11-16', notes: '## Nouveautés\\\\n- Relance du moteur\\\\n- Mémoire éditable',"
          " sha256: 'ab'.repeat(32), can_install: true, reason: null, page: 'https://github.com/ManBoyx/eclipse-releases/releases/tag/v0.3.0'}")


def _desktop(browser, server, install_result: str):
    pg = browser.new_page()
    pg.add_init_script(tauri_stub(
        "(cmd) => cmd === 'engine_info' ? Promise.resolve({port: %d, token: '%s'})"
        " : cmd === 'update_check' ? Promise.resolve(%s)"
        " : cmd === 'update_install' ? %s : Promise.reject('non simulé')" % (server["port"], server["token"], UPDATE, install_result)))
    pg.goto(server["url"] + "/")
    pg.get_by_text("Que voulez-vous faire").wait_for(timeout=10_000)
    pg.keyboard.press("Control+,")
    pg.get_by_role("button", name="Vérifier maintenant").click()
    expect(pg.get_by_text("Version 0.3.0 disponible")).to_be_visible()
    pg.keyboard.press("Escape")
    pg.get_by_role("button", name="Mise à jour 0.3.0").click()
    return pg


def test_mise_a_jour_affiche_le_journal_avant_installation(browser, server):
    pg = _desktop(browser, server, "new Promise(() => {})")
    dlg = pg.locator(".modal", has_text="Eclipse 0.3.0")
    expect(dlg).to_contain_text("Version installée : 0.2.0")
    expect(dlg.locator(".changelog")).to_contain_text("Mémoire éditable")
    expect(dlg).to_contain_text("vérifie l'empreinte SHA-256")
    dlg.get_by_role("button", name="Installer").click()
    expect(dlg).to_contain_text("Téléchargement")


def test_mise_a_jour_refusee_si_signature_invalide(browser, server):
    pg = _desktop(browser, server, "Promise.reject('mise à jour refusée : signature invalide')")
    dlg = pg.locator(".modal", has_text="Eclipse 0.3.0")
    dlg.get_by_role("button", name="Installer").click()
    expect(dlg.locator(".err")).to_contain_text("signature invalide")
    expect(dlg.get_by_role("button", name="Plus tard")).to_be_enabled()


# --- Étape E ---------------------------------------------------------------------------------------------------------

def test_aide_f1_et_raccourcis_affiches(page):
    expect(page.locator(".new kbd")).to_have_text("Ctrl+N")
    page.keyboard.press("F1")
    dlg = page.locator(".modal", has_text="Aide : raccourcis et commandes")
    expect(dlg).to_contain_text("Ctrl+K")
    expect(dlg).to_contain_text("/diff")
    expect(dlg).to_contain_text("/review")
    page.keyboard.press("Escape")
    expect(dlg).to_have_count(0)


def test_focus_clavier_dans_les_fenetres(page):
    box = page.locator("textarea")
    box.focus()
    page.keyboard.press("Control+,")
    expect(page.locator(".modal :focus")).to_have_count(1)  # le focus est dans la fenêtre
    page.keyboard.press("Escape")
    expect(box).to_be_focused()  # puis il revient à la saisie
    # (wait_for_function est inutilisable ici : la CSP stricte de l'interface interdit l'évaluation de texte, c'est voulu)


def test_accueil_propose_les_agents_detectes(page):
    quick = page.locator(".quick")
    expect(quick).to_contain_text("Utiliser Claude Code")
    expect(quick).to_contain_text("Utiliser OpenCode")
    quick.get_by_role("button", name="Utiliser Claude Code").click()
    expect(page.locator(".toast")).to_contain_text("Claude Code sélectionné")
    expect(page.locator(".model-btn")).to_contain_text("Claude Code")


# --- Disposition « onglets + barre latérale à sections » ---------------------------------------------------------------

def test_onglets_epinglage_et_projets(page, server):
    page.locator("textarea").fill("Bonjour")
    page.keyboard.press("Enter")
    page.get_by_role("button", name="Autoriser une fois").click()
    tab = page.locator(".ctab.on")
    expect(tab).to_contain_text("Bonjour")  # onglet de la conversation ouverte
    expect(page.locator(".statusbar")).to_contain_text("Moteur prêt")
    # Shift-clic : épinglée, puis visible sous « Épinglées » (et plus dans la liste du projet)
    page.locator(".conv", has_text="Bonjour").first.click(modifiers=["Shift"])
    expect(page.locator(".side-hint", has_text="Shift-clic")).to_have_count(0)
    expect(page.locator(".conv", has_text="Bonjour")).to_have_count(1)
    # nouvelle conversation dans le même dossier : deuxième onglet ; fermer l'actif ramène au premier
    page.get_by_title("Nouvelle conversation dans ce dossier").click()
    expect(page.locator(".ctab")).to_have_count(2)
    page.locator(".ctab.on .ctab-x").click()
    expect(page.locator(".ctab")).to_have_count(1)
    expect(page.locator(".ctab.on")).to_contain_text("Bonjour")
    # onglet Projets : le dossier courant est listé
    page.get_by_role("tab", name="Projets").click()
    expect(page.locator(".side-item.proj.on")).to_contain_text("projet")


# --- 4.0.0 : Connexions en 3 blocs, commandes du CLI, effort ---------------------------------------------------------

def test_connexions_trois_blocs_agents_grises_et_chemin_manuel(page):
    page.get_by_role("button", name="Connexions").first.click()
    dlg = page.locator(".modal", has_text="Agents installés sur cet ordinateur")
    expect(dlg).to_be_visible()
    expect(dlg).to_contain_text("Fournisseurs par clé d'API")
    expect(dlg).to_contain_text("Serveurs locaux compatibles")
    agents = dlg.locator("section[aria-label='Agents installés'] .conn-row")
    expect(agents).to_have_count(14)
    claude = agents.filter(has_text="Claude Code")
    expect(claude).to_contain_text("/faux/claude")
    expect(claude).to_contain_text("1.0.0")  # versions chargées dans un second temps
    kiro = agents.filter(has_text="Kiro CLI")
    expect(kiro).to_have_class("conn-row off ")  # grisé, jamais caché
    expect(kiro).to_contain_text("non installé")
    expect(kiro.get_by_role("button", name="Utiliser")).to_be_disabled()
    expect(dlg.locator("section[aria-label='Serveurs locaux'] .conn-row", has_text="LM Studio")).to_contain_text("http://localhost:1234/v1")
    kiro.get_by_role("button", name="Chemin…").click()
    form = page.locator(".keyform")
    form.locator("input").fill("/n/existe/pas")
    form.get_by_role("button", name="Enregistrer").click()
    expect(form.locator(".err")).to_contain_text("n'existe pas")
    form.get_by_role("button", name="Retour").click()
    dlg.get_by_role("button", name="Détecter à nouveau").click()
    expect(page.locator("section[aria-label='Agents installés'] .conn-row")).to_have_count(14)
    page.locator("section[aria-label='Agents installés'] .conn-row", has_text="OpenCode").get_by_role("button", name="Utiliser").click()
    expect(page.locator(".toast")).to_contain_text("OpenCode sélectionné")
    expect(page.locator(".model-btn")).to_contain_text("OpenCode")


def test_commandes_du_cli_dans_le_desktop(page):
    box = page.locator("textarea")
    box.fill("/doctor")
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    info = page.locator(".modal", has_text="Diagnostic (/doctor)")
    expect(info).to_contain_text("Agent : Claude Code", timeout=20_000)  # /doctor teste aussi le réseau (Poe, OpenRouter)
    expect(info).to_contain_text("Agent : Kiro CLI")
    page.keyboard.press("Escape")
    box.fill("/bypass")
    page.keyboard.press("Escape")
    page.keyboard.press("Enter")
    confirm = page.locator(".modal", has_text="Activer le BYPASS")
    expect(confirm).to_contain_text("sudo reste refusé")
    confirm.get_by_role("button", name="Annuler").click()
    expect(page.locator(".toast")).to_contain_text("Annulé")
    page.keyboard.press("F1")
    help_ = page.locator(".modal", has_text="Aide : raccourcis et commandes")
    for name in ("/doctor", "/detect", "/agent-path", "/fusion", "/limit", "/effort", "/timeline", "/sessions"):
        expect(help_).to_contain_text(name)
    expect(help_).to_contain_text("/agent-path ID [CHEMIN]")  # usage affiché
    page.keyboard.press("Escape")


def test_effort_dans_la_zone_de_saisie_et_reglage_par_defaut(page, server):
    page.locator(".model-btn").click()
    page.get_by_text("m-effort").first.click()
    sel = page.locator(".composer .effort-sel")
    expect(sel).to_be_visible()
    expect(sel.locator("option")).to_have_count(4)
    sel.select_option("profond")
    expect(sel).to_have_value("profond")
    expect(page.locator(".statusbar select")).to_have_value("high")  # même réglage, valeur réelle du modèle
    page.keyboard.press("Control+,")
    st = page.locator(".modal", has_text="Effort par défaut")
    st.get_by_role("button", name="Rapide").click()
    expect(st).to_contain_text("Effort par défaut : Rapide.")
    expect(st.get_by_role("button", name="Rapide")).to_have_class("on")
