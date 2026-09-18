//! 2API：本地 Anthropic/OpenAI 兼容服务，把账号额度暴露给其它编程工具。
//! 路由策略（按模型分流）：
//! - 套餐模型（glm-5.3 / glm-5.3-flash 等）→ 账号 coding endpoint（anthropic 格式）透传，走账号套餐额度；
//! - 官方长期免费模型（4.5-flash / 4.7-flash / 4.6v-flash）→ 标准 OpenAI 兼容端点 paas/v4，
//!   Bearer 鉴权 + 全账号 key 池智能轮询（免费不耗额度但有速率限制，轮询摊平）。
//! Anthropic 入站请求免费模型时做 请求/响应/SSE 双向翻译。

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

use crate::oauth::{BIGMODEL_ANTHROPIC_BASE, ZAI_ANTHROPIC_BASE};
use crate::store::{self, Paths};

const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
const CACHE_TTL: Duration = Duration::from_secs(600);
const POOL_TTL: Duration = Duration::from_secs(300);
/// 站方标注长期免费的模型（docs.z.ai/guides/overview/pricing），走 paas/v4 标准端点
const FREE_MODELS: &[&str] = &["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"];
const ZAI_PAAS_BASE: &str = "https://api.z.ai/api/paas/v4";
const BIGMODEL_PAAS_BASE: &str = "https://open.bigmodel.cn/api/paas/v4";

pub fn is_free_model(m: &str) -> bool {
    let l = m.to_lowercase();
    FREE_MODELS.iter().any(|f| *f == l)
}

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

#[derive(Clone, Debug)]
pub struct PoolKey {
    pub api_key: String,
    pub provider: String,
}

pub struct SharedState {
    pub paths: Paths,
    pub token: Mutex<String>,
    pub account: Mutex<Option<String>>,
    pub models: Mutex<Vec<String>>,
    pub cache: Mutex<HashMap<String, (std::time::Instant, store::ApiKeyInfo)>>,
    /// 2API 每账号累计请求数（跟随/锁定都以解析到的账号 id 计）
    pub usage: Mutex<HashMap<String, u64>>,
    /// 免费模型 key 池（全账号平台 key）缓存
    pub pool: Mutex<Option<(std::time::Instant, Vec<PoolKey>)>>,
    /// 激活账号 id 短缓存（避免每个请求全量解密账号）
    pub active_cache: Mutex<Option<(std::time::Instant, Option<String>)>>,
    /// 轮询游标
    pub rr: AtomicU64,
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
        pool: Mutex::new(None),
        active_cache: Mutex::new(None),
        rr: AtomicU64::new(0),
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub local_ok: bool,
    pub local_ms: u64,
    pub e2e_ok: bool,
    pub e2e_ms: u64,
    pub status: u16,
    pub error: Option<String>,
}

fn upstream_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build()
}

/// 测试专用：带总超时，避免上游挂起时测试一直不返回
fn test_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
}

/// 连通性测试：1) 本地 /v1/models；2) 用免费模型真实走一遍 chat/completions（E2E 验证鉴权与上游转发）。
pub async fn test_service() -> TestResult {
    let (port, token) = {
        let mgr = MANAGER.lock().unwrap();
        match mgr.as_ref() {
            Some(m) => (m.cfg.port, m.state.token.lock().unwrap().clone()),
            None => (0, String::new()),
        }
    };
    if port == 0 {
        return TestResult { ok: false, local_ok: false, local_ms: 0, e2e_ok: false, e2e_ms: 0, status: 0, error: Some("服务未运行".into()) };
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 阶段 1：本地服务
        let t0 = std::time::Instant::now();
        let mut req = test_agent().get(&format!("http://127.0.0.1:{port}/v1/models"));
        if !token.is_empty() {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        let local_ok = req.call().is_ok();
        let local_ms = t0.elapsed().as_millis() as u64;
        if !local_ok {
            return TestResult { ok: false, local_ok: false, local_ms, e2e_ok: false, e2e_ms: 0, status: 0, error: Some("本地服务无响应".into()) };
        }
        // 阶段 2：E2E——免费模型真实转发（不耗套餐额度）
        let t1 = std::time::Instant::now();
        let body = json!({
            "model": "glm-4.5-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 1,
        });
        let resp = test_agent()
            .post(&format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());
        let e2e_ms = t1.elapsed().as_millis() as u64;
        match resp {
            Ok(r) => TestResult { ok: true, local_ok: true, local_ms, e2e_ok: true, e2e_ms, status: r.status(), error: None },
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                let msg = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| format!("HTTP {code}"));
                TestResult { ok: false, local_ok: true, local_ms, e2e_ok: false, e2e_ms, status: code, error: Some(msg) }
            }
            Err(e) => TestResult { ok: false, local_ok: true, local_ms, e2e_ok: false, e2e_ms, status: 0, error: Some(format!("{e}")) },
        }
    })
    .await
    .unwrap_or(TestResult { ok: false, local_ok: false, local_ms: 0, e2e_ok: false, e2e_ms: 0, status: 0, error: Some("内部任务失败".into()) })
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
    // 免费模型：全账号 org key 池 + anthropic coding endpoint 纯透传（实测可用，无需翻译）。
    // 套餐模型：跟随/锁定账号自己的 coding endpoint（start-plan 账号的上游风控错误会如实透传）。
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let model = parsed
        .as_ref()
        .and_then(|v| v.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if !model.is_empty() && is_free_model(&model) {
        let Some(mut v) = parsed else { return err_json(StatusCode::BAD_REQUEST, "请求不是合法 JSON") };
        v["model"] = json!(model.to_lowercase());
        return free_call(&st, v.to_string().into_bytes(), free_url_anthropic, free_auth_anthropic, PumpMode::Raw).await;
    }
    relay_anthropic(&st, &headers, &body, "/v1/messages").await
}

