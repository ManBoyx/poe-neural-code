//! Mises à jour depuis les GitHub Releases du dépôt public de distribution.
//!
//! Chaîne de confiance, dans l'ordre :
//! 1. le manifeste `latest.json` est lu en HTTPS (GitHub) ;
//! 2. le paquet téléchargé doit avoir l'empreinte SHA-256 annoncée dans le manifeste (sinon : refus) ;
//! 3. sa signature minisign doit correspondre à la clé publique intégrée à l'application ET au numéro de version
//!    annoncé (`requireSignedVersion`) — vérifiée par le module officiel de Tauri avant toute installation (sinon : refus).
//! La clé privée n'existe que dans les secrets GitHub Actions : une application compilée sans clé publique refuse
//! toute mise à jour.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::paths;

/// Dépôt public qui ne contient que les binaires, les manifestes et les sommes de contrôle.
pub const RELEASES_REPO: &str = "ManBoyx/eclipse-releases";

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    date: Option<String>,
    notes: String,
    sha256: Option<String>,
    can_install: bool,
    reason: Option<String>,
    page: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum InstallEvent {
    Progress { received: u64, total: Option<u64> },
    Verifying,
    Installing,
    Done,
}

/// `stable` : dernière version publiée (GitHub exclut les préversions de « latest »).
/// `beta` : release permanente `beta-channel`, mise à jour par la CI à chaque version, stable ou bêta.
pub fn endpoint(channel: &str) -> Url {
    let url = match channel {
        "beta" => format!("https://github.com/{RELEASES_REPO}/releases/download/beta-channel/latest.json"),
        _ => format!("https://github.com/{RELEASES_REPO}/releases/latest/download/latest.json"),
    };
    Url::parse(&url).expect("URL de mise à jour valide")
}

fn release_page(version: &str) -> String {
    format!("https://github.com/{RELEASES_REPO}/releases/tag/v{version}")
}

fn pubkey_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

/// Empreinte annoncée pour le fichier téléchargé : entrée du manifeste dont l'URL est celle retenue.
pub fn expected_sha256(raw: &serde_json::Value, url: &str) -> Option<String> {
    raw.get("platforms")?
        .as_object()?
        .values()
        .find(|p| p.get("url").and_then(|u| u.as_str()) == Some(url))
        .and_then(|p| p.get("sha256"))
        .and_then(|s| s.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>, channel: String) -> Result<Option<UpdateInfo>, String> {
    if !pubkey_configured(&app) {
        return Err("mises à jour désactivées : cette version a été compilée sans clé publique de signature".into());
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint(&channel)])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| format!("vérification impossible : {e}"))?;
    let Some(update) = found else {
        *pending.0.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    };
    let sha = expected_sha256(&update.raw_json, update.download_url.as_str());
    let (can_install, reason) = if paths::is_portable() {
        (false, Some("version portable : téléchargez la nouvelle archive depuis la page de la version".to_string()))
    } else if sha.is_none() {
        (false, Some("le manifeste n'annonce pas d'empreinte SHA-256 valide pour ce paquet : installation refusée".to_string()))
    } else {
        (true, None)
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        current: update.current_version.clone(),
        date: update.date.map(|d| d.date().to_string()),
        notes: update.body.clone().unwrap_or_default(),
        sha256: sha,
        can_install,
        reason,
        page: release_page(&update.version),
    };
    *pending.0.lock().map_err(|e| e.to_string())? = Some(update);
    Ok(Some(info))
}

