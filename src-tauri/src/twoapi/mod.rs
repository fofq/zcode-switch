//! 2API：本地 Anthropic/OpenAI 兼容服务，把账号额度暴露给其它编程工具。
//! 两条路刻意分开（不混用凭据）：
//! - 免费模型（4.5-flash / 4.6v-flash / 4.7-flash）→ 全账号平台 key 池轮询；
//!   OpenAI 入站打 paas/v4、Anthropic 入站打 coding endpoint，纯透传（免费不耗额度，有速率限制靠轮询摊平）。
//! - 套餐模型（glm-5.3 系）→ 登录态 JWT（Bearer）打 zcode-plan 端点。
//!   实测套餐额度只挂在 zcode-plan 体系下，平台 key 在 api.z.ai 花不了它（1113 无资源包），
//!   故套餐路由一律 JWT；该端点的阿里云验证码墙（3007）自官方 v3.14.4 起可被服务端
//!   远程关闭（skip_model_request），见下方验证码桥接。
//!   套餐路由是多账号降级链（参考 .temp-zcode-proxy relay.go）：主候选（锁定/跟随账号）
//!   失败后按需拉全账号 JWT 池继续试（≤5 个），按错误分类冷却：
//!   401/403→600s、429（Retry-After 退避后）→30s、402/额度词→1800s、3012 风控与 WAF
//!   （3xx / 2xx 非 JSON 挑战页）→120s、连接失败→60s；全败聚合 503。
//!   冷却过滤对主账号与池候选一视同仁；主候选解析失败也落池继续试；池候选按粘性
//!   排序（最近成功账号优先，见 SharedState.sticky）。
//!   上游请求带官方客户端全套伪装头（quota::zai_billing_headers_with_mid，
//!   每账号配自己的虚拟 device_mid 防 3001 错位，另补 x-api-key/sec-fetch-mode/
//!   accept-language）+ metadata.user_id（恒覆盖，session_id 每账号每日）+ max_tokens
//!   缺省 8192 + 官方 system 回放（sysprompt，3012 风控的关键，取不到块保持现状）。
//!   200 响应先嗅探 ≤4KB 头：错误信封伪装（无 "model":" 有 error/code 线索）按风控
//!   换号，全部候选都异常 200 时回放最后一份（Anthropic 入站原样、OpenAI 入站按协议
//!   翻译成错误，见 replay_abnormal）；响应流全程包 meter::Meter 计量，
//!   usage 落 store_dir()/usage.jsonl（>8MB 轮转），并发一行 flowlog 日志。
//! OpenAI 入站的套餐请求做 请求/响应/SSE 三层翻译（openai_map）：
//!   thinking→reasoning_content、带 signature 的思考块经回放缓存注回工具循环。

pub mod meter;
pub mod openai_map;
pub mod resolve;
pub mod sysprompt;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::oauth::{BIGMODEL_ANTHROPIC_BASE, ZAI_ANTHROPIC_BASE};
use crate::store::{self, ApiKeyInfo, Paths};

const DEFAULT_ANTHROPIC_VERSION: &str = "2023-06-01";
const POOL_TTL: Duration = Duration::from_secs(300);
/// 站方标注长期免费的模型（docs.z.ai/guides/overview/pricing），走 paas/v4 标准端点
const FREE_MODELS: &[&str] = &["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"];
const ZAI_PAAS_BASE: &str = "https://api.z.ai/api/paas/v4";
const BIGMODEL_PAAS_BASE: &str = "https://open.bigmodel.cn/api/paas/v4";

// ===== 套餐路由降级链常量（秒；参考 .temp-zcode-proxy relay.go 的冷却表） =====
const MAX_PLAN_ATTEMPTS: usize = 5;
const COOL_INVALID: u64 = 600; // 401/403：JWT 失效
const COOL_RATE: u64 = 30; // 429 退避重试仍失败
const COOL_EXHAUSTED: u64 = 1800; // 402/额度耗尽
const COOL_RISK: u64 = 120; // 3012 风控 / WAF 挑战
const COOL_NET: u64 = 60; // 连接失败
/// 客户端没带 max_tokens 时的上游缺省（只补缺省不覆盖；参考 zcode-pool external_body）
const PLAN_DEFAULT_MAX_TOKENS: i64 = 8192;
/// 真模型响应在缓冲头里必有的键（JSON 顶层或 message_start 的 "model":"）
const MODEL_KEY: &[u8] = b"\"model\":\"";
/// 200 响应嗅探缓冲上限（字节）：单次 read 裁到剩余配额，head 恰好不超此数
const SNIFF_CAP: usize = 4096;

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

// ===== start-plan 验证码桥接 =====
// 官方 v3.14.4 起验证码墙可由服务端关闭：/api/v1/client/configs 下发
// configs.captcha.skip_model_request=true 时，官方客户端模型请求直接空 header
// 发送、不再跑阿里云无感验证码（当前实测该标记已开启）。我们探测同一端点
// （无需鉴权）对齐：开关开启 = 裸发；关闭/探测失败 = 维持下方旧链路——
// 复用 claim 的验证码窗口预取参数随首次请求带上（先裸打拿 3007 再补参重放
// 会被 WAF 判成异常重放→3012，实测教训），收到 3007 时开窗（无感优先、滑块
// 兜底）重试一次。参数单次有效，同一窗口可能需要反复解。

fn captcha_params() -> &'static Mutex<VecDeque<(String, Option<String>)>> {
    static P: OnceLock<Mutex<VecDeque<(String, Option<String>)>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(VecDeque::new()))
}

static CAPTCHA_APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
/// 窗口去重：记录本次解题开始时间，窗口已被打开且未超时就不再重复拉起
static CAPTCHA_SOLVING: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const CAPTCHA_SOLVE_STALE: Duration = Duration::from_secs(120);
const CAPTCHA_WAIT_TIMEOUT: Duration = Duration::from_secs(75);
/// 解出的验证参数在 45s 内可复用（.temp-zcode-proxy captcha.go 实测值）：
/// 并发等待的请求共享一次解题，被上游拒绝时才作废。
const CAPTCHA_PARAM_TTL: Duration = Duration::from_secs(45);
static CAPTCHA_CACHE: Mutex<Option<(std::time::Instant, String, Option<String>)>> = Mutex::new(None);
/// 求解失败冷却：窗口等了 75s 没拿到参数后 20s 内不再反复等
static CAPTCHA_FAIL_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
const CAPTCHA_FAIL_COOLDOWN: Duration = Duration::from_secs(20);

pub fn set_app_handle(app: tauri::AppHandle) {
    *CAPTCHA_APP.lock().unwrap() = Some(app);
}

/// 验证码窗口提交参数（captcha_submit 命令的 2API 分支）
pub fn submit_captcha_param(param: String, region: Option<String>) {
    *CAPTCHA_CACHE.lock().unwrap() = Some((std::time::Instant::now(), param.clone(), region.clone()));
    captcha_params().lock().unwrap().push_back((param, region));
    captcha_notify().notify_waiters();
}

fn captcha_cache_get() -> Option<(String, Option<String>)> {
    let c = CAPTCHA_CACHE.lock().unwrap();
    if let Some((at, p, r)) = c.as_ref() {
        if at.elapsed() < CAPTCHA_PARAM_TTL {
            return Some((p.clone(), r.clone()));
        }
    }
    None
}

fn captcha_cache_invalidate() {
    *CAPTCHA_CACHE.lock().unwrap() = None;
}

/// 拿一个可用的验证参数：45s 内的缓存直接复用（不弹窗），
/// 过期/被拒后走窗口解题（无感优先、滑块兜底），解出即入缓存。
/// 求解刚失败过（20s 内）直接放弃，避免降级链里每个候选账号都干等 75s。
async fn obtain_captcha_param() -> Option<(String, Option<String>)> {
    if let Some(p) = captcha_cache_get() {
        return Some(p);
    }
    if let Some(t) = CAPTCHA_FAIL_AT.lock().unwrap().as_ref() {
        if t.elapsed() < CAPTCHA_FAIL_COOLDOWN {
            return None;
        }
    }
    let p = wait_captcha_param().await?;
    captcha_cache_store(&p.0, &p.1);
    Some(p)
}

fn captcha_cache_store(param: &str, region: &Option<String>) {
    *CAPTCHA_CACHE.lock().unwrap() = Some((std::time::Instant::now(), param.to_string(), region.clone()));
}

fn captcha_notify() -> &'static tokio::sync::Notify {
    static N: OnceLock<tokio::sync::Notify> = OnceLock::new();
    N.get_or_init(tokio::sync::Notify::new)
}

