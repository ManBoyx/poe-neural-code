//! Eclipse Desktop : fenêtre Tauri qui affiche l'interface graphique d'Eclipse et démarre son moteur en arrière-plan.
//! Aucune télémétrie : la seule connexion sortante de l'application est la vérification des mises à jour sur GitHub,
//! désactivable. Le moteur, lui, ne contacte que les fournisseurs d'IA que vous connectez.

mod engine;
mod paths;
mod updates;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(engine::Engine::default())
        .manage(updates::Pending::default())
        .setup(|app| {
            engine::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine::engine_info, updates::update_check, updates::update_install])
        .build(tauri::generate_context!())
        .expect("démarrage de l'application impossible");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<engine::Engine>().stop();
        }
    });
}
