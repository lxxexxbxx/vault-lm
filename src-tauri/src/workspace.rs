//! Code-mode tools. Every path is resolved inside the chosen workspace
//! root; `..`, absolute paths and symlinks pointing outside are refused.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const MAX_READ: u64 = 512 * 1024;
const MAX_OUTPUT: usize = 24_000;

fn canonical_root(root: &str) -> Result<PathBuf> {
    let r = PathBuf::from(root);
    if !r.is_dir() {
        bail!("워크스페이스 폴더가 없습니다: {root}");
    }
    Ok(r.canonicalize()?)
}

/// Lexically normalise `rel` under `root`, then verify the nearest existing
/// ancestor canonicalises inside `root` (blocks symlink escapes).
pub fn resolve(root: &str, rel: &str) -> Result<PathBuf> {
    let root = canonical_root(root)?;
    let rel = rel.trim().trim_start_matches("./");
    let mut p = root.clone();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(s) => p.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                if !p.pop() || !p.starts_with(&root) {
                    bail!("워크스페이스 밖 경로는 허용되지 않습니다: {rel}");
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("절대 경로는 허용되지 않습니다. 워크스페이스 기준 상대 경로를 쓰세요: {rel}")
            }
        }
    }
    let mut probe = p.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let canon = probe.canonicalize()?;
    if !canon.starts_with(&root) {
        bail!("워크스페이스 밖을 가리키는 경로입니다: {rel}");
    }
    Ok(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

pub fn list_tree(root: &str, sub: &str, max_depth: usize, limit: usize) -> Result<Vec<Entry>> {
    let base = resolve(root, sub)?;
    let rootp = canonical_root(root)?;
    let mut out = vec![];
    let walker = ignore::WalkBuilder::new(&base)
        .max_depth(Some(max_depth))
        .hidden(false)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !matches!(n.as_ref(), ".git" | "node_modules" | "target" | ".venv" | "__pycache__" | "dist")
        })
        .build();
    for e in walker.flatten() {
        if e.path() == base {
            continue;
        }
        let rel = e.path().strip_prefix(&rootp).unwrap_or(e.path());
        let md = e.metadata().ok();
        out.push(Entry {
            path: rel.to_string_lossy().replace('\\', "/"),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            size: md.map(|m| m.len()).unwrap_or(0),
        });
        if out.len() >= limit {
            break;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn read_file(root: &str, rel: &str, start: Option<usize>, end: Option<usize>) -> Result<String> {
    let p = resolve(root, rel)?;
    let md = std::fs::metadata(&p).map_err(|_| anyhow!("파일이 없습니다: {rel}"))?;
    if md.is_dir() {
        bail!("디렉터리입니다: {rel}");
    }
    if md.len() > MAX_READ && start.is_none() {
        bail!("파일이 너무 큽니다 ({} bytes). start_line/end_line으로 일부만 읽으세요", md.len());
    }
    let bytes = std::fs::read(&p)?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        bail!("바이너리 파일입니다: {rel}");
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if start.is_none() && end.is_none() {
        return Ok(text);
    }
    let s = start.unwrap_or(1).max(1);
    let e = end.unwrap_or(usize::MAX);
    Ok(text
        .lines()
        .enumerate()
        .filter(|(i, _)| *i + 1 >= s && *i + 1 <= e)
        .map(|(i, l)| format!("{:>5}| {l}", i + 1))
        .collect::<Vec<_>>()
        .join("\n"))
}

pub fn write_file(root: &str, rel: &str, content: &str) -> Result<String> {
    let p = resolve(root, rel)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let existed = p.exists();
    std::fs::write(&p, content)?;
    Ok(format!("{} {rel} ({} bytes)", if existed { "updated" } else { "created" }, content.len()))
}

pub fn edit_file(root: &str, rel: &str, old: &str, new: &str) -> Result<String> {
    let p = resolve(root, rel)?;
    let text = std::fs::read_to_string(&p).map_err(|_| anyhow!("파일이 없습니다: {rel}"))?;
    let n = text.matches(old).count();
    match n {
        0 => bail!("old_string을 찾지 못했습니다. read_file로 정확한 내용을 확인하세요"),
        1 => {
            std::fs::write(&p, text.replacen(old, new, 1))?;
            Ok(format!("edited {rel}"))
        }
        _ => bail!("old_string이 {n}곳에서 일치합니다. 주변 줄을 포함해 유일하게 만드세요"),
    }
}

pub fn search(root: &str, pattern: &str, sub: &str, limit: usize) -> Result<String> {
    let re = regex::Regex::new(pattern).or_else(|_| regex::Regex::new(&regex::escape(pattern)))?;
    let base = resolve(root, sub)?;
    let rootp = canonical_root(root)?;
    let mut hits = vec![];
    for e in ignore::WalkBuilder::new(&base).build().flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if e.metadata().map(|m| m.len() > MAX_READ).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let rel = e.path().strip_prefix(&rootp).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                hits.push(format!("{rel}:{}: {}", i + 1, line.chars().take(200).collect::<String>()));
                if hits.len() >= limit {
                    return Ok(hits.join("\n"));
                }
            }
        }
    }
    Ok(if hits.is_empty() { "no matches".into() } else { hits.join("\n") })
}

fn truncate(s: String) -> String {
    if s.len() <= MAX_OUTPUT {
        return s;
    }
    let head: String = s.chars().take(MAX_OUTPUT / 2).collect();
    let tail: String = s.chars().rev().take(MAX_OUTPUT / 2).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n...[truncated]...\n{tail}")
}

pub async fn run_command(root: &str, command: &str, timeout_secs: u64) -> Result<String> {
    let dir = canonical_root(root)?;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-lc", command]);
        c
    };
    cmd.current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn()?;
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| anyhow!("시간 초과 ({timeout_secs}s)"))??;
    let mut s = format!("exit code: {}\n", out.status.code().unwrap_or(-1));
    s.push_str(&String::from_utf8_lossy(&out.stdout));
    if !out.stderr.is_empty() {
        s.push_str("\n[stderr]\n");
        s.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(truncate(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_blocked() {
        let d = std::env::temp_dir().join(format!("vlm-ws-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let r = d.to_string_lossy().to_string();
        assert!(resolve(&r, "a/b.txt").is_ok());
        assert!(resolve(&r, "../x").is_err());
        assert!(resolve(&r, "a/../../x").is_err());
        assert!(resolve(&r, "/etc/passwd").is_err());
        write_file(&r, "a/b.txt", "hello world").unwrap();
        assert_eq!(read_file(&r, "a/b.txt", None, None).unwrap(), "hello world");
        edit_file(&r, "a/b.txt", "world", "vault").unwrap();
        assert_eq!(read_file(&r, "a/b.txt", None, None).unwrap(), "hello vault");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
