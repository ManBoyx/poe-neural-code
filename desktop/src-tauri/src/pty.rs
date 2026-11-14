//! Terminaux : un pseudo-terminal par onglet (pty sous Linux, ConPTY sous Windows 10 1809+ via portable-pty).
//! La sortie est transmise à l'interface par un canal Tauri, en UTF-8 découpé proprement (jamais au milieu d'un caractère).

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::paths;
use crate::shells;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl PtyState {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, mut s) in map.drain() {
                let _ = s.killer.kill();
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// Extrait la partie UTF-8 complète du tampon ; garde en attente un caractère coupé en fin de lecture.
pub fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_owned();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            // Octets invalides (programme qui n'écrit pas en UTF-8) : remplacés par U+FFFD plutôt que bloquer l'affichage.
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

/// Variables injectées par l'AppImage (bibliothèques embarquées) : à retirer pour que les shells lancent les
/// programmes du système avec leurs propres bibliothèques.
const APPIMAGE_VARS: &[&str] = &[
    "APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GDK_PIXBUF_MODULE_FILE",
    "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE", "GSETTINGS_SCHEMA_DIR", "PYTHONHOME", "PYTHONPATH",
    "PERLLIB", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
];

fn base_command(program: &str, args: &[String]) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
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
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Eclipse");
    if let Some(home) = paths::home_dir() {
        cmd.cwd(home);
    }
    cmd
}

fn engine_command(app: &AppHandle) -> Result<CommandBuilder, String> {
    let engine = paths::engine_path(app).ok_or("moteur Eclipse introuvable")?;
    let mut cmd = base_command(&engine.to_string_lossy(), &[]);
    cmd.env("ECLIPSE_ICONS", "nerd"); // police Nerd Font embarquée dans l'application
    cmd.env("ECLIPSE_DESKTOP", "1");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    if let Some(data) = paths::portable_data_dir() {
        cmd.env("PNC_HOME", data);
    }
    Ok(cmd)
}

fn shell_command(id: Option<String>) -> Result<CommandBuilder, String> {
    let list = shells::detect();
    let wanted = id.unwrap_or_else(|| shells::default_id(&list));
    let sh = list.iter().find(|s| s.id == wanted).ok_or(format!("shell inconnu : {wanted}"))?;
    Ok(base_command(&sh.program, &sh.args))
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    kind: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let cmd = match kind.as_str() {
        "eclipse" => engine_command(&app)?,
        "shell" => shell_command(shell)?,
        other => return Err(format!("type d'onglet inconnu : {other}")),
    };
    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.sessions.lock().map_err(|e| e.to_string())?.insert(id, Session { master: pair.master, writer, killer });

    // Lecture de la sortie.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let data_ch = on_event.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && data_ch.send(PtyEvent::Data { data: text }).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = done_tx.send(());
    });

    // Fin du processus : sous Windows, ConPTY ne signale la fin de lecture qu'une fois le pty fermé ; on attend donc
    // un peu la fin de la sortie, puis on ferme le pty pour libérer la lecture.
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        if done_rx.recv_timeout(Duration::from_millis(800)).is_err() {
            if let Ok(mut map) = app.state::<PtyState>().sessions.lock() {
                map.remove(&id);
            }
            let _ = done_rx.recv_timeout(Duration::from_millis(800));
        }
        if let Ok(mut map) = app.state::<PtyState>().sessions.lock() {
            map.remove(&id);
        }
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = map.get_mut(&id).ok_or("session terminée")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = map.get(&id).ok_or("session terminée")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn utf8_split_across_reads() {
        let bytes = "é—x".as_bytes();
        let mut p = bytes[..1].to_vec(); // premier octet de « é » seulement
        assert_eq!(take_utf8(&mut p), "");
        p.extend_from_slice(&bytes[1..3]); // fin de « é » + début du tiret cadratin
        assert_eq!(take_utf8(&mut p), "é");
        p.extend_from_slice(&bytes[3..]);
        assert_eq!(take_utf8(&mut p), "—x");
        assert!(p.is_empty());
    }

    #[test]
    fn real_shell_roundtrip_utf8() {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::{Read, Write};
        let cmd = super::shell_command(None).expect("shell");
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut w = pair.master.take_writer().unwrap();
        w.write_all("echo \"$TERM-élève\"; exit\n".as_bytes()).unwrap();
        let t = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                all.extend_from_slice(&buf[..n]);
            }
            String::from_utf8_lossy(&all).into_owned()
        });
        child.wait().unwrap();
        drop(w);
        drop(pair.master);
        let out = t.join().unwrap();
        assert!(out.contains("xterm-256color-élève"), "sortie : {out}");
    }

    #[test]
    fn appimage_variables_are_removed() {
        std::env::set_var("APPDIR", "/tmp/.mount_test");
        std::env::set_var("LD_LIBRARY_PATH", "/tmp/.mount_test/usr/lib");
        let cmd = super::base_command("sh", &[]);
        assert!(cmd.get_env("LD_LIBRARY_PATH").is_none());
        assert!(cmd.get_env("APPDIR").is_none());
        std::env::remove_var("APPDIR");
        std::env::remove_var("LD_LIBRARY_PATH");
    }

    #[test]
    fn invalid_bytes_do_not_block() {
        let mut p = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut p), "a\u{fffd}b");
    }
}
