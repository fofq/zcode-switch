//! ZCode 客户端本地日志信号源。
//!
//! 为什么需要它：额度判定原来完全靠 HTTP 轮询官方 billing 接口（活跃账号 6-15s 一轮、
//! 最多 20s 超时 + 风控退避），从「额度耗尽」到「发现」的尾延迟可达 30-60s；而官方客户端
//! 自己就在高频查询额度，并把结果原样写进了本地日志：
//!
//!   [usage-stats] billing/balance 请求完成 {"balanceCount":2,"balances":[{...}]}
//!   [coding-plan-availability] billing/balance 请求完成 {"hasActiveStartPlan":true,"payload":{...}}
//!   [zcode-agent-service] 收到 ZCode provider runtime headers 请求 {"modelId":"GLM-5.3-Flash",...}
//!   [zcode-agent-service] ZCode provider runtime headers 已应用 {...}
//!
//! 读这些行等于：零额外请求、零风控成本、拿到每个额度池的精确 token 余量、客户端自己的
//! 「计划不可用」硬信号、以及"当前请求用的是哪个模型/什么时候开始与生效"（切号安全点）。
//! 本模块只读，不写客户端任何文件。

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// 首次接管/换文件时只读尾部这么多字节（日志可能已经几百 MB）
const TAIL_BYTES: u64 = 512 * 1024;
/// 轮询间隔：客户端写日志是实时的，1s 足够
const POLL_MS: u64 = 1000;
/// 单次最多消费的字节数（防止长时间挂起后一次性读爆）
const MAX_READ_PER_TICK: u64 = 4 * 1024 * 1024;
/// 行缓冲上限：超长行直接丢弃，避免内存失控
const MAX_CARRY: usize = 256 * 1024;

const MARK_USAGE: &str = "[usage-stats] billing/balance 请求完成";
const MARK_PLAN: &str = "[coding-plan-availability] billing/balance 请求完成";
const MARK_REQ: &str = "provider runtime headers";

/// 一个额度池（模型 × 计费窗口）的当前余量
#[derive(Clone, Debug, Default, Serialize)]
pub struct Pool {
    pub entitlement_id: String,
    pub show_name: String,
    pub total: f64,
    pub used: f64,
    pub remaining: f64,
    /// 该池到期时间（epoch 秒，服务端给的 period_end/expires_at）
    pub expires_at: Option<i64>,
}

/// 对外快照（同时被 Tauri 命令与 CLI 用）
#[derive(Clone, Debug, Default, Serialize)]
pub struct Snapshot {
    /// 日志目录/文件可用（至少成功读到一个文件）
    pub available: bool,
    pub log_path: String,
    /// 最近一次读到新内容的时间（毫秒）
    pub log_at_ms: i64,
    /// 最近一次余额快照与其前一次（前端用两者算烧速）
    pub pools: Vec<Pool>,
    pub pools_at_ms: i64,
    pub prev_pools: Vec<Pool>,
    pub prev_at_ms: i64,
    /// 客户端自己的「计划可用」判定（false = 官方客户端认为当前账号不可用）
    pub plan_available: Option<bool>,
    pub plan_at_ms: i64,
    /// 正在使用的模型（最近一次 provider runtime headers 请求）
    pub model: Option<String>,
    pub model_at_ms: i64,
    pub provider: Option<String>,
    pub last_request_at_ms: i64,
    pub last_applied_at_ms: i64,
    pub requests: u64,
    pub parse_errors: u64,
}

static STATE: OnceLock<Mutex<Snapshot>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static STARTED: OnceLock<()> = OnceLock::new();

fn state() -> &'static Mutex<Snapshot> {
    STATE.get_or_init(|| Mutex::new(Snapshot::default()))
}

fn lock_state() -> std::sync::MutexGuard<'static, Snapshot> {
    match state().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 快照（前端 `live_signals` 命令用）
pub fn snapshot() -> Snapshot {
    lock_state().clone()
}

