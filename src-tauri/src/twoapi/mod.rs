//! 2API：本地 Anthropic/OpenAI 兼容服务，把账号额度暴露给其它编程工具。
//! 路由与鉴权在本文件；账号→(apiKey, baseURL) 解析在 resolve.rs；OpenAI↔Anthropic 翻译在 openai_map.rs。

pub mod openai_map;
pub mod resolve;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::store::{self, Paths};

const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
const CACHE_TTL: Duration = Duration::from_secs(600);
/// 站方标注长期免费的模型，始终并入 /v1/models（docs.z.ai/guides/overview/pricing）
const FREE_MODELS: &[&str] = &["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"];

#[derive(Clone, Debug)]
pub struct Cfg {
    pub port: u16,
    pub token: String,
    /// None = 跟随当前激活账号
    pub account: Option<String>,
    pub models: Vec<String>,
}

impl Cfg {
    fn same_service(&self, other: &Cfg) -> bool {
        // token 热更新即可，不需要重启
        self.port == other.port && self.account == other.account && self.models == other.models
    }
}

#[derive(Default)]
pub struct Stats {
    pub requests: AtomicU64,
    pub errors: AtomicU64,
    pub last_request_at: AtomicI64,
}

fn stats() -> &'static Arc<Stats> {
    static STATS: OnceLock<Arc<Stats>> = OnceLock::new();
    STATS.get_or_init(|| Arc::new(Stats::default()))
}

pub struct SharedState {
    pub paths: Paths,
    pub token: Mutex<String>,
    pub account: Mutex<Option<String>>,
    pub models: Mutex<Vec<String>>,
    pub cache: Mutex<HashMap<String, (std::time::Instant, store::ApiKeyInfo)>>,
    /// 2API 每账号累计请求数（跟随/锁定都以解析到的账号 id 计）
    pub usage: Mutex<HashMap<String, u64>>,
}

pub struct Manager {
    shutdown: Option<tokio::sync::watch::Sender<bool>>,
    cfg: Cfg,
    state: Arc<SharedState>,
}

static MANAGER: Mutex<Option<Manager>> = Mutex::new(None);

pub fn parse_models(s: &str) -> Vec<String> {
    s.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// 按设置同步服务状态（启动 / 关闭 / 配置变化时重启）。命令与 app 启动时都调它。
pub async fn sync(paths: &Paths) -> Result<(), String> {
    let s = store::load_settings(paths);
    let on = s.two_api_on();
    let cfg = Cfg {
        port: s.two_api_port(),
        token: s.two_api_token(),
        account: s.two_api_account(),
        models: parse_models(&s.two_api_models()),
    };
    // 配置未变：只热更新 token；否则停掉旧实例
    {
        let mut mgr = MANAGER.lock().unwrap();
        let same = on && mgr.as_ref().map(|m| m.cfg.same_service(&cfg)).unwrap_or(false);
        if same {
            if let Some(m) = mgr.as_ref() {
                *m.state.token.lock().unwrap() = cfg.token.clone();
            }
            return Ok(());
        }
        if let Some(m) = mgr.take() {
            if let Some(tx) = m.shutdown {
                let _ = tx.send(true);
            }
        }
    }
    if !on {
        return Ok(());
    }
    let state = Arc::new(SharedState {
        paths: Paths::detect(),
        token: Mutex::new(cfg.token.clone()),
        account: Mutex::new(cfg.account.clone()),
        models: Mutex::new(cfg.models.clone()),
        cache: Mutex::new(HashMap::new()),
        usage: Mutex::new(HashMap::new()),
    });
    let app = router(state.clone());
    // 重启同端口时旧监听可能还没完全释放，做一小段重试
    let mut bound = None;
    for _ in 0..20 {
        match tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await {
            Ok(l) => {
                bound = Some(l);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let listener = bound.ok_or_else(|| format!("127.0.0.1:{} 监听失败（端口被占用？）", cfg.port))?;
    let (tx, rx) = tokio::sync::watch::channel(false);
    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            let mut rx = rx;
            let _ = rx.changed().await;
        };
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(shutdown)
            .await;
    });
    *MANAGER.lock().unwrap() = Some(Manager { shutdown: Some(tx), cfg, state });
    Ok(())
}

pub fn update_token(token: &str) {
    let mgr = MANAGER.lock().unwrap();
    if let Some(m) = mgr.as_ref() {
        *m.state.token.lock().unwrap() = token.to_string();
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub requests: u64,
    pub errors: u64,
    pub last_request_at: i64,
    /// 每账号累计请求数（id -> count）
    pub usage: HashMap<String, u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub status: u16,
    pub error: Option<String>,
}

/// 连通性测试：实际请求本机 /v1/models（带令牌），返回延迟与 HTTP 状态。
pub async fn test_service() -> TestResult {
    let (port, token) = {
        let mgr = MANAGER.lock().unwrap();
        match mgr.as_ref() {
            Some(m) => (m.cfg.port, m.state.token.lock().unwrap().clone()),
            None => (0, String::new()),
        }
    };
    if port == 0 {
        return TestResult { ok: false, latency_ms: 0, status: 0, error: Some("服务未运行".into()) };
    }
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let url = format!("http://127.0.0.1:{port}/v1/models");
        let mut req = upstream_agent().get(&url);
        if !token.is_empty() {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        match req.call() {
            Ok(resp) => TestResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                status: resp.status(),
                error: None,
            },
            Err(ureq::Error::Status(code, _)) => TestResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                status: code,
                error: None,
            },
            Err(e) => TestResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                status: 0,
                error: Some(format!("{e}")),
            },
        }
    })
    .await
    .unwrap_or(TestResult { ok: false, latency_ms: 0, status: 0, error: Some("内部任务失败".into()) })
}

