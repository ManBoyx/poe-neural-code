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
    expect(page.locator("body")).to_have_css("background-color", "rgb(251, 250, 248)")


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
    (server["project"] / "gros.txt").write_text("x" * 50_000, encoding="utf-8")
    page.get_by_title("Fichiers du dossier").click()  # rafraîchit la liste des fichiers
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
