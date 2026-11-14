//! Eclipse desktop : fenêtre Tauri qui héberge le moteur Eclipse (Python, empaqueté) et des shells dans des onglets.
//! Aucune télémétrie : la seule connexion sortante est la vérification des mises à jour sur GitHub, désactivable.

mod paths;
mod pty;
mod shells;
mod updates;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};

#[derive(Serialize)]
struct PlatformInfo {
    os: &'static str,
    version: String,
    shells: Vec<shells::Shell>,
    default_shell: String,
    engine: Option<String>,
    portable: bool,
}

#[tauri::command]
fn platform_info(app: AppHandle) -> PlatformInfo {
    let list = shells::detect();
    PlatformInfo {
        os: std::env::consts::OS,
        version: app.package_info().version.to_string(),
        default_shell: shells::default_id(&list),
        shells: list,
        engine: paths::engine_path(&app).map(|p| p.to_string_lossy().to_string()),
        portable: paths::is_portable(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Pending::default())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            platform_info,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            updates::update_check,
            updates::update_install
        ])
        .build(tauri::generate_context!())
        .expect("démarrage de l'application impossible");
    app.run(|handle, event| {
        // Fermeture de la fenêtre : on termine les programmes lancés dans les onglets (pas de processus orphelins).
        if let RunEvent::Exit = event {
            handle.state::<pty::PtyState>().kill_all();
        }
    });
}