pub fn status() -> Status {
    let mgr = MANAGER.lock().unwrap();
    let (running, port, usage) = mgr
        .as_ref()
        .map(|m| (true, m.cfg.port, m.state.usage.lock().unwrap().clone()))
        .unwrap_or((false, 0, HashMap::new()));
    let st = stats();
    Status {
        running,
        port,
        requests: st.requests.load(Ordering::Relaxed),
        errors: st.errors.load(Ordering::Relaxed),
        last_request_at: st.last_request_at.load(Ordering::Relaxed),
        usage,
    }
}

fn router(state: Arc<SharedState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/messages", post(messages))
        .route("/v1/messages/count_tokens", post(messages_count_tokens))
        .route("/v1/chat/completions", post(chat_completions))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

fn err_json(code: StatusCode, message: &str) -> Response {
    (code, axum::Json(json!({"error": {"message": message, "type": "zsw_twoapi_error"}}))).into_response()
}

async fn auth(State(st): State<Arc<SharedState>>, req: Request<Body>, next: Next) -> Response {
    if req.uri().path() != "/health" {
        let token = st.token.lock().unwrap().clone();
        if !token.is_empty() {
            let got = req
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer ").map(String::from))
                .or_else(|| req.headers().get("x-api-key").and_then(|v| v.to_str().ok()).map(String::from))
                .unwrap_or_default();
            if got.trim() != token {
                return err_json(StatusCode::UNAUTHORIZED, "invalid api key");
            }
        }
        let stt = stats();
        stt.requests.fetch_add(1, Ordering::Relaxed);
        stt.last_request_at.store(chrono::Local::now().timestamp(), Ordering::Relaxed);
    }
    next.run(req).await
}

async fn health() -> impl IntoResponse {
    axum::Json(json!({"ok": true}))
}

async fn models(State(st): State<Arc<SharedState>>) -> impl IntoResponse {
    let mut list = st.models.lock().unwrap().clone();
    for m in FREE_MODELS {
        if !list.iter().any(|x| x.eq_ignore_ascii_case(m)) {
            list.push(m.to_string());
        }
    }
    let data: Vec<Value> = list
        .into_iter()
        .map(|m| json!({"id": m, "object": "model", "owned_by": "zcode-switch"}))
        .collect();
    axum::Json(json!({"object": "list", "data": data}))
}

async fn messages(State(st): State<Arc<SharedState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    relay_anthropic(&st, &headers, &body, "/v1/messages").await
}

async fn messages_count_tokens(State(st): State<Arc<SharedState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    relay_anthropic(&st, &headers, &body, "/v1/messages/count_tokens").await
}

/// Anthropic 格式纯透传：只替换鉴权，逐字节转发（含 SSE）。
async fn relay_anthropic(st: &Arc<SharedState>, headers: &HeaderMap, body: &[u8], path: &str) -> Response {
    let (api_key, base_url) = match resolve::resolve(st) {
        Ok(x) => x,
        Err(e) => {
            stats().errors.fetch_add(1, Ordering::Relaxed);
            return err_json(StatusCode::BAD_GATEWAY, &e);
        }
    };
    let version = headers
        .get("anthropic-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(DEFAULT_ANTHROPIC_VERSION)
        .to_string();
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    pump_response(url, api_key, version, body, PumpMode::Raw).await
}

async fn chat_completions(State(st): State<Arc<SharedState>>, body: axum::body::Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, &format!("请求不是合法 JSON: {e}")),
    };
    let stream = v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let translated = match openai_map::translate_request(&v) {
        Ok(r) => r,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, &e),
    };
    let (api_key, base_url) = match resolve::resolve(&st) {
        Ok(x) => x,
        Err(e) => {
            stats().errors.fetch_add(1, Ordering::Relaxed);
            return err_json(StatusCode::BAD_GATEWAY, &e);
        }
    };
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let mode = if stream { PumpMode::OpenAiStream(model.clone()) } else { PumpMode::OpenAiJson(model.clone()) };
    pump_response(url, api_key, DEFAULT_ANTHROPIC_VERSION.to_string(), translated.to_string().as_bytes(), mode).await
}

