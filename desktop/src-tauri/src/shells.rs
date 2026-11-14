//! Shells proposés dans les onglets : détectés au démarrage, propres à chaque système.
//! Linux : $SHELL puis bash, zsh, fish, sh. Windows : PowerShell 7, Windows PowerShell, cmd, WSL, Git Bash.

use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
pub struct Shell {
    pub id: String,
    pub label: String,
    pub icon: String,
    #[serde(skip)]
    pub program: String,
    #[serde(skip)]
    pub args: Vec<String>,
}

fn shell(id: &str, label: &str, icon: &str, program: impl Into<String>, args: &[&str]) -> Shell {
    Shell {
        id: id.into(),
        label: label.into(),
        icon: icon.into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// Force l'UTF-8 dans PowerShell : sans cela, les accents des programmes natifs sont mal décodés.
#[cfg(windows)]
const PS_UTF8: &str = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8";

#[cfg(windows)]
pub fn detect() -> Vec<Shell> {
    let mut out = Vec::new();
    if let Ok(p) = which::which("pwsh.exe") {
        out.push(shell("pwsh", "PowerShell 7", "pwsh", p.to_string_lossy(), &["-NoLogo", "-NoExit", "-Command", PS_UTF8]));
    }
    out.push(shell("powershell", "Windows PowerShell", "powershell", "powershell.exe", &["-NoLogo", "-NoExit", "-Command", PS_UTF8]));
    // chcp 65001 : page de code UTF-8 pour cmd et les programmes qu'il lance.
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    out.push(shell("cmd", "Invite de commandes (cmd)", "cmd", comspec, &["/K", "chcp 65001>nul"]));
    if which::which("wsl.exe").is_ok() {
        out.push(shell("wsl", "WSL (Linux)", "wsl", "wsl.exe", &["--cd", "~"]));
    }
    for base in [std::env::var("ProgramFiles").unwrap_or_default(), std::env::var("LOCALAPPDATA").unwrap_or_default() + "\\Programs"] {
        let bash = Path::new(&base).join("Git").join("bin").join("bash.exe");
        if bash.is_file() {
            out.push(shell("gitbash", "Git Bash", "gitbash", bash.to_string_lossy(), &["--login", "-i"]));
            break;
        }
    }
    out
}

#[cfg(not(windows))]
pub fn detect() -> Vec<Shell> {
    let mut out: Vec<Shell> = Vec::new();
    let mut push = |program: String| {
        let id = Path::new(&program).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if id.is_empty() || out.iter().any(|s| s.id == id) {
            return;
        }
        let icon = match id.as_str() {
            "bash" | "zsh" | "fish" => id.clone(),
            _ => "terminal".into(),
        };
        out.push(shell(&id, &id, &icon, program, &[]));
    };
    if let Ok(s) = std::env::var("SHELL") {
        if Path::new(&s).is_file() {
            push(s);
        }
    }
    for name in ["bash", "zsh", "fish", "sh"] {
        if let Ok(p) = which::which(name) {
            push(p.to_string_lossy().to_string());
        }
    }
    out
}

/// Shell par défaut : celui de l'utilisateur sous Linux, PowerShell 7 sinon Windows PowerShell sous Windows.
pub fn default_id(shells: &[Shell]) -> String {
    shells.first().map(|s| s.id.clone()).unwrap_or_else(|| "sh".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_shell() {
        let s = detect();
        assert!(!s.is_empty());
        assert_eq!(default_id(&s), s[0].id);
        let ids: Vec<_> = s.iter().map(|x| x.id.clone()).collect();
        let mut dedup = ids.clone();
        dedup.dedup();
        assert_eq!(ids.len(), dedup.len());
    }
}
