//! OpenAI-compatible streaming client, hard-limited to local endpoints.
//!
//! All model traffic goes through Rust (the webview's CSP forbids any
//! network access), and every request URL is checked to be loopback
//! (or, if explicitly enabled, a private-LAN/Tailscale IP). Redirects and
//! system proxies are disabled so a request can never be bounced off-box.

use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

pub fn local_client(timeout: Option<Duration>) -> reqwest::Client {
    let mut b = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5));
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    b.build().expect("http client")
}

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || (o[0] == 100 && (o[1] & 0b1100_0000) == 64) // 100.64/10 (Tailscale)
        }
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00, // ULA fc00::/7
    }
}

/// Returns the validated URL or an error explaining why it was refused.
pub fn check_local_url(raw: &str, allow_lan: bool) -> Result<url::Url> {
    let u = url::Url::parse(raw.trim()).map_err(|e| anyhow!("잘못된 URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        bail!("http/https만 허용됩니다");
    }
    let host = u.host().ok_or_else(|| anyhow!("호스트가 없습니다"))?;
    let ok = match host {
        url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback() || (allow_lan && is_private(&IpAddr::V4(ip))),
        url::Host::Ipv6(ip) => ip.is_loopback() || (allow_lan && is_private(&IpAddr::V6(ip))),
    };
    if !ok {
        bail!(
            "외부 엔드포인트 차단됨: {}. 로컬(127.0.0.1/localhost){}만 허용됩니다",
            u.host_str().unwrap_or("?"),
            if allow_lan { " 또는 사설망/Tailscale IP" } else { "" }
        );
    }
    Ok(u)
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token { text: String },
    Reasoning { text: String },
    ToolCall { name: String },
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<Value>,
    pub finish_reason: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub tokens_per_sec: Option<f64>,
    pub cancelled: bool,
}

pub struct ChatParams {
    pub base_url: String,
    pub allow_lan: bool,
    pub body: Value,
}

pub async fn stream_chat(
    p: ChatParams,
    on_event: Channel<StreamEvent>,
    cancel: Arc<AtomicBool>,
) -> Result<ChatResult> {
    check_local_url(&p.base_url, p.allow_lan)?;
    let mut body = p.body;
    body["stream"] = json!(true);
    body["stream_options"] = json!({ "include_usage": true });

    let resp = local_client(None)
        .post(join(&p.base_url, "chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("로컬 LLM 서버에 연결할 수 없습니다 ({e}). 서버가 실행 중인지 확인하세요."))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        bail!("LLM 서버 오류 {status}: {}", text.chars().take(800).collect::<String>());
    }

    let mut first_token: Option<Instant> = None;
    let mut out = ChatResult::default();
    // tool_calls arrive as index-keyed fragments
    let mut tools: Vec<(String, String, String)> = vec![]; // (id, name, args)
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();

    'outer: while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            out.cancelled = true;
            break;
        }
        let chunk = chunk.map_err(|e| anyhow!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                out.prompt_tokens = u["prompt_tokens"].as_u64();
                out.completion_tokens = u["completion_tokens"].as_u64();
            }
            if let Some(t) = v.get("timings") {
                if let Some(tps) = t["predicted_per_second"].as_f64() {
                    out.tokens_per_sec = Some(tps);
                }
            }
            let Some(choice) = v["choices"].get(0) else { continue };
            if let Some(fr) = choice["finish_reason"].as_str() {
                out.finish_reason = Some(fr.to_string());
            }
            let d = &choice["delta"];
            for key in ["reasoning_content", "reasoning"] {
                if let Some(r) = d[key].as_str().filter(|s| !s.is_empty()) {
                    out.reasoning.push_str(r);
                    let _ = on_event.send(StreamEvent::Reasoning { text: r.into() });
                }
            }
            if let Some(c) = d["content"].as_str().filter(|s| !s.is_empty()) {
                first_token.get_or_insert_with(Instant::now);
                out.content.push_str(c);
                let _ = on_event.send(StreamEvent::Token { text: c.into() });
            }
            if let Some(arr) = d["tool_calls"].as_array() {
                for tc in arr {
                    let idx = tc["index"].as_u64().unwrap_or(tools.len() as u64) as usize;
                    while tools.len() <= idx {
                        tools.push(Default::default());
                    }
                    let slot = &mut tools[idx];
                    if let Some(id) = tc["id"].as_str() {
                        slot.0 = id.into();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        if slot.1.is_empty() {
                            let _ = on_event.send(StreamEvent::ToolCall { name: n.into() });
                        }
                        slot.1.push_str(n);
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        slot.2.push_str(a);
                    }
                }
            }
        }
    }

    out.tool_calls = tools
        .into_iter()
        .filter(|t| !t.1.is_empty())
        .map(|(id, name, args)| {
            let id = if id.is_empty() { format!("call_{}", uuid::Uuid::new_v4().simple()) } else { id };
            json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } })
        })
        .collect();

    if out.tokens_per_sec.is_none() {
        if let (Some(n), Some(ft)) = (out.completion_tokens, first_token) {
            let secs = ft.elapsed().as_secs_f64().max(0.001);
            out.tokens_per_sec = Some(n as f64 / secs);
        }
    }
    Ok(out)
}

