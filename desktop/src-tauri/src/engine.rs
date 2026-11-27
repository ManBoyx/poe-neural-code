//! Moteur Eclipse en arrière-plan : `eclipse-engine serve --watch-stdin`, à l'écoute sur 127.0.0.1 uniquement.
//! Il annonce son port et son jeton sur sa sortie standard ; l'interface les obtient par la commande `engine_info`.
//! Fermer l'application ferme le tuyau d'entrée du moteur, qui s'arrête de lui-même (et il est tué par sécurité).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::fs::OpenOptions;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::paths;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EngineInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Serialize)]
pub struct EngineStatus {
    alive: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct Engine {
    ready: Mutex<Option<Result<EngineInfo, String>>>,
    signal: Condvar,
    child: Mutex<Option<Child>>,
    generation: AtomicU64,
}

impl Engine {
    fn reset(&self) {
        *self.ready.lock().unwrap() = None;
    }

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

    pub fn status(&self) -> EngineStatus {
        let alive = self.child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false);
        let error = match &*self.ready.lock().unwrap() {
            Some(Err(e)) => Some(e.clone()),
            _ => None,
        };
        EngineStatus { alive, error }
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

/// Sortie d'erreur du moteur (traces de plantage avant même ses propres journaux) : logs/engine-stderr.log,
/// rotation simple à 1 Mo (l'ancien fichier devient .1).
fn stderr_log() -> Stdio {
    let dir = paths::logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("engine-stderr.log");
    if std::fs::metadata(&file).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("engine-stderr.log.1"));
    }
    match OpenOptions::new().create(true).append(true).open(&file) {
        Ok(f) => Stdio::from(f),
        Err(_) => Stdio::null(),
    }
}

pub fn start<R: tauri::Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Engine>();
    state.reset();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(exe) = paths::engine_path(app) else {
        state.set(Err("moteur Eclipse introuvable dans l'installation".into()));
        return;
    };
    let mut cmd = Command::new(&exe);
    cmd.args(["serve", "--watch-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr_log())
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
        // Fin de la sortie = moteur arrêté. Si aucune relance n'a eu lieu entre-temps, on le signale à l'interface.
        if engine.generation.load(Ordering::SeqCst) == generation {
            engine.set(Err("le moteur Eclipse s'est arrêté".into()));
        }
    });
}

#[tauri::command]
pub async fn engine_info(app: AppHandle) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Engine>().wait(Duration::from_secs(60)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn engine_status(app: AppHandle) -> EngineStatus {
    app.state::<Engine>().status()
}

/// Relance le moteur sans fermer la fenêtre (nouveau port, nouveau jeton).
#[tauri::command]
pub async fn engine_restart(app: AppHandle) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = app.state::<Engine>();
        engine.stop();
        start(&app);
        engine.wait(Duration::from_secs(60))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_logs(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = paths::logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ces tests modifient des variables d'environnement du processus (ECLIPSE_ENGINE, PNC_HOME) : un verrou commun
    /// les empêche de se marcher dessus quand cargo les lance en parallèle.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn ready_line_is_parsed() {
        let i: EngineInfo = serde_json::from_str(r#"{"event": "ready", "port": 41234, "token": "abc"}"#).unwrap();
        assert_eq!(i.port, 41234);
        assert_eq!(i.token, "abc");
    }

    #[test]
    fn reset_then_failure_is_reported() {
        let e = Engine::default();
        e.set(Ok(EngineInfo { port: 1, token: "t".into() }));
        e.reset();
        assert!(e.wait(Duration::from_millis(20)).is_err());
        e.set(Err("le moteur Eclipse s'est arrêté".into()));
        assert_eq!(e.status().error.as_deref(), Some("le moteur Eclipse s'est arrêté"));
        assert!(!e.status().alive);
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

    /// Cycle réel (sans fenêtre) : faux moteur = script shell qui annonce son port puis attend.
    #[cfg(unix)]
    #[test]
    fn real_process_start_crash_detection_and_restart() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("eclipse-engine-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("faux-moteur.sh");
        std::fs::write(&script, "#!/bin/sh\necho 'trace sur stderr' >&2\necho '{\"event\":\"ready\",\"port\":4321,\"token\":\"t\"}'\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ECLIPSE_ENGINE", &script);
        std::env::set_var("PNC_HOME", dir.join("donnees"));

        let app = tauri::test::mock_builder().manage(Engine::default()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let handle = app.handle().clone();
        start(&handle);
        let engine = handle.state::<Engine>();
        assert_eq!(engine.wait(Duration::from_secs(10)).unwrap().port, 4321);
        assert!(engine.status().alive);

        // plantage : le processus disparaît -> l'état passe en erreur
        if let Some(c) = engine.child.lock().unwrap().as_mut() {
            c.kill().unwrap();
        }
        let t0 = Instant::now();
        while engine.status().error.is_none() && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(engine.status().error.as_deref(), Some("le moteur Eclipse s'est arrêté"));

        // relance : nouveau processus prêt
        engine.stop();
        start(&handle);
        assert_eq!(engine.wait(Duration::from_secs(10)).unwrap().token, "t");
        assert!(engine.status().alive);
        engine.stop();
        let log = std::fs::read_to_string(dir.join("donnees").join("logs").join("engine-stderr.log")).unwrap();
        assert!(log.contains("trace sur stderr"));
        std::env::remove_var("ECLIPSE_ENGINE");
        std::env::remove_var("PNC_HOME");
    }

    /// Version portable : avec portable.txt à côté de l'exécutable, données ET journaux restent dans ./data,
    /// et le moteur reçoit PNC_HOME=./data. Sans le témoin : emplacements habituels.
    #[cfg(unix)]
    #[test]
    fn portable_mode_keeps_data_next_to_executable() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        use std::os::unix::fs::PermissionsExt;
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let marker = exe_dir.join(paths::PORTABLE_MARKER);
        let dir = std::env::temp_dir().join(format!("eclipse-portable-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("faux-moteur.sh");
        std::fs::write(&script, "#!/bin/sh\necho \"PNC_HOME=$PNC_HOME\" >&2\necho '{\"port\":1,\"token\":\"t\"}'\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ECLIPSE_ENGINE", &script);
        std::env::remove_var("PNC_HOME");

        assert!(!paths::is_portable());
        assert_ne!(paths::engine_data_dir(), exe_dir.join("data"));
        std::fs::write(&marker, "portable").unwrap();
        let result = std::panic::catch_unwind(|| {
            assert!(paths::is_portable());
            assert_eq!(paths::engine_data_dir(), exe_dir.join("data"));
            assert_eq!(paths::logs_dir(), exe_dir.join("data").join("logs"));
            let app = tauri::test::mock_builder().manage(Engine::default()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
            let handle = app.handle().clone();
            start(&handle);
            let engine = handle.state::<Engine>();
            engine.wait(Duration::from_secs(10)).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            engine.stop();
            let log = std::fs::read_to_string(exe_dir.join("data").join("logs").join("engine-stderr.log")).unwrap();
            assert!(log.contains(&format!("PNC_HOME={}", exe_dir.join("data").display())), "journal : {log}");
        });
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_dir_all(exe_dir.join("data"));
        std::env::remove_var("ECLIPSE_ENGINE");
        assert!(!paths::is_portable());
        result.unwrap();
    }
}