fn ensure_captcha_window() {
    let mut solving = CAPTCHA_SOLVING.lock().unwrap();
    if let Some(at) = solving.as_ref() {
        if at.elapsed() < CAPTCHA_SOLVE_STALE {
            return; // 已有窗口在解
        }
    }
    let Some(app) = CAPTCHA_APP.lock().unwrap().clone() else { return };
    *solving = Some(std::time::Instant::now());
    drop(solving);
    let _ = crate::open_captcha_window(&app, false);
}

async fn wait_captcha_param() -> Option<(String, Option<String>)> {
    // 无界面环境（CLI 等）没有验证码窗口可开，直接放弃等待
    if CAPTCHA_APP.lock().unwrap().is_none() {
        return None;
    }
    ensure_captcha_window();
    let deadline = std::time::Instant::now() + CAPTCHA_WAIT_TIMEOUT;
    loop {
        if let Some(p) = captcha_params().lock().unwrap().pop_front() {
            return Some(p);
        }
        if std::time::Instant::now() >= deadline {
            // 求解失败：记冷却，降级链里后续候选账号不再逐个干等
            *CAPTCHA_FAIL_AT.lock().unwrap() = Some(std::time::Instant::now());
            return None;
        }
        // 窗口提交/新参数到达都会 notify；超时片段醒来后再查队列与截止时间
        let _ = tokio::time::timeout(Duration::from_secs(3), captcha_notify().notified()).await;
    }
}

fn is_captcha_challenge(text: &str) -> bool {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if v.get("code").and_then(|c| c.as_i64()) == Some(3007) {
            return true;
        }
        let has_kw = |s: &str| {
            let l = s.to_lowercase();
            l.contains("captcha") || l.contains("verify token") || l.contains("verify failed")
                || l.contains("human verification") || l.contains("verifycode")
        };
        if let Some(m) = v.get("msg").and_then(|m| m.as_str()) {
            return has_kw(m);
        }
        if let Some(m) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            return has_kw(m);
        }
        return false;
    }
    let l = text.to_lowercase();
    l.contains("captcha") || l.contains("verify token") || l.contains("verify failed")
        || l.contains("human verification") || l.contains("verifycode")
}

/// 业务码（JSON body 顶层的 code 字段）
fn json_code(text: &str) -> Option<i64> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
}

const EXHAUSTED_KEYWORDS: &[&str] = &[
    "insufficient balance",
    "insufficient funds",
    "no resource package",
    "resource package exhausted",
    "quota exceeded",
    "余额不足",
    "额度已用完",
];

/// 上游错误分类（参考 .temp-zcode-proxy relay.go forwardOnce）。
fn classify_plan_err(status: u16, text: &str) -> PlanFail {
    if status == 0 {
        return PlanFail::NetError;
    }
    if matches!(status, 400 | 401 | 403) && is_captcha_challenge(text) {
        return PlanFail::Captcha;
    }
    if matches!(status, 401 | 403) {
        return PlanFail::Invalid;
    }
    if status == 429 {
        return PlanFail::RateLimited;
    }
    let l = text.to_lowercase();
    if status == 402
        || (matches!(status, 400..=499) && EXHAUSTED_KEYWORDS.iter().any(|k| l.contains(k)))
    {
        return PlanFail::Exhausted;
    }
    if status >= 400
        && (l.contains("unusual activity") || json_code(text) == Some(3012))
    {
        return PlanFail::Risk;
    }
    PlanFail::Other
}

enum PlanFail {
    Captcha,
    Invalid,
    RateLimited,
    Exhausted,
    Risk,
    NetError,
    Other,
}

pub struct SharedState {
    pub paths: Paths,
    pub token: Mutex<String>,
    pub account: Mutex<Option<String>>,
    pub models: Mutex<Vec<String>>,
    /// 套餐路由 JWT 缓存：(时间, info, 账号配对的虚拟 device_mid)
    pub cache: Mutex<HashMap<String, (std::time::Instant, store::ApiKeyInfo, Option<String>)>>,
    /// 2API 每账号累计请求数（跟随/锁定/故障切换都以解析到的账号 id 计）
    pub usage: Mutex<HashMap<String, u64>>,
    /// 免费模型 key 池（全账号平台 key）缓存：(时间, 池, 缓存时长——空池短缓存)
    pub pool: Mutex<Option<(std::time::Instant, Vec<PoolKey>, Duration)>>,
    /// 激活账号 id 短缓存（避免每个请求全量解密账号）
    pub active_cache: Mutex<Option<(std::time::Instant, Option<String>)>>,
    /// 套餐路由账号冷却表：id -> 冷却截止时刻
    pub cooldown: Mutex<HashMap<String, std::time::Instant>>,
    /// 粘性路由：最近成功交付的账号 id；下一请求把它排到池候选最前（主账号未冷却时仍最先）
    pub sticky: Mutex<Option<String>>,
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
        cooldown: Mutex::new(HashMap::new()),
        sticky: Mutex::new(None),
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

/// CLI 测试专用：不看 two_api_on 开关，按当前设置强起服务（供 twoapi-test 命令做无界面 E2E）
pub async fn start_for_test(paths: &Paths, port_override: Option<u16>) -> Result<(), String> {
    let s = store::load_settings(paths);
    let cfg = Cfg {
        port: port_override.unwrap_or_else(|| s.two_api_port()),
        token: s.two_api_token(),
        account: s.two_api_account(),
        models: parse_models(&s.two_api_models()),
    };
    if let Some(m) = MANAGER.lock().unwrap().take() {
        if let Some(tx) = m.shutdown {
            let _ = tx.send(true);
        }
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
        cooldown: Mutex::new(HashMap::new()),
        sticky: Mutex::new(None),
        rr: AtomicU64::new(0),
    });
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port))
        .await
        .map_err(|e| format!("127.0.0.1:{} 监听失败: {e}", cfg.port))?;
    let (tx, rx) = tokio::sync::watch::channel(false);
    tauri::async_runtime::spawn(async move {
        let shutdown = async move {
            let mut rx = rx;
            let _ = rx.changed().await;
        };
        let _ = axum::serve(listener, app).with_graceful_shutdown(shutdown).await;
    });
    *MANAGER.lock().unwrap() = Some(Manager { shutdown: Some(tx), cfg, state });
    Ok(())
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
    // 共享全局 Agent（连接池按 host 复用）；不设总超时：chat 转发是长流式响应，
    // 挂起保护由 connect 超时 + 客户端断连兜底
    crate::http_agent().clone()
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
    // 套餐模型：多账号降级链（主候选=锁定/跟随账号，失败后换下一个有 JWT 的账号）。
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
    let version = headers
        .get("anthropic-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(DEFAULT_ANTHROPIC_VERSION)
        .to_string();
    relay_plan_multi(&st, &version, &body, parsed.as_ref(), "/v1/messages", &PumpMode::Raw).await
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
        let est = estimate_tokens(parsed.as_ref().unwrap_or(&Value::Null));
        return (StatusCode::OK, axum::Json(json!({"input_tokens": est}))).into_response();
    }
    let version = headers
        .get("anthropic-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(DEFAULT_ANTHROPIC_VERSION)
        .to_string();
    relay_plan_multi(&st, &version, &body, parsed.as_ref(), "/v1/messages/count_tokens", &PumpMode::Raw).await
}

// ===== 套餐路由：多账号降级链 =====

struct Candidate {
    id: String,
    /// 展示用账号名（空则回退 id）
    label: String,
    info: ApiKeyInfo,
    /// 账号配对的虚拟 device_mid（上游按 user+mid 侧记，带错会 3001）
    mid: Option<String>,
}

enum AttemptOutcome {
    /// 响应已就绪，直接交付客户端（含按分类如实透传的终端错误）
    Done(Response),
    /// 本账号失败，记原因后换下一个
    Next(String),
}

fn account_label(name: &str, id: &str) -> String {
    if name.trim().is_empty() { id.to_string() } else { name.to_string() }
}

fn cool_down(st: &Arc<SharedState>, id: &str, secs: u64) {
    st.cooldown
        .lock()
        .unwrap()
        .insert(id.to_string(), std::time::Instant::now() + Duration::from_secs(secs));
}