enum PumpMode {
    /// 原样转发（/v1/messages 透传）
    Raw,
    /// 上游 JSON → OpenAI chat.completion JSON
    OpenAiJson(String),
    /// 上游 Anthropic SSE → OpenAI chunk 流
    OpenAiStream(String),
}

fn upstream_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build()
}

async fn pump_response(url: String, api_key: String, version: String, body: &[u8], mode: PumpMode) -> Response {
    let body = body.to_vec();
    let (meta_tx, meta_rx) = tokio::sync::oneshot::channel::<Result<(u16, String), String>>();
    let (body_tx, body_rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    tauri::async_runtime::spawn_blocking(move || {
        let send_meta = |r: Result<(u16, String), String>| {
            let _ = meta_tx.send(r);
        };
        let call = |body: &str| {
            upstream_agent()
                .post(&url)
                .set("x-api-key", &api_key)
                .set("content-type", "application/json")
                .set("anthropic-version", &version)
                .send_string(body)
        };
        match call(&String::from_utf8_lossy(&body)) {
            Ok(resp) => {
                let status = resp.status();
                let ctype = resp.content_type().to_string();
                send_meta(Ok((status, ctype)));
                pump_ok(resp, mode, &body_tx);
            }
            Err(ureq::Error::Status(_code, resp)) => {
                let status = resp.status();
                let ctype = resp.content_type().to_string();
                send_meta(Ok((status, ctype)));
                pump_ok(resp, mode, &body_tx);
            }
            Err(e) => send_meta(Err(format!("上游请求失败: {e}"))),
        }
    });
    let (status, ctype) = match meta_rx.await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => {
            stats().errors.fetch_add(1, Ordering::Relaxed);
            return err_json(StatusCode::BAD_GATEWAY, &e);
        }
        Err(_) => return err_json(StatusCode::BAD_GATEWAY, "内部管道错误"),
    };
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    match Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, ctype)
        .body(Body::from_stream(stream))
    {
        Ok(r) => r,
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("响应构建失败: {e}")),
    }
}

/// 上游已建立连接后的泵：按 mode 转发/翻译，直到 EOF；客户端断开时 channel 报错自然退出。
fn pump_ok(resp: ureq::Response, mode: PumpMode, tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>) {
    let status = resp.status();
    match mode {
        PumpMode::Raw => pump_raw(resp, tx),
        PumpMode::OpenAiJson(model) => {
            let text = resp.into_string().unwrap_or_default();
            if status >= 400 {
                let msg = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| format!("上游返回 {status}"));
                let _ = tx.blocking_send(Ok(json!({"error": {"message": msg, "type": "upstream_error", "code": status}}).to_string().into_bytes()));
                return;
            }
            match serde_json::from_str::<Value>(&text) {
                Ok(up) => {
                    let out = openai_map::translate_response(&up, &model);
                    let _ = tx.blocking_send(Ok(out.to_string().into_bytes()));
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())));
                }
            }
        }
        PumpMode::OpenAiStream(model) => pump_openai_stream(resp, &model, status, tx),
    }
}

fn pump_raw(resp: ureq::Response, tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>) {
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                    break; // 客户端断开
                }
            }
            Err(e) => {
                let _ = tx.blocking_send(Err(e));
                break;
            }
        }
    }
}

fn pump_openai_stream(resp: ureq::Response, model: &str, status: u16, tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>) {
    if status >= 400 {
        let text = resp.into_string().unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| format!("上游返回 {status}"));
        let _ = tx.blocking_send(Ok(format!("data: {}\n\n", json!({"error": {"message": msg, "type": "upstream_error", "code": status}})).into_bytes()));
        let _ = tx.blocking_send(Ok(b"data: [DONE]\n\n".to_vec()));
        return;
    }
    let reader = std::io::BufReader::new(resp.into_reader());
    let mut tr = openai_map::SseTransformer::new(model);
    for line in reader.lines() {
        match line {
            Ok(l) => {
                let mut out = Vec::new();
                tr.push_line(&l, &mut out);
                if !out.is_empty() && tx.blocking_send(Ok(out)).is_err() {
                    return; // 客户端断开
                }
            }
            Err(e) => {
                let _ = tx.blocking_send(Err(e));
                return;
            }
        }
    }
    let mut out = Vec::new();
    tr.finish(&mut out);
    let _ = tx.blocking_send(Ok(out));
}