#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, on_event: Channel<InstallEvent>) -> Result<(), String> {
    if paths::is_portable() {
        return Err("version portable : installation automatique impossible".into());
    }
    let update = pending.0.lock().map_err(|e| e.to_string())?.take().ok_or("aucune mise à jour en attente")?;
    let expected = expected_sha256(&update.raw_json, update.download_url.as_str()).ok_or("empreinte SHA-256 absente : refus")?;

    let mut received: u64 = 0;
    let progress = on_event.clone();
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let _ = progress.send(InstallEvent::Progress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("téléchargement impossible : {e}"))?;

    let _ = on_event.send(InstallEvent::Verifying);
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(format!("empreinte SHA-256 différente (attendue {expected}, obtenue {actual}) : mise à jour refusée"));
    }
    // `install` vérifie d'abord la signature minisign (clé publique intégrée + version signée) et refuse en cas d'échec.
    let _ = on_event.send(InstallEvent::Installing);
    update.install(&bytes).map_err(|e| format!("mise à jour refusée : {e}"))?;
    let _ = on_event.send(InstallEvent::Done);
    // Linux : le nouveau paquet est en place, on redémarre. Windows : l'installateur ferme l'application lui-même.
    app.state::<crate::engine::Engine>().stop();
    app.restart();
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha_is_read_from_matching_platform_only() {
        let raw = serde_json::json!({
            "version": "1.0.0",
            "platforms": {
                "linux-x86_64-appimage": {"url": "https://x/a.AppImage", "signature": "s", "sha256": "AB".repeat(32)},
                "linux-x86_64-deb": {"url": "https://x/a.deb", "signature": "s", "sha256": "cd".repeat(32)},
                "windows-x86_64-nsis": {"url": "https://x/a.exe", "signature": "s", "sha256": "trop-court"}
            }
        });
        assert_eq!(expected_sha256(&raw, "https://x/a.AppImage"), Some("ab".repeat(32)));
        assert_eq!(expected_sha256(&raw, "https://x/a.deb"), Some("cd".repeat(32)));
        assert_eq!(expected_sha256(&raw, "https://x/a.exe"), None);
        assert_eq!(expected_sha256(&raw, "https://x/autre"), None);
    }

    #[test]
    fn sha256_known_value() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn channels_point_to_public_release_repo() {
        assert!(endpoint("stable").as_str().ends_with("/releases/latest/download/latest.json"));
        assert!(endpoint("beta").as_str().contains("/releases/download/beta-channel/"));
        assert!(endpoint("autre").as_str().contains("/latest/"));
    }

    /// Chaîne de signature réelle (même code que l'application) avec des clés jetables générées par
    /// `tauri signer` : lancé seulement si ECLIPSE_SIGNTEST pointe vers le dossier préparé (voir packaging/release/README).
    #[test]
    fn signature_chain_with_throwaway_keys() {
        let Ok(dir) = std::env::var("ECLIPSE_SIGNTEST") else { return };
        let dir = std::path::PathBuf::from(dir);
        let read = |n: &str| std::fs::read_to_string(dir.join(n)).unwrap().trim().to_string();
        let pubkey = read("k1.key.pub");
        let bytes = std::fs::read(dir.join("pkg.bin")).unwrap();

        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.package_info_mut().version = "0.2.0".parse().unwrap(); // application installée : 0.2.0
        ctx.config_mut().plugins.0.insert("updater".into(), serde_json::json!({ "pubkey": pubkey, "requireSignedVersion": true }));
        let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(ctx).unwrap();
        let updater = app.handle().updater_builder().target("linux-x86_64").endpoints(vec![endpoint("stable")]).unwrap().build().unwrap();
        let manifest = |version: &str, sig: &str| serde_json::json!({
            "version": version, "notes": "## Nouveautés\n- Relance du moteur\n- Mémoire éditable", "pub_date": "2026-11-16T00:00:00Z",
            "platforms": { "linux-x86_64": { "url": "https://example.invalid/pkg.bin", "signature": sig } }
        });
        let good = updater.restore_update(manifest("0.3.0", &read("pkg.bin.sig"))).unwrap().expect("version plus récente");

        // 0. montée 0.2.0 -> 0.3.0 : proposée, avec le journal des changements
        assert_eq!(good.current_version, "0.2.0");
        assert_eq!(good.version, "0.3.0");
        assert!(good.body.as_deref().unwrap_or("").contains("Mémoire éditable"));
        // même version que l'installée : rien à proposer
        assert!(updater.restore_update(manifest("0.2.0", &read("pkg.bin.sig"))).unwrap().is_none());
        // 1. paquet intact, bonne clé, bonne version : accepté
        assert!(good.verify(&bytes).is_ok());
        // 2. un seul octet modifié : refusé
        let mut tampered = bytes.clone();
        tampered[1000] ^= 0x01;
        assert!(good.verify(&tampered).is_err());
        // 3. signé par une autre clé : refusé
        let other = updater.restore_update(manifest("0.3.0", &read("pkg-other.bin.sig"))).unwrap().unwrap();
        assert!(other.verify(&std::fs::read(dir.join("pkg-other.bin")).unwrap()).is_err());
        // 4. bonne signature mais annoncée pour une autre version (rejeu d'un ancien paquet) : refusé
        let replay = updater.restore_update(manifest("0.3.1", &read("pkg.bin.sig"))).unwrap().unwrap();
        assert!(replay.verify(&bytes).is_err());
    }
}