async fn messages_count_tokens(State(st): State<Arc<SharedState>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let model = parsed
        .as_ref()
        .and_then(|v| v.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if !model.is_empty() && is_free_model(&model) {
        // paas/v4 无对应的 count 端点，用文本长度粗略估算（免费模型，仅用于客户端显示）
        let est = estimate_tokens(&parsed.unwrap_or(Value::Null));
        return (StatusCode::OK, axum::Json(json!({"input_tokens": est}))).into_response();
    }
    relay_anthropic(&st, &headers, &body, "/v1/messages/count_tokens").await
}

/// Anthropic 格式纯透传：只替换鉴权，逐字节转发（含 SSE）。
async fn relay_anthropic(st: &Arc<SharedState>, headers: &HeaderMap, body: &[u8], path: &str) -> Response {
    let (api_key, base_url) = match resolve::resolve(st).await {
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
    pump_request(
        url,
        AuthStyle::Anthropic { key: api_key, version },
        body.to_vec(),
        PumpMode::Raw,
    )
    .await
}

async fn chat_completions(State(st): State<Arc<SharedState>>, body: axum::body::Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, &format!("请求不是合法 JSON: {e}")),
    };
    let stream = v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();

    // 免费模型 → paas/v4 标准 OpenAI 端点（格式相同，纯透传 + key 池轮询）
    if is_free_model(&model) {
        let mut b = v.clone();
        b["model"] = json!(model.to_lowercase());
        return free_call(&st, b.to_string().into_bytes(), free_url_paas, free_auth_paas, PumpMode::Raw).await;
    }

    // 套餐模型 → anthropic coding endpoint（账号套餐额度）
    let translated = match openai_map::translate_request(&v) {
        Ok(r) => r,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, &e),
    };
    let (api_key, base_url) = match resolve::resolve(&st).await {
        Ok(x) => x,
        Err(e) => {
            stats().errors.fetch_add(1, Ordering::Relaxed);
            return err_json(StatusCode::BAD_GATEWAY, &e);
        }
    };
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let mode = if stream { PumpMode::OpenAiStream(model) } else { PumpMode::OpenAiJson(model) };
    pump_request(
        url,
        AuthStyle::Anthropic { key: api_key, version: DEFAULT_ANTHROPIC_VERSION.to_string() },
        translated.to_string().into_bytes(),
        mode,
    )
    .await
}

#[derive(Clone)]
enum AuthStyle {
    Anthropic { key: String, version: String },
    Bearer(String),
}

#[derive(Clone)]
enum PumpMode {
    /// 原样转发（anthropic 透传 / 免费模型 OpenAI→paas/v4）
    Raw,
    /// 上游 Anthropic JSON → OpenAI chat.completion JSON（套餐模型非流式）
    OpenAiJson(String),
    /// 上游 Anthropic SSE → OpenAI chunk 流（套餐模型流式）
    OpenAiStream(String),
}

#[derive(Clone, Debug)]
pub struct PoolKey {
    pub api_key: String,
    pub provider: String,
}

impl PoolKey {
    fn paas_base(&self) -> &'static str {
        if self.provider == "zai" { ZAI_PAAS_BASE } else { BIGMODEL_PAAS_BASE }
    }
    fn anthropic_base(&self) -> &'static str {
        if self.provider == "zai" { ZAI_ANTHROPIC_BASE } else { BIGMODEL_ANTHROPIC_BASE }
    }
}