pub async fn list_models(base_url: &str, allow_lan: bool) -> Result<Vec<String>> {
    check_local_url(base_url, allow_lan)?;
    let v: Value = local_client(Some(Duration::from_secs(5)))
        .get(join(base_url, "models"))
        .send()
        .await?
        .json()
        .await?;
    Ok(v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default())
}

/// Non-streaming helper (used for titles & summaries).
pub async fn complete(base_url: &str, allow_lan: bool, body: Value) -> Result<String> {
    check_local_url(base_url, allow_lan)?;
    let mut body = body;
    body["stream"] = json!(false);
    let v: Value = local_client(Some(Duration::from_secs(600)))
        .post(join(base_url, "chat/completions"))
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_policy() {
        assert!(check_local_url("http://127.0.0.1:8080/v1", false).is_ok());
        assert!(check_local_url("http://localhost:11434/v1", false).is_ok());
        assert!(check_local_url("http://[::1]:8080/v1", false).is_ok());
        assert!(check_local_url("https://api.openai.com/v1", false).is_err());
        assert!(check_local_url("http://192.168.0.5:8080/v1", false).is_err());
        assert!(check_local_url("http://192.168.0.5:8080/v1", true).is_ok());
        assert!(check_local_url("http://100.101.1.2:8080/v1", true).is_ok());
        assert!(check_local_url("http://8.8.8.8/v1", true).is_err());
        assert!(check_local_url("http://evil.localhost.com/v1", true).is_err());
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn parses_sse_tokens_reasoning_and_tool_calls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = s.read(&mut buf).await;
            let events = [
                r#"{"choices":[{"delta":{"reasoning_content":"think "}}]}"#,
                r#"{"choices":[{"delta":{"content":"안녕"}}]}"#,
                r#"{"choices":[{"delta":{"content":"하세요"}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5},"timings":{"predicted_per_second":42.0}}"#,
            ];
            let mut body = String::new();
            for e in events {
                body.push_str(&format!("data: {e}\n\n"));
            }
            body.push_str("data: [DONE]\n\n");
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).await.unwrap();
            // split writes to exercise line buffering
            let bytes = body.as_bytes();
            for chunk in bytes.chunks(17) {
                s.write_all(chunk).await.unwrap();
            }
        });
        let ch: Channel<StreamEvent> = Channel::new(|_| Ok(()));
        let r = stream_chat(
            ChatParams { base_url: format!("http://127.0.0.1:{port}/v1"), allow_lan: false, body: json!({"messages":[]}) },
            ch,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(r.content, "안녕하세요");
        assert_eq!(r.reasoning, "think ");
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0]["function"]["arguments"], "{\"path\":\"a.txt\"}");
        assert_eq!(r.completion_tokens, Some(5));
        assert_eq!(r.tokens_per_sec, Some(42.0));
        assert_eq!(r.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[tokio::test]
    async fn refuses_remote_endpoint() {
        let ch: Channel<StreamEvent> = Channel::new(|_| Ok(()));
        let e = stream_chat(
            ChatParams { base_url: "https://api.example.com/v1".into(), allow_lan: false, body: json!({}) },
            ch,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
        assert!(e.is_err());
    }
}