fn cooling_remaining(st: &Arc<SharedState>, id: &str) -> Option<Duration> {
    let map = st.cooldown.lock().unwrap();
    map.get(id)
        .and_then(|until| until.checked_duration_since(std::time::Instant::now()))
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn session_id() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn ctype_ok(ctype: &str) -> bool {
    let l = ctype.to_lowercase();
    l.contains("json") || l.contains("event-stream")
}

/// 每账号每日 session_id：sha256("zsw-sid|账号id|UTC日期") 取前 16 字节，手工置
/// version/variant 位后按 uuid v4 格式化。同账号同日稳定、跨日轮换——上游按 session
/// 侧记风控信誉（参考 zcode-pool gateway.rs::account_session，种子改用 UTC 日期）。
fn account_session_id(acct: &str, day: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"zsw-sid|");
    h.update(acct.as_bytes());
    h.update(b"|");
    h.update(day.as_bytes());
    let d = h.finalize();
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[..16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(b).to_string()
}

/// UTC 日期（yyyy-mm-dd）：session_id 的日轮换种子
fn utc_today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn has_model_key(h: &[u8]) -> bool {
    h.windows(MODEL_KEY.len()).any(|w| w == MODEL_KEY)
}

/// 异常 200 判定：缓冲头里没有 "model":" 但含 "error"/"code" 线索 → 错误信封伪装
/// 成 200（参考 zcode-pool gateway.rs 的 abnormal 嗅探；真模型响应的 message_start /
/// JSON 顶层必带 "model":"）。
fn abnormal_200_head(head: &[u8]) -> bool {
    if has_model_key(head) {
        return false;
    }
    let txt = String::from_utf8_lossy(head);
    txt.contains("\"error\"") || txt.contains("\"code\"")
}

/// 200 响应嗅探：从响应体预读 ≤4KB（拿到 "model":" 或 EOF 即停；单次 read 裁到剩余
/// 配额，head 恰好封顶 4KB），返回（缓冲头, 剩余 reader）。嗅探后缓冲头原样续接剩余
/// 流——正常路径的字节转发不受影响。
fn sniff_200_head(mut reader: Box<dyn std::io::Read + Send>) -> (Vec<u8>, Box<dyn std::io::Read + Send>) {
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    while head.len() < SNIFF_CAP && !has_model_key(&head) {
        let room = SNIFF_CAP - head.len();
        let want = room.min(buf.len());
        match reader.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    (head, reader)
}

/// 从流头文本嗅探上游实际模型名（"model":" 值）；没有返回空串
fn peek_model(head: &str) -> String {
    let Some(i) = head.find("\"model\":\"") else {
        return String::new();
    };
    let rest = &head[i + "\"model\":\"".len()..];
    match rest.find('"') {
        Some(0) | None => String::new(),
        Some(end) => rest[..end].to_string(),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 粘性排序：把最近成功账号（sticky）排到池候选最前，其余保持相对顺序（稳定排序）
fn sticky_first(
    mut pool: Vec<(String, String, ApiKeyInfo, Option<String>)>,
    sticky: Option<&str>,
) -> Vec<(String, String, ApiKeyInfo, Option<String>)> {
    if let Some(sid) = sticky {
        pool.sort_by_key(|(id, ..)| id.as_str() != sid);
    }
    pool
}

/// 全部候选失败：503 + 去重原因聚合（≤300 字符）+ 最近冷却恢复倒计时。
fn final_unavailable(mode: &PumpMode, reasons: &[String], st: &Arc<SharedState>) -> Response {
    let mut uniq: Vec<String> = Vec::new();
    for r in reasons {
        if !uniq.contains(r) {
            uniq.push(r.clone());
        }
    }
    let mut detail = uniq.join("；");
    if detail.chars().count() > 300 {
        detail = detail.chars().take(300).collect::<String>() + "…";
    }
    let mut msg = "所有可用账号均失败（套餐路由），请检查账号登录态与额度".to_string();
    let soonest = st
        .cooldown
        .lock()
        .unwrap()
        .values()
        .filter_map(|t| t.checked_duration_since(std::time::Instant::now()))
        .min();
    if let Some(d) = soonest {
        msg.push_str(&format!("（冷却中，约 {} 秒后自动恢复）", d.as_secs().max(1)));
    }
    if !detail.is_empty() {
        msg.push_str(&format!("｜最近失败: {detail}"));
    }
    let body = match mode {
        PumpMode::Raw => json!({"type": "error", "error": {"type": "no_available_account", "message": msg}}),
        _ => json!({"error": {"message": msg, "type": "no_available_account"}}),
    };
    (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response()
}

/// 套餐路由统一入口（anthropic 入站 Raw / OpenAI 入站翻译模式共用）：多账号降级链。
/// 主候选 = 锁定账号或跟随激活账号（与池候选同受冷却过滤：主账号冷却中就跳过）；
/// 主候选解析失败**不再终止请求**——原因记入聚合后同样落回全账号 JWT 池
/// （store::jwt_pool，纯本地）继续试，最多 MAX_PLAN_ATTEMPTS 个候选。
/// 池候选按粘性排序：最近成功账号（st.sticky）排最前（主账号未冷却时仍最先）。
/// 每次尝试带官方客户端伪装头（quota::zai_billing_headers_with_mid，账号配对 mid），
/// 非 2xx 缓冲分类处置（验证码桥接 / 冷却换号 / 如实透传）；每次尝试都以异常 200 收场
/// （无任何其他失败原因）时把最后一份异常响应回放（Raw 原样 / OpenAI 入站按协议翻译，
/// 见 replay_abnormal）；混合失败不回放，落 503 聚合。
async fn relay_plan_multi(
    st: &Arc<SharedState>,
    anthropic_version: &str,
    body: &[u8],
    body_val: Option<&Value>,
    path: &str,
    mode: &PumpMode,
) -> Response {
    // 官方 system 两块：注册表扫描/读 cjs/解析是重活，一次请求取一次（进程 OnceLock
    // + 磁盘缓存后是快速路径）；拿不到则 rendered_body 保持现状。仅 /v1/messages 需要。
    let sys_blocks: Option<Vec<Value>> = if path.ends_with("/v1/messages") {
        tauri::async_runtime::spawn_blocking(|| {
            sysprompt::official_system_blocks(Some(&Paths::detect().store_dir()))
        })
        .await
        .unwrap_or(None)
    } else {
        None
    };
    // 主候选解析：失败不再直接 502，落回 JWT 池候选继续（原因记入聚合）
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();
    match resolve::resolve_primary(st).await {
        Ok(p) => {
            if cooling_remaining(st, &p.id).is_some() {
                // 冷却过滤同样作用于主账号（pinned/follow）：冷却中就跳过它
                reasons.push(format!("主账号 {} 冷却中，跳过", p.id));
            } else {
                candidates.push(Candidate {
                    label: account_label("", &p.id),
                    id: p.id,
                    info: p.info,
                    mid: p.mid,
                });
            }
        }
        Err(e) => reasons.push(format!("主账号解析失败: {e}")),
    }
    let mut tried: Vec<String> = vec![];
    let mut ablog = AbnormalLog::default();
    let mut pool_loaded = false;
    for _ in 0..MAX_PLAN_ATTEMPTS {
        let cand = loop {
            if let Some(pos) = candidates.iter().position(|c| !tried.contains(&c.id)) {
                break Some(candidates.swap_remove(pos));
            }
            if pool_loaded {
                break None;
            }
            pool_loaded = true;
            // 无主候选可试（解析失败/冷却跳过/已败）：按需拉全账号 JWT 池（排除已试与冷却中）
            let others = tauri::async_runtime::spawn_blocking(move || store::jwt_pool(&Paths::detect()))
                .await
                .map_err(|e| format!("内部任务失败: {e}"))
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or_default();
            // 粘性：最近成功的账号排到池候选最前（主账号未冷却时本就在最前）
            let sticky = st.sticky.lock().unwrap().clone();
            let others = sticky_first(others, sticky.as_deref());
            for (id, name, info, mid) in others {
                if tried.contains(&id) || candidates.iter().any(|c| c.id == id) {
                    continue;
                }
                if cooling_remaining(st, &id).is_some() {
                    continue;
                }
                candidates.push(Candidate { label: account_label(&name, &id), id, info, mid });
            }
        };
        let Some(c) = cand else { break };
        tried.push(c.id.clone());
        {
            let mut u = st.usage.lock().unwrap();
            *u.entry(c.id.clone()).or_insert(0) += 1;
        }
        match plan_attempt(
            st,
            &c,
            anthropic_version,
            body,
            body_val,
            path,
            mode,
            tried.len() as u32,
            sys_blocks.as_deref(),
            &mut ablog,
        )
        .await
        {
            AttemptOutcome::Done(resp) => return resp,
            AttemptOutcome::Next(reason) => reasons.push(format!("{}: {}", c.label, reason)),
        }
    }
    // 回放只在「每次尝试都以异常 200 收场」时触发（count == tried.len()，每个候选至多
    // 记一次异常）；混合失败（有候选死于 401/额度/验证码等）不回放，走下方 503 聚合，
    // 与上方注释及模组头文档的「全部候选异常 200」表述严格一致。
    if ablog.count > 0 && ablog.count as usize == tried.len() {
        if let Some(ab) = ablog.last {
            crate::flowlog::log("twoapi", "abnormal-replay", "全部候选异常 200，回放最后一份异常响应");
            return replay_abnormal(ab, mode).await;
        }
    }
    stats().errors.fetch_add(1, Ordering::Relaxed);
    final_unavailable(mode, &reasons, st)
}

/// 每次尝试的请求体：在「账号视角」渲染（仅 /v1/messages 套餐路由）——
/// - metadata.user_id 恒覆盖官方形状（字符串化 JSON：device_id=该账号 mid，
///   session_id=每账号每日；客户端自带的一律替换，对齐参考实现）；
/// - max_tokens 缺省 8192（只补缺省不覆盖客户端值；OpenAI 入站经
///   openai_map::translate_request 的路径在同一渲染处统一生效）；
/// - 官方 system 回放：sysprompt 取到两块就垫前、调用方原 system 追加在后，
///   取不到（None）保持现状。
/// count_tokens 不做以上任何注入；无 mid 时不注入 metadata。
fn rendered_body(
    body: &[u8],
    body_val: Option<&Value>,
    path: &str,
    mid: Option<&str>,
    acct: &str,
    blocks: Option<&[Value]>,
) -> Vec<u8> {
    let Some(v) = body_val else { return body.to_vec() };
    if !path.ends_with("/v1/messages") {
        return body.to_vec();
    }
    let Some(obj) = v.as_object() else { return body.to_vec() };
    let mut obj = obj.clone();
    obj.entry("max_tokens")
        .or_insert(json!(PLAN_DEFAULT_MAX_TOKENS));
    if let Some(mid) = mid.map(str::trim).filter(|m| !m.is_empty()) {
        let mut meta = obj.get("metadata").and_then(|m| m.as_object()).cloned().unwrap_or_default();
        meta.insert(
            "user_id".to_string(),
            Value::String(
                json!({"device_id": mid, "account_uuid": "", "session_id": account_session_id(acct, &utc_today())})
                    .to_string(),
            ),
        );
        obj.insert("metadata".to_string(), Value::Object(meta));
    }
    let mut out = Value::Object(obj);
    if let Some(blocks) = blocks {
        sysprompt::apply_system(&mut out, blocks);
    }
    out.to_string().into_bytes()
}

/// 验证码参数请求头
fn captcha_headers(param: String, region: Option<String>) -> Vec<(String, String)> {
    let mut v = vec![("X-Aliyun-Captcha-Verify-Param".to_string(), param)];
    if let Some(r) = region.filter(|r| !r.trim().is_empty()) {
        v.push(("X-Aliyun-Captcha-Verify-Region".to_string(), r));
    }
    v
}

/// 带参重试后的非验证码错误：按分类冷却换号，仅 Other 终透传。
/// （实测教训：验证码参数有效也可能撞 3012 风控——那要换号冷却，不是砸回客户端）
fn post_captcha_failure(e: PlanErr, st: &Arc<SharedState>, id: &str, mode: &PumpMode) -> AttemptOutcome {
    match classify_plan_err(e.status, &e.text) {
        PlanFail::Captcha => {
            captcha_cache_invalidate();
            AttemptOutcome::Next("带验证码请求仍被上游拒绝".into())
        }
        PlanFail::Risk => {
            cool_down(st, id, COOL_RISK);
            AttemptOutcome::Next("带验证码仍被风控拦截（unusual activity）".into())
        }
        PlanFail::Invalid => {
            cool_down(st, id, COOL_INVALID);
            AttemptOutcome::Next(format!("鉴权失败 HTTP {}", e.status))
        }
        PlanFail::Exhausted => {
            cool_down(st, id, COOL_EXHAUSTED);
            AttemptOutcome::Next("额度已用完".into())
        }
        PlanFail::RateLimited => {
            cool_down(st, id, COOL_RATE);
            AttemptOutcome::Next("上游限流 429".into())
        }
        PlanFail::NetError => {
            cool_down(st, id, COOL_NET);
            AttemptOutcome::Next(format!("上游请求失败: {}", clip(&e.text, 120)))
        }
        _ => AttemptOutcome::Done(buffered_error_response(e.status, &e.text, mode)),
    }
}

/// 模型请求验证码远程开关：true = 服务端已关闭免费套餐模型请求验证码
/// （configs.captcha.enabled=false 或 skip_model_request=true）。1h 缓存与官方
/// clientConfigSnapshotExpiresAt 一致；探测失败按未关闭处理，保留旧链路。
static MODEL_CAPTCHA_SKIP: Mutex<Option<(std::time::Instant, bool)>> = Mutex::new(None);
const MODEL_CAPTCHA_SKIP_TTL: Duration = Duration::from_secs(3600);

fn fetch_model_captcha_skip() -> bool {
    let url = format!(
        "{}?app_version={}&platform={}",
        crate::claim::CLIENT_CONFIGS_URL,
        crate::quota::zcode_app_version(),
        crate::quota::client_platform(),
    );
    let resp = match upstream_agent().get(&url).timeout(Duration::from_secs(10)).call() {
        Ok(r) => r,
        Err(_) => return false,
    };
    let Ok(text) = resp.into_string() else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return false };
    if v.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return false;
    }
    let cap = match v.pointer("/data/configs/captcha") {
        Some(c) => c,
        None => return false,
    };
    cap.get("skip_model_request").and_then(|x| x.as_bool()).unwrap_or(false)
        || !cap.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true)
}

async fn model_captcha_skipped() -> bool {
    if let Some((at, skip)) = MODEL_CAPTCHA_SKIP.lock().unwrap().as_ref() {
        if at.elapsed() < MODEL_CAPTCHA_SKIP_TTL {
            return *skip;
        }
    }
    let skip = tauri::async_runtime::spawn_blocking(fetch_model_captcha_skip)
        .await
        .ok()
        .unwrap_or(false);
    *MODEL_CAPTCHA_SKIP.lock().unwrap() = Some((std::time::Instant::now(), skip));
    skip
}

/// 异常 200（嗅探判定，见 abnormal_200_head）处置：按风控冷却换号；响应本体记入
/// AbnormalLog（last = 最后一份，供回放；count = 异常次数，供「全部候选异常」判定），
/// 见 replay_abnormal。
fn abnormal_outcome(
    ab: PlanAbnormal,
    st: &Arc<SharedState>,
    id: &str,
    log: &mut AbnormalLog,
) -> AttemptOutcome {
    cool_down(st, id, COOL_RISK);
    log.count += 1;
    log.last = Some(ab);
    AttemptOutcome::Next("HTTP 200 但响应异常（无模型数据，疑似错误信封伪装）".into())
}

/// 单账号一次尝试：验证码墙未关闭时**预取**参数随首次请求带上（官方旧版
/// 同款：无感预解）；已关闭（skip_model_request）则裸发。429 请求内退避
/// 重试一次；参数过期被 3007 拒时作废重解再试一次；其余按分类冷却换号 /
/// 如实透传。异常 200 记入 AbnormalLog 并换号。
#[allow(clippy::too_many_arguments)]
async fn plan_attempt(
    st: &Arc<SharedState>,
    c: &Candidate,
    anthropic_version: &str,
    body: &[u8],
    body_val: Option<&Value>,
    path: &str,
    mode: &PumpMode,
    tries: u32,
    blocks: Option<&[Value]>,
    ablog: &mut AbnormalLog,
) -> AttemptOutcome {
    let url = format!("{}{}", c.info.base_url.trim_end_matches('/'), path);
    // 验证码墙挂在 zcode-plan 端点（start-plan JWT 路线）
    let captcha_wall = c.info.base_url.contains("zcode.z.ai");
    let payload = rendered_body(body, body_val, path, c.mid.as_deref(), &c.id, blocks);
    let model = body_val
        .and_then(|v| v.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let usage = UsageCtx { dir: Some(st.paths.store_dir()), acct: c.id.clone(), model, tries };
    let send = |extra: Vec<(String, String)>| {
        plan_request_once(
            url.clone(),
            c.info.api_key.clone(),
            anthropic_version.to_string(),
            extra,
            payload.clone(),
            mode.clone(),
            c.mid.clone(),
            usage.clone(),
        )
    };
    // 预取验证码参数（45s 缓存命中 = 零弹窗零等待；无界面环境拿不到就裸打）。
    // 服务端已关闭模型请求验证码时跳过预取，直接裸发。
    let mut first_extra: Vec<(String, String)> = Vec::new();
    if captcha_wall && !model_captcha_skipped().await {
        if let Some((param, region)) = obtain_captcha_param().await {
            first_extra = captcha_headers(param, region);
        }
    }
    let err = match send(first_extra.clone()).await {
        PlanSend::Ok(ok) => return finish_plan_ok(ok, st, &c.id),
        PlanSend::Abnormal(ab) => return abnormal_outcome(ab, st, &c.id, ablog),
        PlanSend::Err(e) => e,
    };
    match classify_plan_err(err.status, &err.text) {
        // 429：带同样参数请求内退避重试一次（尊重 Retry-After，封顶 5s），仍 429 才冷却换号
        PlanFail::RateLimited => {
            let wait = err.retry_after.unwrap_or(2).clamp(1, 5);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            match send(first_extra).await {
                PlanSend::Ok(ok) => finish_plan_ok(ok, st, &c.id),
                PlanSend::Abnormal(ab) => abnormal_outcome(ab, st, &c.id, ablog),
                PlanSend::Err(e2) => {
                    cool_down(st, &c.id, COOL_RATE);
                    if let PlanFail::RateLimited = classify_plan_err(e2.status, &e2.text) {
                        AttemptOutcome::Next("上游限流 429".into())
                    } else {
                        post_captcha_failure(e2, st, &c.id, mode)
                    }
                }
            }
        }
        PlanFail::Captcha => {
            if !captcha_wall {
                return AttemptOutcome::Done(buffered_error_response(err.status, &err.text, mode));
            }
            // 预取参数过期/被上游吃掉：作废重解一次再试
            captcha_cache_invalidate();
            let Some((param, region)) = obtain_captcha_param().await else {
                return AttemptOutcome::Next("验证码求解失败或超时".into());
            };
            match send(captcha_headers(param, region)).await {
                PlanSend::Ok(ok) => finish_plan_ok(ok, st, &c.id),
                PlanSend::Abnormal(ab) => abnormal_outcome(ab, st, &c.id, ablog),
                PlanSend::Err(e2) => {
                    if let PlanFail::Captcha = classify_plan_err(e2.status, &e2.text) {
                        // 参数被上游作废：清缓存让下一个请求/账号重新解
                        captcha_cache_invalidate();
                        AttemptOutcome::Next("带验证码请求仍被上游拒绝".into())
                    } else {
                        post_captcha_failure(e2, st, &c.id, mode)
                    }
                }
            }
        }
        PlanFail::Invalid => {
            cool_down(st, &c.id, COOL_INVALID);
            AttemptOutcome::Next(format!("鉴权失败 HTTP {}", err.status))
        }
        PlanFail::Exhausted => {
            cool_down(st, &c.id, COOL_EXHAUSTED);
            AttemptOutcome::Next("额度已用完".into())
        }
        PlanFail::Risk => {
            cool_down(st, &c.id, COOL_RISK);
            AttemptOutcome::Next("上游风控拦截（unusual activity）".into())
        }
        PlanFail::NetError => {
            cool_down(st, &c.id, COOL_NET);
            AttemptOutcome::Next(format!("上游请求失败: {}", clip(&err.text, 120)))
        }
        PlanFail::Other => AttemptOutcome::Done(buffered_error_response(err.status, &err.text, mode)),
    }
}

/// 2xx 响应收尾：WAF 挑战页（非 JSON/SSE）按风控冷却换号，否则交付客户端并记粘性账号。
fn finish_plan_ok(ok: PlanOk, st: &Arc<SharedState>, id: &str) -> AttemptOutcome {
    if (200..300).contains(&ok.status) && !ctype_ok(&ok.ctype) {
        cool_down(st, id, COOL_RISK);
        return AttemptOutcome::Next(format!(
            "上游返回非 JSON 内容（{}，疑似 WAF 挑战页）",
            clip(&ok.ctype, 40)
        ));
    }
    // 成功交付：记粘性账号，下一请求把它排到池候选最前
    *st.sticky.lock().unwrap() = Some(id.to_string());
    AttemptOutcome::Done(ok.resp)
}

struct PlanOk {
    status: u16,
    ctype: String,
    resp: Response,
}

struct PlanErr {
    status: u16,
    text: String,
    retry_after: Option<u64>,
}

/// 异常 200 响应：status/content-type 正常但缓冲头像错误信封（无 "model":" 有
/// error/code 线索）。head + 剩余 reader 保留，全部候选都异常时回放给客户端
/// （Raw 原样 / OpenAI 入站按协议翻译，见 replay_abnormal）。
struct PlanAbnormal {
    status: u16,
    ctype: String,
    head: Vec<u8>,
    reader: Box<dyn std::io::Read + Send>,
}

/// 异常 200 记账：每个候选至多记一次（abnormal_outcome 即返）。count 供「每次尝试都
/// 以异常 200 收场」判定（count == tried.len() 才回放，混合失败落 503 聚合），
/// last 供回放取最后一份。
#[derive(Default)]
struct AbnormalLog {
    count: u32,
    last: Option<PlanAbnormal>,
}

/// plan_request_once 的三种结局：正常响应（含如实透传的终端错误）/ 异常 200 / 失败
enum PlanSend {
    Ok(PlanOk),
    Abnormal(PlanAbnormal),
    Err(PlanErr),
}

/// spawn_blocking 泵线程回传的元信息
enum PlanMeta {
    Ok { status: u16, ctype: String },
    Abnormal { status: u16, ctype: String, head: Vec<u8>, reader: Box<dyn std::io::Read + Send> },
    Err(PlanErr),
}

/// 用量落盘上下文：随请求传进 spawn_blocking 泵线程，泵结束时组装 UsageRecord（见 log_usage）
#[derive(Clone)]
struct UsageCtx {
    dir: Option<std::path::PathBuf>,
    acct: String,
    model: String,
    tries: u32,
}

/// 无 Meter 的简版用量（非 2xx 错误体 / 异常 200 缓冲头）：head 文本直接提码落盘 + flowlog
fn append_head_usage(
    dir: Option<&std::path::Path>,
    acct: &str,
    model: &str,
    status: u16,
    tries: u32,
    stream: bool,
    head: &str,
) {
    let code = meter::head_error_code(head);
    let up = peek_model(head);
    meter::append_usage(
        dir,
        &meter::UsageRecord {
            t: unix_now(),
            acct: acct.to_string(),
            model: model.to_string(),
            up: up.clone(),
            code: code.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            ttfb_ms: 0,
            total_ms: 0,
            bytes: head.len() as u64,
            status,
            tries,
            stream,
        },
    );
    crate::flowlog::log(
        "twoapi",
        "usage",
        &format!("acct={acct} model={model} up={up} http={status} code={code} tries={tries} bytes={}", head.len()),
    );
}

/// 泵结束：Meter 摘要 → 落 usage.jsonl + flowlog 一行（append_usage 任何失败都静默，不影响请求路径）
fn log_usage(ctx: &UsageCtx, s: &meter::MeterSummary) {
    let up = peek_model(&s.head);
    // 错误码先扫 head，提不到再扫 tail（对齐参考实现 peek_code head→tail）：
    // 流末尾才出现的错误事件（SSE 尾部 error / overloaded_error）只落 tail 窗口
    let mut code = meter::head_error_code(&s.head);
    if code.is_empty() {
        code = meter::head_error_code(&s.tail);
    }
    meter::append_usage(
        ctx.dir.as_deref(),
        &meter::UsageRecord {
            t: unix_now(),
            acct: ctx.acct.clone(),
            model: ctx.model.clone(),
            up: up.clone(),
            code: code.clone(),
            input_tokens: s.input_tokens,
            output_tokens: s.output_tokens,
            cache_read: s.cache_read,
            ttfb_ms: s.ttfb_ms,
            total_ms: s.total_ms,
            bytes: s.bytes,
            status: s.status,
            tries: ctx.tries,
            stream: s.stream,
        },
    );
    crate::flowlog::log(
        "twoapi",
        "usage",
        &format!(
            "acct={} model={} up={} in={} out={} cache={} {}ms {}B http={} code={code} tries={}",
            ctx.acct, ctx.model, up, s.input_tokens, s.output_tokens, s.cache_read, s.total_ms, s.bytes, s.status, ctx.tries
        ),
    );
}

/// 全候选都异常：把最后一份异常响应回放给客户端，按入站协议区分（与本文件其他错误
/// 路径的 PumpMode 翻译约定一致）：
/// - Raw（Anthropic 入站）：原样回放（status + content-type + 缓冲头续接剩余流），
///   客户端看到上游真实错误信封；
/// - OpenAI 入站（OpenAiJson/OpenAiStream）：异常体是 Anthropic 形态错误信封且带伪装
///   的 200 状态码，原样回放会让 SDK 把错误当成功体解析（流式则拿到非 SSE 裸 JSON），
///   故读全异常体（缓冲头 + 剩余流）后走 buffered_error_response 包 OpenAI error JSON，
///   状态码如实改 502——上游 200 是伪装，非 200 才能让客户端 SDK 进错误分支。
async fn replay_abnormal(ab: PlanAbnormal, mode: &PumpMode) -> Response {
    if !matches!(mode, PumpMode::Raw) {
        let text = tauri::async_runtime::spawn_blocking(move || {
            let mut buf = Vec::new();
            let mut r = std::io::Cursor::new(ab.head).chain(ab.reader);
            let _ = r.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
        .await
        .unwrap_or_default();
        return buffered_error_response(StatusCode::BAD_GATEWAY.as_u16(), &text, mode);
    }
    let code = StatusCode::from_u16(ab.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader: Box<dyn std::io::Read + Send> = Box::new(std::io::Cursor::new(ab.head).chain(ab.reader));
        pump_reader(reader.as_mut(), &tx);
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, ab.ctype)
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| err_json(StatusCode::INTERNAL_SERVER_ERROR, "响应构建失败"))
}

/// 单次套餐请求：官方客户端全套伪装头（User-Agent/Referer/X-Title/X-Platform/...
/// + Authorization Bearer JWT + 每请求新 x-request-id，出自 quota::zai_billing_headers_with_mid；
/// 另对齐参考实现补 x-api-key（与 Authorization 同值）+ sec-fetch-mode: cors + accept-language: *）
/// + anthropic-version + X-ZCode-Agent；200 且 JSON/SSE 先嗅探 ≤4KB 头（异常 200 不进
/// 客户端管道，按风控换号），正常则缓冲头原样续流进 Meter 计量泵；其余 2xx 直接进
/// Meter 泵；非 2xx 缓冲完整响应体交上层分类处置（错误体都很小），Retry-After 随错误带回。
async fn plan_request_once(
    url: String,
    jwt: String,
    version: String,
    extra_headers: Vec<(String, String)>,
    body: Vec<u8>,
    mode: PumpMode,
    mid: Option<String>,
    usage: UsageCtx,
) -> PlanSend {
    let accept = match &mode {
        PumpMode::OpenAiJson(_) => "application/json",
        _ => "text/event-stream",
    };
    let (meta_tx, meta_rx) = tokio::sync::oneshot::channel::<PlanMeta>();
    let (body_tx, body_rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    tauri::async_runtime::spawn_blocking(move || {
        let base = crate::quota::zai_billing_headers_with_mid(&jwt, mid);
        let rb0 = upstream_agent().post(&url);
        let rb = base.into_iter().fold(rb0, |acc, (k, v)| acc.set(&k, &v));
        let rb = rb
            .set("content-type", "application/json")
            .set("anthropic-version", &version)
            .set("accept", accept)
            .set("x-api-key", &jwt)
            .set("sec-fetch-mode", "cors")
            .set("accept-language", "*")
            .set("X-ZCode-Agent", "glm")
            // 官方 start-plan 聊天请求的归因头（zcode.cjs kLs）——风控按会话信誉打分，
            // 缺这些头时同一请求在 billing 通、在 /v1/messages 吃 3012（实测）
            .set("X-Zcode-Session-Type", "main")
            .set("X-Session-Id", session_id())
            .set("X-Zcode-Trace-Id", &uuid::Uuid::new_v4().to_string())
            .set("X-Query-Id", &uuid::Uuid::new_v4().to_string());
        let rb = extra_headers.iter().fold(rb, |acc, (k, v)| acc.set(k, v));
        // 与 pump_request 相同：body 按 UTF-8 字符串发送（上游均为 JSON）
        let body_str = String::from_utf8_lossy(&body);
        match rb.send_string(&body_str) {
            Ok(resp) => {
                let status = resp.status();
                let ctype = resp.content_type().to_string();
                if status == 200 && ctype_ok(&ctype) {
                    // 先嗅探再原样续流：异常 200（错误信封伪装）不进客户端管道
                    let (head, reader) = sniff_200_head(resp.into_reader());
                    if abnormal_200_head(&head) {
                        let head_str = String::from_utf8_lossy(&head);
                        crate::flowlog::log(
                            "twoapi",
                            "abnormal-200",
                            &format!("acct={} ctype={} head={}", usage.acct, ctype, clip(&head_str, 120)),
                        );
                        append_head_usage(
                            usage.dir.as_deref(),
                            &usage.acct,
                            &usage.model,
                            status,
                            usage.tries,
                            ctype.to_lowercase().contains("event-stream"),
                            &head_str,
                        );
                        let _ = meta_tx.send(PlanMeta::Abnormal { status, ctype, head, reader });
                        return;
                    }
                    let reader: Box<dyn std::io::Read + Send> =
                        Box::new(std::io::Cursor::new(head).chain(reader));
                    let meter = meter::Meter::new(reader, status, ctype.to_lowercase().contains("event-stream"));
                    let _ = meta_tx.send(PlanMeta::Ok { status, ctype });
                    pump_metered(meter, mode, status, &body_tx, &usage);
                    return;
                }
                let stream = ctype.to_lowercase().contains("event-stream");
                let reader: Box<dyn std::io::Read + Send> = resp.into_reader();
                let meter = meter::Meter::new(reader, status, stream);
                let _ = meta_tx.send(PlanMeta::Ok { status, ctype });
                pump_metered(meter, mode, status, &body_tx, &usage);
            }
            Err(ureq::Error::Status(code, resp)) => {
                let retry_after = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
                let text = resp.into_string().unwrap_or_default();
                append_head_usage(usage.dir.as_deref(), &usage.acct, &usage.model, code, usage.tries, false, &text);
                let _ = meta_tx.send(PlanMeta::Err(PlanErr { status: code, text, retry_after }));
            }
            Err(e) => {
                let _ = meta_tx.send(PlanMeta::Err(PlanErr { status: 0, text: format!("上游请求失败: {e}"), retry_after: None }));
            }
        }
    });
    match meta_rx.await {
        Ok(PlanMeta::Ok { status, ctype }) => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
            match Response::builder()
                .status(code)
                .header(header::CONTENT_TYPE, ctype.clone())
                .body(Body::from_stream(stream))
            {
                Ok(resp) => PlanSend::Ok(PlanOk { status, ctype, resp }),
                Err(e) => PlanSend::Err(PlanErr { status: 500, text: format!("响应构建失败: {e}"), retry_after: None }),
            }
        }
        Ok(PlanMeta::Abnormal { status, ctype, head, reader }) => {
            PlanSend::Abnormal(PlanAbnormal { status, ctype, head, reader })
        }
        Ok(PlanMeta::Err(e)) => PlanSend::Err(e),
        Err(_) => PlanSend::Err(PlanErr { status: 0, text: "内部管道错误".into(), retry_after: None }),
    }
}

/// 把缓冲的上游错误按入站协议回传：Raw 原样透传；OpenAI 模式包一层 error JSON
fn buffered_error_response(status: u16, text: &str, mode: &PumpMode) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let body = match mode {
        PumpMode::Raw => text.to_string(),
        _ => json!({
            "error": {"message": upstream_error_message(text, status), "type": "upstream_error", "code": status}
        })
        .to_string(),
    };
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| err_json(StatusCode::INTERNAL_SERVER_ERROR, "响应构建失败"))
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

    // 套餐模型 → 多账号降级链：账号登录态 JWT 走 zcode-plan 端点（套餐额度唯一可消费路径）
    let translated = match openai_map::translate_request(&v) {
        Ok(r) => r,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, &e),
    };
    let mode = if stream { PumpMode::OpenAiStream(model) } else { PumpMode::OpenAiJson(model) };
    let body_bytes = translated.to_string().into_bytes();
    relay_plan_multi(
        &st,
        DEFAULT_ANTHROPIC_VERSION,
        &body_bytes,
        Some(&translated),
        "/v1/messages",
        &mode,
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

/// 免费模型 key 池：全账号平台 key（本地优先，不足时现场向上游申请），5 分钟缓存；
/// 空池只短缓存 20 秒——负缓存太久会让刚修好的原因（如登录态恢复）迟迟不生效。
/// 解密与网络都放进阻塞线程，绝不占用异步运行时。
async fn get_pool(st: &Arc<SharedState>) -> (Vec<PoolKey>, Option<String>) {
    {
        let pool = st.pool.lock().unwrap();
        if let Some((at, p, ttl)) = pool.as_ref() {
            if at.elapsed() < *ttl {
                return (p.clone(), None);
            }
        }
    }
    let (pairs, diag) = tauri::async_runtime::spawn_blocking(move || {
        store::free_key_pool(&Paths::detect(), 6)
    })
    .await
    .unwrap_or((Vec::new(), Some("内部任务失败".into())));
    let mut pool: Vec<PoolKey> = pairs
        .into_iter()
        .map(|(provider, api_key)| PoolKey { api_key, provider })
        .collect();
    // 平台 key 双网关通用（8-key 实测）：api.z.ai 与 open.bigmodel.cn 都进轮询池。
    // api.z.ai 的 TLS/限流是一阵一阵的（tls connection init failed 波次），open.bigmodel.cn
    // 长期稳——传输失败/429 时 free_call 换下一项，自然落到活着的那个网关。
    let flipped: Vec<PoolKey> = pool
        .iter()
        .map(|pk| PoolKey {
            api_key: pk.api_key.clone(),
            provider: if pk.provider == "zai" { "bigmodel".to_string() } else { "zai".to_string() },
        })
        .collect();
    pool.extend(flipped);
    let ttl = if pool.is_empty() { Duration::from_secs(20) } else { POOL_TTL };
    *st.pool.lock().unwrap() = Some((std::time::Instant::now(), pool.clone(), ttl));
    (pool, diag)
}

/// 免费池项的账目标识：provider + key 尾 4 位（usage.jsonl 里区分来源，不落完整 key）
fn free_acct_tag(pk: &PoolKey) -> String {
    let n = pk.api_key.chars().count();
    let tail: String = pk.api_key.chars().skip(n.saturating_sub(4)).collect();
    format!("{}:…{tail}", pk.provider)
}

/// 免费模型统一入口：key 池轮询（双网关池），401/403/429 与传输失败都自动换下一项重试。
/// url_of / auth_of 决定走 paas/v4（OpenAI 入站）还是 anthropic coding endpoint（anthropic 入站）。
async fn free_call(
    st: &Arc<SharedState>,
    body: Vec<u8>,
    url_of: fn(&PoolKey) -> String,
    auth_of: fn(&PoolKey) -> AuthStyle,
    mode: PumpMode,
) -> Response {
    let (pool, mint_diag) = get_pool(st).await;
    if pool.is_empty() {
        stats().errors.fetch_add(1, Ordering::Relaxed);
        let mut msg = "没有可用的平台 API Key：免费模型需要账号的 API Key（已尝试现场申请仍失败，请检查账号登录状态）".to_string();
        if let Some(d) = mint_diag {
            msg.push_str(&format!("｜铸造诊断：{d}"));
        }
        return err_json(StatusCode::BAD_GATEWAY, &msg);
    }
    let model = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_default();
    let n = pool.len();
    let start = st.rr.fetch_add(1, Ordering::Relaxed) as usize;
    let mut last: Option<Response> = None;
    let mut last_net_err: Option<String> = None;
    for k in 0..n {
        let pk = &pool[(start + k) % n];
        let usage = UsageCtx {
            dir: Some(st.paths.store_dir()),
            acct: free_acct_tag(pk),
            model: model.clone(),
            tries: (k + 1) as u32,
        };
        match pump_request(url_of(pk), auth_of(pk), body.clone(), mode.clone(), usage).await {
            Ok(resp) => {
                let s = resp.status().as_u16();
                if matches!(s, 401 | 403 | 429) && k + 1 < n {
                    last = Some(resp);
                    continue;
                }
                return resp;
            }
            // 传输失败（TLS 断连/超时）：换下一个池项——双网关池自然切到活着的网关
            Err(e) => {
                last_net_err = Some(e);
                continue;
            }
        }
    }
    if let Some(resp) = last {
        return resp;
    }
    stats().errors.fetch_add(1, Ordering::Relaxed);
    err_json(
        StatusCode::BAD_GATEWAY,
        &format!(
            "免费池全部失败（api.z.ai 与 open.bigmodel.cn 均不可达）｜最后错误: {}",
            last_net_err.unwrap_or_else(|| "未知".into())
        ),
    )
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

/// 单次免费池请求：Ok = 上游已给出 HTTP 响应（含 4xx/5xx，交上层按状态轮询/透传）；
/// Err = 传输层失败（TLS/超时/断连），调用方换下一个池项。响应体包 Meter 计量落盘。
async fn pump_request(
    url: String,
    auth: AuthStyle,
    body: Vec<u8>,
    mode: PumpMode,
    usage: UsageCtx,
) -> Result<Response, String> {
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
                pump_ok(resp, mode, &body_tx, usage);
            }
            Err(ureq::Error::Status(_code, resp)) => {
                let status = resp.status();
                let ctype = resp.content_type().to_string();
                send_meta(Ok((status, ctype)));
                pump_ok(resp, mode, &body_tx, usage);
            }
            Err(e) => send_meta(Err(format!("上游请求失败: {e}"))),
        }
    });
    let (status, ctype) = match meta_rx.await {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("内部管道错误".into()),
    };
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    let stream = tokio_stream::wrappers::ReceiverStream::new(body_rx);
    match Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, ctype)
        .body(Body::from_stream(stream))
    {
        Ok(r) => Ok(r),
        Err(e) => Err(format!("响应构建失败: {e}")),
    }
}