/// 标记状态已变化并把事件推给前端（让自动切换从「定时巡检」变成「事件驱动」）
fn notify(kind: &str) {
    use tauri::Emitter;
    if let Some(app) = APP.get() {
        let _ = app.emit("zsignals", serde_json::json!({ "kind": kind }));
    }
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

/// 启动日志跟随线程（幂等；app 启动时调一次）
pub fn start(home: &Path) {
    if STARTED.set(()).is_err() {
        return;
    }
    let dir = log_dir(home);
    std::thread::Builder::new()
        .name("zsignals-tail".into())
        .spawn(move || tail_loop(dir))
        .ok();
}

pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

pub fn log_dir(home: &Path) -> PathBuf {
    home.join(".zcode").join("v2").join("logs")
}

/// 目录里最新的 .log 文件 + 长度（按修改时间取，天然兼容日期滚动与多进程日志）
fn newest_log(dir: &Path) -> Option<(PathBuf, u64)> {
    let mut best: Option<(SystemTime, PathBuf, u64)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let better = match best.as_ref() {
            Some((t, _, _)) => mtime > *t,
            None => true,
        };
        if better {
            best = Some((mtime, path, meta.len()));
        }
    }
    best.map(|(_, p, len)| (p, len))
}

/// 从 `offset` 起读到文件末尾；返回 (新内容, 新 offset, 文件长度)
fn read_from(path: &Path, offset: u64, len: u64) -> Option<(Vec<u8>, u64)> {
    if len <= offset {
        return None;
    }
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let want = (len - offset).min(MAX_READ_PER_TICK) as usize;
    let mut buf = vec![0u8; want];
    let mut got = 0usize;
    while got < want {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => break,
        }
    }
    buf.truncate(got);
    Some((buf, offset + got as u64))
}

