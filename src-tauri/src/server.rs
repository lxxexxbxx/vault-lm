//! Manages a local llama-server child process.
//! The server is always bound to 127.0.0.1 — any user-supplied --host is
//! stripped — so the model is never exposed to the network.

use crate::config::ModelProfile;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const LOG_LINES: usize = 600;

#[derive(Default)]
pub struct ServerManager {
    child: Option<Child>,
    profile_id: Option<String>,
    port: u16,
    pub logs: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub profile_id: Option<String>,
    pub port: u16,
    pub ready: bool,
}

/// Minimal shell-like splitter supporting "double" and 'single' quotes.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                has = true;
            }
            (None, c) if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn sanitize(args: Vec<String>) -> Vec<String> {
    // Drop flags that would change binding/exposure or conflict with ours.
    const DROP_WITH_VALUE: &[&str] = &["--host", "--port", "-m", "--model", "-c", "--ctx-size", "--api-key", "--api-key-file"];
    let mut out = vec![];
    let mut it = args.into_iter().peekable();
    while let Some(a) = it.next() {
        let flag = a.split('=').next().unwrap_or("").to_string();
        if DROP_WITH_VALUE.contains(&flag.as_str()) {
            if !a.contains('=') {
                it.next();
            }
            continue;
        }
        out.push(a);
    }
    out
}

impl ServerManager {
    pub fn status(&mut self) -> ServerStatus {
        let running = match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            self.child = None;
        }
        ServerStatus {
            running,
            pid: self.child.as_ref().and_then(|c| c.id()),
            profile_id: if running { self.profile_id.clone() } else { None },
            port: self.port,
            ready: false,
        }
    }

    pub async fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
        self.profile_id = None;
    }

    pub fn kill_blocking(&mut self) {
        if let Some(c) = self.child.as_mut() {
            let _ = c.start_kill();
        }
        self.child = None;
    }

    pub async fn start(&mut self, bin: &str, p: &ModelProfile) -> Result<()> {
        if p.model_path.trim().is_empty() {
            bail!("프로필에 GGUF 모델 경로가 없습니다");
        }
        if !std::path::Path::new(p.model_path.trim()).exists() {
            bail!("모델 파일을 찾을 수 없습니다: {}", p.model_path);
        }
        self.stop().await;

        let bin = if bin.trim().is_empty() { "llama-server" } else { bin.trim() };
        let mut args: Vec<String> = vec![
            "-m".into(),
            p.model_path.trim().into(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            p.port.to_string(),
            "-c".into(),
            p.ctx_size.to_string(),
        ];
        args.extend(sanitize(split_args(&p.extra_args)));

        let mut cmd = Command::new(bin);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("llama-server 실행 실패 ({bin}): {e}. 설정에서 경로를 지정하세요."))?;

        {
            let mut l = self.logs.lock().unwrap();
            l.clear();
            l.push_back(format!("$ {bin} {}", args.join(" ")));
        }
        for pipe in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let logs = self.logs.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut l = logs.lock().unwrap();
                    if l.len() >= LOG_LINES {
                        l.pop_front();
                    }
                    l.push_back(line);
                }
            });
        }
        self.child = Some(child);
        self.profile_id = Some(p.id.clone());
        self.port = p.port;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn args() {
        let a = split_args(r#"-ngl 99 --n-cpu-moe 30 --host 0.0.0.0 -ot "exps=CPU" --port=9"#);
        let s = sanitize(a);
        assert_eq!(s, vec!["-ngl", "99", "--n-cpu-moe", "30", "-ot", "exps=CPU"]);
    }
}
