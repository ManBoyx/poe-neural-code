//! Emplacements : moteur Eclipse embarqué, mode portable, dossier personnel.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const ENGINE: &str = "eclipse-engine.exe";
#[cfg(not(windows))]
const ENGINE: &str = "eclipse-engine";

/// Fichier témoin du mode portable (version Windows en .zip) : posé à côté de l'exécutable.
pub const PORTABLE_MARKER: &str = "portable.txt";

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

pub fn is_portable() -> bool {
    exe_dir().map(|d| d.join(PORTABLE_MARKER).is_file()).unwrap_or(false)
}

/// En mode portable, les données d'Eclipse restent à côté de l'exécutable (clé USB, dossier quelconque).
pub fn portable_data_dir() -> Option<PathBuf> {
    if is_portable() {
        exe_dir().map(|d| d.join("data"))
    } else {
        None
    }
}

/// Ordre : ECLIPSE_ENGINE (développement) → ressources de l'installation → dossier de l'exécutable (portable)
/// → commande `eclipse` du PATH (installation Python existante).
pub fn engine_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ECLIPSE_ENGINE").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("engine").join(ENGINE));
    }
    if let Some(d) = exe_dir() {
        candidates.push(d.join("engine").join(ENGINE));
    }
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    which::which("eclipse").ok()
}

/// Dossier de données du moteur, même règle que paths.py : PNC_HOME (portable), sinon
/// %APPDATA%\\poe-neural-code (Windows) ou $XDG_DATA_HOME/poe-neural-code (Linux, ~/.local/share par défaut).
pub fn engine_data_dir() -> PathBuf {
    if let Some(d) = portable_data_dir() {
        return d;
    }
    if let Some(d) = std::env::var_os("PNC_HOME") {
        return PathBuf::from(d);
    }
    #[cfg(windows)]
    {
        if let Some(a) = std::env::var_os("APPDATA") {
            return PathBuf::from(a).join("poe-neural-code");
        }
    }
    if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(x).join("poe-neural-code");
    }
    home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".local").join("share").join("poe-neural-code")
}

pub fn logs_dir() -> PathBuf {
    engine_data_dir().join("logs")
}