fn tail_loop(dir: PathBuf) {
    let mut cur: Option<PathBuf> = None;
    let mut offset: u64 = 0;
    let mut carry = String::new();
    loop {
        if let Some((path, len)) = newest_log(&dir) {
            let switched = cur.as_ref() != Some(&path);
            if switched {
                // 换文件（或首次）：只从尾部接管，并跳到第一个完整行
                cur = Some(path.clone());
                offset = len.saturating_sub(TAIL_BYTES);
                carry.clear();
                if offset > 0 {
                    if let Some((head, _)) = read_from(&path, offset.saturating_sub(1), len) {
                        if let Some(nl) = head.iter().position(|b| *b == b'\n') {
                            offset = offset.saturating_sub(1) + nl as u64 + 1;
                        }
                    }
                }
            } else if len < offset {
                // 日志被轮转/截断
                offset = len.saturating_sub(TAIL_BYTES);
                carry.clear();
            }
            if let Some((bytes, next)) = read_from(&path, offset, len) {
                offset = next;
                let text = String::from_utf8_lossy(&bytes);
                carry.push_str(&text);
                let mut consumed = 0usize;
                let mut kinds: Vec<&'static str> = Vec::new();
                while let Some(nl) = carry[consumed..].find('\n') {
                    let end = consumed + nl;
                    let line = carry[consumed..end].to_string();
                    consumed = end + 1;
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Some(kind) = apply_line(&line) {
                        kinds.push(kind);
                    }
                }
                if consumed > 0 {
                    carry.drain(..consumed);
                }
                if carry.len() > MAX_CARRY {
                    carry.clear();
                }
                {
                    let mut st = lock_state();
                    st.available = true;
                    st.log_path = path.display().to_string();
                    st.log_at_ms = now_ms();
                }
                let mut seen: Vec<&str> = Vec::new();
                for k in kinds {
                    if !seen.contains(&k) {
                        seen.push(k);
                    }
                }
                for k in seen {
                    notify(k);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// 解析一行日志并并入快照（全局）；返回变化类别（用于事件推送）
fn apply_line(line: &str) -> Option<&'static str> {
    apply_line_in(&mut lock_state(), line)
}

/// 解析主体（对传入快照操作，纯函数，便于单测）
fn apply_line_in(st: &mut Snapshot, line: &str) -> Option<&'static str> {
    let at = line_time_ms(line).unwrap_or_else(now_ms);
    if line.contains(MARK_USAGE) || line.contains(MARK_PLAN) {
        let raw = balanced_json(line)?;
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            st.parse_errors += 1;
            return None;
        };
        let mut kind: Option<&'static str> = None;
        if let Some(pools) = extract_pools(&v) {
            // 空数组也要应用：客户端明确返回「一个额度池都没有」= 无套餐/全过期，
            // 这是比百分比更强的硬信号；保留旧池会让程序一直以为还有额度（绝不陈旧化）
            st.prev_pools = std::mem::take(&mut st.pools);
            st.prev_at_ms = st.pools_at_ms;
            st.pools = pools;
            st.pools_at_ms = at;
            kind = Some("pools");
        }
        if let Some(b) = v.get("hasActiveStartPlan").and_then(|x| x.as_bool()) {
            if st.plan_available != Some(b) {
                st.plan_available = Some(b);
                st.plan_at_ms = at;
                if kind.is_none() {
                    kind = Some("plan");
                }
            }
        }
        return kind;
    }
    if line.contains(MARK_REQ) {
        if let Some(m) = json_str(line, "modelId") {
            st.model = Some(m);
            st.model_at_ms = at;
        }
        if let Some(p) = json_str(line, "providerId") {
            st.provider = Some(p);
        }
        if line.contains("已应用") {
            st.last_applied_at_ms = at;
        } else if line.contains("请求") {
            st.requests += 1;
            st.last_request_at_ms = at;
        }
        return Some("request");
    }
    None
}

/// 取日志行里第一个「配平的」JSON 对象（容忍行尾还有别的文本）
fn balanced_json(line: &str) -> Option<&str> {
    let start = line.find('{')?;
    let bytes = line.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if esc {
                esc = false;
            } else if *b == b'\\' {
                esc = true;
            } else if *b == b'"' {
                in_str = false;
            }
            continue;
        }
        match *b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return line.get(start..=i);
                }
            }
            _ => {}
        }
    }
    None
}

/// 行首 `[YYYY-MM-DD HH:MM:SS.mmm]` → epoch 毫秒（解析不了就 None，由调用方回落到当前时间）
fn line_time_ms(line: &str) -> Option<i64> {
    use chrono::TimeZone;
    let s = line.strip_prefix('[')?;
    let end = s.find(']')?;
    let ts = s.get(..end)?.trim();
    let naive = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S%.3f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    chrono::Local.from_local_datetime(&naive).single().map(|dt| dt.timestamp_millis())
}

/// 从 `"key":"value"` 形态里取值（只对单行小字段用，避免整行 JSON 解析）
fn json_str(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let i = line.find(&pat)? + pat.len();
    let rest = line.get(i..)?;
    let end = rest.find('"')?;
    Some(rest.get(..end)?.to_string())
}

/// 从任意已知层级里找 balances 数组
fn balances_of(v: &Value) -> Option<&Vec<Value>> {
    for cand in [
        v.get("balances"),
        v.pointer("/payload/data/balances"),
        v.pointer("/payload/balances"),
        v.pointer("/data/balances"),
    ] {
        if let Some(arr) = cand.and_then(|x| x.as_array()) {
            return Some(arr);
        }
    }
    None
}

fn num(v: &Value, key: &str) -> Option<f64> {
    let n = v.get(key)?;
    n.as_f64().or_else(|| n.as_str().and_then(|s| s.parse::<f64>().ok()))
}