/// 免费模型 key 池：全账号平台 key（本地优先，不足时现场向上游申请），5 分钟缓存。
/// 解密与网络都放进阻塞线程，绝不占用异步运行时。
async fn get_pool(st: &Arc<SharedState>) -> Vec<PoolKey> {
    {
        let pool = st.pool.lock().unwrap();
        if let Some((at, p)) = pool.as_ref() {
            if at.elapsed() < POOL_TTL {
                return p.clone();
            }
        }
    }
    let pairs = tauri::async_runtime::spawn_blocking(move || {
        store::free_key_pool(&Paths::detect(), 6)
    })
    .await
    .unwrap_or_default();
    let pool: Vec<PoolKey> = pairs
        .into_iter()
        .map(|(provider, api_key)| PoolKey { api_key, provider })
        .collect();
    *st.pool.lock().unwrap() = Some((std::time::Instant::now(), pool.clone()));
    pool
}

/// 免费模型统一入口：key 池轮询，401/403/429 自动换下一个 key 重试。
/// url_of / auth_of 决定走 paas/v4（OpenAI 入站）还是 anthropic coding endpoint（anthropic 入站）。
async fn free_call(
    st: &Arc<SharedState>,
    body: Vec<u8>,
    url_of: fn(&PoolKey) -> String,
    auth_of: fn(&PoolKey) -> AuthStyle,
    mode: PumpMode,
) -> Response {
    let pool = get_pool(st).await;
    if pool.is_empty() {
        stats().errors.fetch_add(1, Ordering::Relaxed);
        return err_json(StatusCode::BAD_GATEWAY, "没有可用的平台 API Key：免费模型需要账号的 API Key（已尝试现场申请仍失败，请检查账号登录状态）");
    }
    let n = pool.len();
    let start = st.rr.fetch_add(1, Ordering::Relaxed) as usize;
    let mut last: Option<Response> = None;
    for k in 0..n {
        let pk = &pool[(start + k) % n];
        let resp = pump_request(url_of(pk), auth_of(pk), body.clone(), mode.clone()).await;
        let s = resp.status().as_u16();
        if matches!(s, 401 | 403 | 429) && k + 1 < n {
            last = Some(resp);
            continue;
        }
        return resp;
    }
    last.unwrap_or_else(|| err_json(StatusCode::BAD_GATEWAY, "上游全部失败"))
}

fn free_url_anthropic(pk: &PoolKey) -> String {
    format!("{}{}", pk.anthropic_base().trim_end_matches('/'), "/v1/messages")
}
fn free_auth_anthropic(pk: &PoolKey) -> AuthStyle {
    AuthStyle::Anthropic { key: pk.api_key.clone(), version: DEFAULT_ANTHROPIC_VERSION.to_string() }
}
fn free_url_paas(pk: &PoolKey) -> String {
    format!("{}/chat/completions", pk.paas_base().trim_end_matches('/'))
}
fn free_auth_paas(pk: &PoolKey) -> AuthStyle {
    AuthStyle::Bearer(pk.api_key.clone())
}

async fn pump_request(url: String, auth: AuthStyle, body: Vec<u8>, mode: PumpMode) -> Response {
    let (meta_tx, meta_rx) = tokio::sync::oneshot::channel::<Result<(u16, String), String>>();
    let (body_tx, body_rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    tauri::async_runtime::spawn_blocking(move || {
        let send_meta = |r: Result<(u16, String), String>| {
            let _ = meta_tx.send(r);
        };
        let call = |b: &str| {
            let rb = upstream_agent().post(&url).set("content-type", "application/json");
            let rb = match &auth {
                AuthStyle::Anthropic { key, version } => rb
                    .set("x-api-key", key)
                    .set("anthropic-version", version),
                AuthStyle::Bearer(k) => rb.set("Authorization", &format!("Bearer {k}")),
            };
            rb.send_string(b)
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
                send_openai_error(&text, status, tx);
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

fn upstream_error_message(text: &str, status: u16) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| {
            if text.trim().is_empty() {
                format!("上游返回 {status}")
            } else {
                text.chars().take(300).collect()
            }
        })
}

fn send_openai_error(text: &str, status: u16, tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>) {
    let msg = upstream_error_message(text, status);
    let _ = tx.blocking_send(Ok(json!({"error": {"message": msg, "type": "upstream_error", "code": status}}).to_string().into_bytes()));
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
        let msg = upstream_error_message(&text, status);
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

/// count_tokens 免费模型估算：所有字符串长度 / 3（paas/v4 无对应计数端点）
fn estimate_tokens(v: &Value) -> u64 {
    fn walk(v: &Value, chars: &mut u64) {
        match v {
            Value::String(s) => *chars += s.chars().count() as u64,
            Value::Array(a) => a.iter().for_each(|x| walk(x, chars)),
            Value::Object(o) => o.values().for_each(|x| walk(x, chars)),
            _ => {}
        }
    }
    let mut chars = 0;
    walk(v, &mut chars);
    chars / 3 + 1
}
