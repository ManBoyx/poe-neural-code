//! Moteur Eclipse en arrière-plan : `eclipse-engine serve --watch-stdin`, à l'écoute sur 127.0.0.1 uniquement.
//! Il annonce son port et son jeton sur sa sortie standard ; l'interface les obtient par la commande `engine_info`.
//! Fermer l'application ferme le tuyau d'entrée du moteur, qui s'arrête de lui-même (et il est tué par sécurité).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::paths;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EngineInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Default)]
pub struct Engine {
    ready: Mutex<Option<Result<EngineInfo, String>>>,
    signal: Condvar,
    child: Mutex<Option<Child>>,
}

impl Engine {
    fn set(&self, v: Result<EngineInfo, String>) {
        *self.ready.lock().unwrap() = Some(v);
        self.signal.notify_all();
    }

    pub fn wait(&self, timeout: Duration) -> Result<EngineInfo, String> {
        let start = Instant::now();
        let mut g = self.ready.lock().unwrap();
        while g.is_none() {
            let left = timeout.checked_sub(start.elapsed()).ok_or("le moteur Eclipse n'a pas démarré à temps")?;
            g = self.signal.wait_timeout(g, left).unwrap().0;
        }
        g.clone().unwrap()
    }

    pub fn stop(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            drop(c.stdin.take()); // le moteur voit la fin de son entrée et s'arrête proprement
            std::thread::sleep(Duration::from_millis(300));
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Variables injectées par l'AppImage (bibliothèques embarquées) : retirées pour que les programmes lancés par le moteur
/// (git, claude, node…) utilisent celles du système.
const APPIMAGE_VARS: &[&str] = &[
    "APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE",
    "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "PYTHONHOME", "PYTHONPATH",
    "PERLLIB", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
];

pub fn clean_appimage_env(cmd: &mut Command) {
    if let Ok(appdir) = std::env::var("APPDIR") {
        for v in APPIMAGE_VARS {
            cmd.env_remove(v);
        }
        for v in ["PATH", "XDG_DATA_DIRS"] {
            if let Ok(val) = std::env::var(v) {
                let kept: Vec<&str> = val.split(':').filter(|p| !p.is_empty() && !p.starts_with(&appdir)).collect();
                cmd.env(v, kept.join(":"));
            }
        }
    }
}

pub fn start(app: &AppHandle) {
    let state = app.state::<Engine>();
    let Some(exe) = paths::engine_path(app) else {
        state.set(Err("moteur Eclipse introuvable dans l'installation".into()));
        return;
    };
    let mut cmd = Command::new(&exe);
    cmd.args(["serve", "--watch-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("ECLIPSE_DESKTOP", "1");
    if let Some(home) = paths::home_dir() {
        cmd.current_dir(home);
    }
    if let Some(data) = paths::portable_data_dir() {
        cmd.env("PNC_HOME", data);
    }
    clean_appimage_env(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW : pas de console noire pour le moteur
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            state.set(Err(format!("démarrage du moteur impossible : {e}")));
            return;
        }
    };
    let stdout = child.stdout.take();
    *state.child.lock().unwrap() = Some(child);
    let handle = app.clone();
    std::thread::spawn(move || {
        let engine = handle.state::<Engine>();
        let Some(out) = stdout else {
            engine.set(Err("sortie du moteur indisponible".into()));
            return;
        };
        let mut lines = BufReader::new(out).lines();
        match lines.next() {
            Some(Ok(line)) => match serde_json::from_str::<EngineInfo>(&line) {
                Ok(info) => engine.set(Ok(info)),
                Err(_) => engine.set(Err(format!("réponse inattendue du moteur : {}", line.chars().take(200).collect::<String>()))),
            },
            _ => engine.set(Err("le moteur s'est arrêté au démarrage".into())),
        }
        for _ in lines {} // vide la sortie jusqu'à la fin du moteur
    });
}

#[tauri::command]
pub async fn engine_info(app: AppHandle) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Engine>().wait(Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_is_parsed() {
        let i: EngineInfo = serde_json::from_str(r#"{"event": "ready", "port": 41234, "token": "abc"}"#).unwrap();
        assert_eq!(i.port, 41234);
        assert_eq!(i.token, "abc");
    }

    #[test]
    fn wait_times_out_then_returns_value() {
        let e = Engine::default();
        assert!(e.wait(Duration::from_millis(50)).is_err());
        e.set(Ok(EngineInfo { port: 1, token: "t".into() }));
        assert_eq!(e.wait(Duration::from_millis(50)).unwrap().port, 1);
    }

    #[test]
    fn appimage_variables_are_removed() {
        std::env::set_var("APPDIR", "/tmp/.mount_test");
        std::env::set_var("LD_LIBRARY_PATH", "/tmp/.mount_test/usr/lib");
        let mut cmd = Command::new("sh");
        clean_appimage_env(&mut cmd);
        let removed: Vec<_> = cmd.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().to_string()).collect();
        assert!(removed.contains(&"LD_LIBRARY_PATH".to_string()) && removed.contains(&"APPDIR".to_string()));
        std::env::remove_var("APPDIR");
        std::env::remove_var("LD_LIBRARY_PATH");
    }
}