fn extract_pools(v: &Value) -> Option<Vec<Pool>> {
    let arr = balances_of(v)?;
    let mut out = Vec::new();
    for it in arr {
        let name = it
            .get("show_name")
            .and_then(|x| x.as_str())
            .or_else(|| it.get("name").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        let total = num(it, "total_units").or_else(|| num(it, "total")).unwrap_or(0.0);
        let used = num(it, "used_units").or_else(|| num(it, "used")).unwrap_or(0.0);
        let remaining = num(it, "remaining_units")
            .or_else(|| num(it, "remaining"))
            .or_else(|| num(it, "available_units"))
            .unwrap_or(0.0);
        if name.is_empty() && total <= 0.0 {
            continue;
        }
        out.push(Pool {
            entitlement_id: it
                .get("entitlement_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            show_name: name,
            total,
            used,
            remaining,
            expires_at: num(it, "expires_at").or_else(|| num(it, "period_end")).map(|x| x as i64),
        });
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// 测试：解析逻辑是纯函数，直接用本机抓到的真实日志行做 fixture
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const USAGE_LINE: &str = r#"[2026-09-20 16:29:28.773] [info] [pid:3460] [main] [host-log] (local-1) [host] [2026-09-20 16:29:28.771] [pid:25956] [usage-stats] billing/balance 请求完成 {"balanceCount":2,"balances":[{"entitlement_id":"ent_2_0817_glm_5p3","show_name":"GLM-5.3","total_units":3000000,"used_units":0,"remaining_units":3000000,"available_units":3000000},{"entitlement_id":"ent_2_0817_glm_5p3f","show_name":"GLM-5.3-Flash","total_units":5000000,"used_units":4819465,"remaining_units":180535,"available_units":180535}],"providerId":"account:zai-start-plan"}"#;

    const PLAN_LINE: &str = r#"[2026-09-20 09:04:33.105] [info] [pid:15668] [main] [host-log] (local-1) [host] [2026-09-20 09:04:33.105] [pid:17088] [coding-plan-availability] billing/balance 请求完成 {"durationMs":133,"hasActiveStartPlan":true,"msg":"","payload":{"code":0,"data":{"server_time":1789866273,"plans":[{"plan_id":"zcode-v3-start-plan-0817","name":"ZCode Start Plan","status":"active","entitlements":[{"entitlement_id":"ent_2_0817_glm_5p3f","show_name":"GLM-5.3-Flash","meter":"model_usage","grant_units":5000000}]}],"balances":[{"entitlement_id":"ent_2_0817_glm_5p3f","show_name":"GLM-5.3-Flash","total_units":5000000,"used_units":100,"remaining_units":4999900,"period_end":1789919999}]}},"planCount":1,"providerId":"account:zai-start-plan","success":true}"#;

    const REQ_LINE: &str = r#"[2026-09-20 16:28:09.478] [info] [pid:3460] [main] [host-log] (local-1) [host] [2026-09-20 16:28:09.477] [pid:25956] [zcode-agent-service][trace:734824b8] 收到 ZCode provider runtime headers 请求 {"modelId":"GLM-5.3-Flash","providerId":"account:zai-start-plan","requestId":"sess_x:provider-runtime-headers:y"}"#;

    #[test]
    fn parses_usage_stats_balances() {
        let mut st = Snapshot::default();
        assert_eq!(apply_line_in(&mut st, USAGE_LINE), Some("pools"));
        assert_eq!(st.pools.len(), 2);
        assert_eq!(st.pools[1].show_name, "GLM-5.3-Flash");
        assert!((st.pools[1].remaining - 180535.0).abs() < 0.5);
        assert!((st.pools[1].total - 5000000.0).abs() < 0.5);
        // 时间戳来自行首
        assert!(st.pools_at_ms > 1_700_000_000_000);
    }

    #[test]
    fn parses_plan_availability_and_nested_balances() {
        let mut st = Snapshot::default();
        apply_line_in(&mut st, PLAN_LINE);
        assert_eq!(st.plan_available, Some(true));
        assert_eq!(st.pools.len(), 1);
        assert!((st.pools[0].remaining - 4999900.0).abs() < 0.5);
        assert_eq!(st.pools[0].expires_at, Some(1789919999));
    }

    #[test]
    fn plan_unavailable_flips() {
        let line = PLAN_LINE.replace("\"hasActiveStartPlan\":true", "\"hasActiveStartPlan\":false");
        let mut st = Snapshot::default();
        apply_line_in(&mut st, &line);
        assert_eq!(st.plan_available, Some(false));
    }

    #[test]
    fn parses_request_model_and_boundary() {
        let mut st = Snapshot::default();
        assert_eq!(apply_line_in(&mut st, REQ_LINE), Some("request"));
        assert_eq!(st.model.as_deref(), Some("GLM-5.3-Flash"));
        assert_eq!(st.provider.as_deref(), Some("account:zai-start-plan"));
        assert_eq!(st.requests, 1);
        let applied = REQ_LINE.replace("收到 ", "").replace("请求", "已应用");
        let mut st2 = Snapshot::default();
        apply_line_in(&mut st2, &applied);
        assert!(st2.last_applied_at_ms > 0);
    }

    #[test]
    fn empty_balances_clears_pools() {
        // 客户端业务成功但一个池都没有（无套餐/全过期）→ 必须把旧池清掉，不能留着装还有额度
        let mut st = Snapshot::default();
        apply_line_in(&mut st, USAGE_LINE);
        assert_eq!(st.pools.len(), 2);
        let empty = r#"[2026-09-20 18:00:00.000] [info] [main] [host-log] [usage-stats] billing/balance 请求完成 {"balanceCount":0,"balances":[],"code":0,"durationMs":182,"msg":"","payload":{"code":0,"msg":"","data":{"server_time":1789347644,"plans":[],"balances":[]}},"planCount":0,"plans":[],"providerId":"builtin:zai-start-plan","success":true}"#;
        assert_eq!(apply_line_in(&mut st, empty), Some("pools"));
        assert_eq!(st.pools.len(), 0);
        assert_eq!(st.prev_pools.len(), 2, "旧快照保留用于算速率");
        // 全零且无名的垃圾条目也不能算作可用池
        let mut st2 = Snapshot::default();
        apply_line_in(&mut st2, r#"[2026-09-20 18:00:01.000] [info] [x] [usage-stats] billing/balance 请求完成 {"balances":[{"entitlement_id":"x","show_name":"","total_units":0,"remaining_units":0}]}"#);
        assert_eq!(st2.pools.len(), 0);
    }

    #[test]
    fn ignores_unrelated_lines() {
        let mut st = Snapshot::default();
        assert_eq!(apply_line_in(&mut st, "[2026-09-20 17:25:09.347] [info] [main] [settingService] writing settings to: C:\\x\\setting.json {\"recentProjects\":[]}"), None);
        assert_eq!(apply_line_in(&mut st, "some random text"), None);
        assert_eq!(st.pools.len(), 0);
    }

    #[test]
    fn balanced_json_handles_braces_in_strings() {
        let line = r#"x {"a":"} not end","b":1} tail"#;
        assert_eq!(balanced_json(line), Some(r#"{"a":"} not end","b":1}"#));
        assert_eq!(balanced_json("no json here"), None);
        assert_eq!(balanced_json("broken {\"a\":1"), None);
    }

    #[test]
    fn previous_snapshot_is_kept_for_burn_rate() {
        let mut st = Snapshot::default();
        apply_line_in(&mut st, USAGE_LINE);
        let first = st.pools[1].remaining;
        let line2 = USAGE_LINE.replace("\"remaining_units\":180535", "\"remaining_units\":90000");
        apply_line_in(&mut st, &line2);
        assert!((st.prev_pools[1].remaining - first).abs() < 0.5);
        assert!((st.pools[1].remaining - 90000.0).abs() < 0.5);
    }
}