/// 上游已建立连接后的泵（免费路由）：包 Meter 计量后按 mode 转发/翻译，直到 EOF；
/// 客户端断开时 channel 报错自然退出；泵结束落一条用量（见 log_usage）。
fn pump_ok(
    resp: ureq::Response,
    mode: PumpMode,
    tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
    usage: UsageCtx,
) {
    let status = resp.status();
    let ctype = resp.content_type().to_string();
    let stream = ctype.to_lowercase().contains("event-stream");
    let reader: Box<dyn std::io::Read + Send> = resp.into_reader();
    let meter = meter::Meter::new(reader, status, stream);
    pump_metered(meter, mode, status, tx, &usage);
}

/// 计量泵：Meter 包装的上游 reader 按 mode 转发/翻译，结束时 finish() 产摘要落盘。
/// 只在 spawn_blocking 线程内使用（Meter 是阻塞 IO）。
fn pump_metered(
    mut meter: meter::Meter<Box<dyn std::io::Read + Send>>,
    mode: PumpMode,
    status: u16,
    tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
    usage: &UsageCtx,
) {
    match mode {
        PumpMode::Raw => pump_reader(&mut meter, tx),
        PumpMode::OpenAiJson(model) => {
            let mut text = String::new();
            if meter.read_to_string(&mut text).is_err() {
                text.clear();
            }
            if status >= 400 {
                send_openai_error(&text, status, tx);
            } else {
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
        }
        PumpMode::OpenAiStream(model) => {
            if status >= 400 {
                let mut text = String::new();
                let _ = meter.read_to_string(&mut text);
                let msg = upstream_error_message(&text, status);
                let _ = tx.blocking_send(Ok(format!("data: {}\n\n", json!({"error": {"message": msg, "type": "upstream_error", "code": status}})).into_bytes()));
                let _ = tx.blocking_send(Ok(b"data: [DONE]\n\n".to_vec()));
            } else {
                pump_openai_stream(&mut meter, &model, tx);
            }
        }
    }
    let s = meter.finish();
    log_usage(usage, &s);
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

/// 逐字节泵：把任意 reader 读到 EOF 转发进管道（Raw 透传 / 异常响应回放共用）；
/// 客户端断开时 blocking_send 报错自然退出。
fn pump_reader(reader: &mut dyn std::io::Read, tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>) {
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

/// OpenAI 入站的 SSE → chunk 翻译泵（reader 已包 Meter）：逐行喂 SseTransformer，
/// 结束时把带签名的思考块存入回放缓存（error 流不存）。
fn pump_openai_stream(
    reader: &mut dyn std::io::Read,
    model: &str,
    tx: &tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
) {
    let mut br = std::io::BufReader::new(reader);
    let mut tr = openai_map::SseTransformer::new(model);
    for line in br.lines() {
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
    // 成功完成的流：把带签名的思考块存入回放缓存，供 OpenAI 客户端下一轮工具循环注回
    if !tr.error_seen() {
        if let Some((text, calls, blocks)) = tr.replay_parts() {
            openai_map::store_replay_parts(&text, &calls, blocks);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_status_and_keywords() {
        assert!(matches!(classify_plan_err(400, "{\"code\":3007}"), PlanFail::Captcha));
        assert!(matches!(classify_plan_err(403, "human verification required"), PlanFail::Captcha));
        assert!(matches!(classify_plan_err(401, "{\"error\":\"bad token\"}"), PlanFail::Invalid));
        assert!(matches!(classify_plan_err(429, "rate limited"), PlanFail::RateLimited));
        assert!(matches!(classify_plan_err(402, "{\"msg\":\"insufficient balance\"}"), PlanFail::Exhausted));
        assert!(matches!(classify_plan_err(400, "{\"msg\":\"余额不足\"}"), PlanFail::Exhausted));
        assert!(matches!(classify_plan_err(400, "unusual activity detected"), PlanFail::Risk));
        assert!(matches!(classify_plan_err(500, "{\"code\":3012,\"msg\":\"x\"}"), PlanFail::Risk));
        assert!(matches!(classify_plan_err(0, "conn reset"), PlanFail::NetError));
        assert!(matches!(classify_plan_err(500, "internal error"), PlanFail::Other));
        // 403 先判 captcha 再判 invalid：带 captcha 文案走重解，不带走失效
        assert!(matches!(classify_plan_err(403, "{\"msg\":\"verifycode error\"}"), PlanFail::Captcha));
    }

    #[test]
    fn rendered_body_injects_official_user_id() {
        let body = json!({"model": "glm-5.3", "max_tokens": 100, "messages": []});
        let out = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages", Some("MID1"), "acct1", None);
        let v: Value = serde_json::from_slice(&out).unwrap();
        let uid = v["metadata"]["user_id"].as_str().unwrap();
        assert!(uid.contains("\"device_id\":\"MID1\""), "{uid}");
        assert!(uid.contains("\"account_uuid\":\"\""));
        assert!(uid.contains("\"session_id\":\""));
        // 客户端自带 user_id 也恒覆盖（对齐参考实现，不再尊重原值）
        let owned = json!({"metadata": {"user_id": "mine"}});
        let out2 = rendered_body(owned.to_string().as_bytes(), Some(&owned), "/v1/messages", Some("MID1"), "acct1", None);
        let v2: Value = serde_json::from_slice(&out2).unwrap();
        let uid2 = v2["metadata"]["user_id"].as_str().unwrap();
        assert_ne!(uid2, "mine");
        assert!(uid2.contains("\"device_id\":\"MID1\""), "{uid2}");
        // 无 mid：不注入 metadata（其余改写照常——本例 max_tokens 已带、无 system，字节不变）
        let out3 = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages", None, "acct1", None);
        assert_eq!(out3, body.to_string().into_bytes());
        // count_tokens：不注入
        let out4 = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages/count_tokens", Some("MID1"), "acct1", None);
        let v4: Value = serde_json::from_slice(&out4).unwrap();
        assert!(v4.get("metadata").is_none());
    }

    #[test]
    fn rendered_body_max_tokens_default() {
        // 没带 max_tokens：补缺省 8192
        let body = json!({"model": "glm-5.3", "messages": []});
        let out = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages", Some("MID1"), "acct1", None);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["max_tokens"].as_i64(), Some(8192));
        // 客户端已带：只补缺省不覆盖（无 mid 时也不注入 metadata）
        let own = json!({"model": "glm-5.3", "max_tokens": 64, "messages": []});
        let out2 = rendered_body(own.to_string().as_bytes(), Some(&own), "/v1/messages", None, "acct1", None);
        let v2: Value = serde_json::from_slice(&out2).unwrap();
        assert_eq!(v2["max_tokens"].as_i64(), Some(64));
        assert!(v2.get("metadata").is_none());
    }

    #[test]
    fn rendered_body_applies_official_system() {
        let blocks = vec![
            json!({"type": "text", "text": "OFFICIAL0"}),
            json!({"type": "text", "text": "OFFICIAL1"}),
        ];
        let body = json!({"model": "glm-5.3", "messages": [], "system": "caller system"});
        // 取到块：官方两块垫前，调用方原 system 追加在后
        let out = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages", Some("MID1"), "acct1", Some(&blocks));
        let v: Value = serde_json::from_slice(&out).unwrap();
        let sys = v["system"].as_array().unwrap();
        assert_eq!(sys.len(), 3);
        assert_eq!(sys[0]["text"], "OFFICIAL0");
        assert_eq!(sys[1]["text"], "OFFICIAL1");
        assert_eq!(sys[2]["text"], "caller system");
        // 取不到块（None）：system 保持现状
        let out2 = rendered_body(body.to_string().as_bytes(), Some(&body), "/v1/messages", Some("MID1"), "acct1", None);
        let v2: Value = serde_json::from_slice(&out2).unwrap();
        assert_eq!(v2["system"], "caller system");
    }

    #[test]
    fn account_session_id_is_daily_v4() {
        let a = account_session_id("acct1", "2026-10-04");
        let b = account_session_id("acct1", "2026-10-04");
        assert_eq!(a, b, "同账号同日稳定");
        assert_ne!(a, account_session_id("acct1", "2026-10-05"), "跨日轮换");
        assert_ne!(a, account_session_id("acct2", "2026-10-04"), "跨账号不同");
        // uuid v4 形态：第三组 4 开头、第四组 8/9/a/b 开头
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn abnormal_200_head_detection() {
        // 错误信封伪装成 200：无 "model":" 但有 error/code 线索
        assert!(abnormal_200_head(br#"{"error":{"type":"api_error","message":"overloaded"}}"#));
        assert!(abnormal_200_head(br#"{"code":1113,"msg":"no resource package"}"#));
        // 正常模型响应：缓冲头带 "model":"（JSON 顶层 / message_start）→ 不算异常
        assert!(!abnormal_200_head(br#"{"model":"glm-5.3","usage":{"input_tokens":1}}"#));
        assert!(!abnormal_200_head(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"glm-5.3\"}}"));
        // 无 model 也无线索（纯文本等）→ 不算（宁缺毋滥）
        assert!(!abnormal_200_head(b"plain text"));
        assert!(!abnormal_200_head(b""));
    }

    #[test]
    fn peek_model_extracts_upstream_name() {
        assert_eq!(peek_model(r#""model":"glm-5.3","x":1"#), "glm-5.3");
        assert_eq!(peek_model("no model here"), "");
        assert_eq!(peek_model(r#""model":""#), "");
    }

    #[test]
    fn sticky_first_reorders_pool() {
        let info = || ApiKeyInfo {
            label: String::new(),
            api_key: String::new(),
            base_url: String::new(),
            provider: "zai".into(),
            kind: "jwt".into(),
            mint_error: None,
        };
        let mk = |id: &str| -> (String, String, ApiKeyInfo, Option<String>) {
            (id.to_string(), String::new(), info(), None)
        };
        let pool = vec![mk("a"), mk("b"), mk("c")];
        // 无 sticky：保持原序
        let out = sticky_first(pool.clone(), None);
        let ids: Vec<&str> = out.iter().map(|(id, ..)| id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // sticky="b"：排最前，其余保持相对顺序（稳定排序）
        let out = sticky_first(pool, Some("b"));
        let ids: Vec<&str> = out.iter().map(|(id, ..)| id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);
    }

    #[test]
    fn free_acct_tag_masks_key() {
        let pk = PoolKey { api_key: "abcdef123456".into(), provider: "zai".into() };
        assert_eq!(free_acct_tag(&pk), "zai:…3456");
        assert!(!free_acct_tag(&pk).contains("abcdef"));
        let short = PoolKey { api_key: "ab".into(), provider: "bigmodel".into() };
        assert_eq!(free_acct_tag(&short), "bigmodel:…ab");
    }

    #[test]
    fn ctype_ok_distinguishes_waf_page() {
        assert!(ctype_ok("application/json"));
        assert!(ctype_ok("text/event-stream"));
        assert!(!ctype_ok("text/html"));
        assert!(!ctype_ok(""));
    }

    /// 小分块交付的 reader：每次 read 至多返回 chunk 字节（模拟慢速流式上游，
    /// 逼 sniff_200_head 走多轮 read）
    struct Chunked {
        data: Vec<u8>,
        off: usize,
        chunk: usize,
    }

    impl Read for Chunked {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.off >= self.data.len() {
                return Ok(0);
            }
            let n = out.len().min(self.chunk).min(self.data.len() - self.off);
            out[..n].copy_from_slice(&self.data[self.off..self.off + n]);
            self.off += n;
            Ok(n)
        }
    }

    #[test]
    fn sniff_200_head_recombines_stream_transparently() {
        // 核心不变量：正常流「先嗅探再原样续流」——sniff_200_head 返回的缓冲头经
        // Cursor(head).chain(reader) 拼接后，读出的完整 body 必须逐字节等于原始响应
        // （消费处同款拼法见 plan_request_once / replay_abnormal）
        let body = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"glm-5.3\",\"id\":\"msg_1\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n".to_vec();
        let (head, rest) = sniff_200_head(Box::new(Chunked { data: body.clone(), off: 0, chunk: 7 }));
        assert!(has_model_key(&head), "嗅探到模型键即停");
        assert!(head.len() <= SNIFF_CAP);
        let mut recombined = Vec::new();
        std::io::Cursor::new(head).chain(rest).read_to_end(&mut recombined).unwrap();
        assert_eq!(recombined, body, "缓冲头 + 剩余流拼接必须逐字节还原原始响应");
    }

    #[test]
    fn sniff_200_head_caps_at_4k() {
        // 无模型键的长体：head 恰好封顶 4KB（单次 read 裁到剩余配额，小分块下也不会
        // 涨到 ~6KB），且拼接仍逐字节完整
        let body = vec![b'x'; SNIFF_CAP + 2048];
        let (head, rest) = sniff_200_head(Box::new(Chunked { data: body.clone(), off: 0, chunk: 2048 }));
        assert_eq!(head.len(), SNIFF_CAP);
        assert!(!has_model_key(&head));
        let mut recombined = Vec::new();
        std::io::Cursor::new(head).chain(rest).read_to_end(&mut recombined).unwrap();
        assert_eq!(recombined, body);
    }
}
