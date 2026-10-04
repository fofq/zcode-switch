//! 逐请求用量计量（移植 .temp-sources/zcode-pool gateway.rs 的 Meter 与 usage.rs）：
//! Meter 包装上游响应字节流，逐字节透明转发的同时抓取头部 2KB（head，供错误码/模型名嗅探）、
//! 末尾 8KB 滑动窗口（tail）、TTFB 与总字节数；finish() 对 head+tail 做 usage 键的
//! 字节级扫描（同名键取最大值）。UsageRecord + append_usage 落 JSONL（>8MB 轮转 .1），
//! 任何 IO 失败一律静默返回，绝不影响请求路径。本模块自包含，只依赖 std 与 serde_json。

use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

/// head 保留字节数：错误码 / message_start 的 input_tokens 都在这里
const HEAD_CAP: usize = 2048;
/// tail 滑动窗口：流式响应的最终 usage（message_delta）在结尾
const TAIL_CAP: usize = 8192;
/// usage.jsonl 超过该字节数轮转为 .1
const ROTATE_BYTES: u64 = 8 * 1024 * 1024;

// ===== Meter：包装响应流 =====

/// 包装上游响应体 reader，转发行为逐字节透明；finish() 消费自身产出摘要。
pub struct Meter<R: Read> {
    inner: R,
    status: u16,
    stream: bool,
    head: Vec<u8>,
    tail: Vec<u8>,
    bytes: u64,
    started: Instant,
    first_at: Option<Instant>,
    ended: Option<Instant>,
}

#[derive(Debug)]
pub struct MeterSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub ttfb_ms: u128,
    pub total_ms: u128,
    pub bytes: u64,
    /// 流前 2KB，损失性转 UTF-8（可再喂 head_error_code 提取错误码）
    pub head: String,
    /// 流末尾 8KB 滑动窗口，损失性转 UTF-8（head 提不到错误码时再喂 head_error_code
    /// 兜底，对齐参考实现 peek_code(head)→tail：SSE 末尾的 error 事件只落 tail）
    pub tail: String,
    pub status: u16,
    pub stream: bool,
}

impl<R: Read> Meter<R> {
    /// 计时从 new() 起算：TTFB = 首个非零数据块距 new() 的耗时，total = EOF/finish 距 new()。
    pub fn new(inner: R, status: u16, stream: bool) -> Self {
        Meter {
            inner,
            status,
            stream,
            head: Vec::new(),
            tail: Vec::new(),
            bytes: 0,
            started: Instant::now(),
            first_at: None,
            ended: None,
        }
    }

    /// 收尾：对 head+tail 做字节级 usage 扫描（同名键取最大值），产出摘要。
    /// 只扫 head+tail 而非全量缓存：流式 usage 集中在 message_start（head）与
    /// message_delta（尾部 8KB），中间纯文本增量不携带 usage，且不占内存。
    pub fn finish(self) -> MeterSummary {
        let Meter { inner, head, tail, started, first_at, ended, bytes, status, stream } = self;
        drop(inner);
        let input_tokens = scan_u64_key(&head, b"input_tokens")
            .max(scan_u64_key(&tail, b"input_tokens"))
            .unwrap_or(0);
        let output_tokens = scan_u64_after(&head, b"output_tokens")
            .max(scan_u64_after(&tail, b"output_tokens"))
            .unwrap_or(0);
        let cache_read = scan_u64_key(&head, b"cache_read_input_tokens")
            .max(scan_u64_key(&tail, b"cache_read_input_tokens"))
            .unwrap_or(0);
        let ttfb_ms = first_at
            .map(|t| t.saturating_duration_since(started).as_millis())
            .unwrap_or(0);
        let total_ms = ended
            .unwrap_or_else(Instant::now)
            .saturating_duration_since(started)
            .as_millis();
        MeterSummary {
            input_tokens,
            output_tokens,
            cache_read,
            ttfb_ms,
            total_ms,
            bytes,
            head: String::from_utf8_lossy(&head).into_owned(),
            tail: String::from_utf8_lossy(&tail).into_owned(),
            status,
            stream,
        }
    }
}

impl<R: Read> Read for Meter<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(out)?;
        let now = Instant::now();
        if n == 0 {
            // EOF：记下结束时刻（finish 用它算 total，含客户端读完但未调 finish 的差值）
            if self.ended.is_none() {
                self.ended = Some(now);
            }
            return Ok(0);
        }
        if self.first_at.is_none() {
            self.first_at = Some(now);
        }
        self.bytes = self.bytes.saturating_add(n as u64);
        if self.head.len() < HEAD_CAP {
            let room = HEAD_CAP - self.head.len();
            let take = n.min(room);
            self.head.extend_from_slice(&out[..take]);
        }
        self.tail.extend_from_slice(&out[..n]);
        if self.tail.len() > TAIL_CAP {
            let cut = self.tail.len() - TAIL_CAP;
            self.tail.drain(..cut);
        }
        Ok(n)
    }
}

// ===== 键扫描（逐字移植 zcode-pool gateway.rs scan_u64_key / scan_u64_after）=====

/// 有界键扫描：键名前一字符不得是字母/数字/下划线——避免把
/// "cache_read_input_tokens"/"cache_creation_input_tokens" 里的 "input_tokens" 误计入。
/// 同名键多次出现取最大值。
fn scan_u64_key(hay: &[u8], needle: &[u8]) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            let bounded = i == 0 || !(hay[i - 1].is_ascii_alphanumeric() || hay[i - 1] == b'_');
            if bounded {
                let mut j = i + needle.len();
                let lim = (i + needle.len() + 16).min(hay.len());
                while j < lim && !hay[j].is_ascii_digit() {
                    j += 1;
                }
                let mut v: u64 = 0;
                let mut any = false;
                while j < hay.len() && hay[j].is_ascii_digit() {
                    v = v.saturating_mul(10).saturating_add((hay[j] - b'0') as u64);
                    any = true;
                    j += 1;
                }
                if any {
                    best = Some(best.map_or(v, |b: u64| b.max(v)));
                }
            }
            i += needle.len();
        } else {
            i += 1;
        }
    }
    best
}

/// 无界键扫描（output_tokens 用，与参考实现一致）：键名后 16 字节内找首个数字起读。
fn scan_u64_after(hay: &[u8], needle: &[u8]) -> Option<u64> {
    let mut best: Option<u64> = None;
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            while j < hay.len() && !hay[j].is_ascii_digit() && j < i + needle.len() + 16 {
                j += 1;
            }
            let mut v: u64 = 0;
            let mut any = false;
            while j < hay.len() && hay[j].is_ascii_digit() {
                v = v.saturating_mul(10).saturating_add((hay[j] - b'0') as u64);
                any = true;
                j += 1;
            }
            if any {
                best = Some(best.map_or(v, |b: u64| b.max(v)));
            }
            i = j;
        } else {
            i += 1;
        }
    }
    best
}

// ===== 落盘 =====

#[derive(Debug)]
pub struct UsageRecord {
    /// unix 秒
    pub t: u64,
    pub acct: String,
    pub model: String,
    pub up: String,
    /// 短码（head_error_code 产出）：1113 / 3007 / abnormal / captcha / overloaded_error / 空
    pub code: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub ttfb_ms: u128,
    pub total_ms: u128,
    pub bytes: u64,
    pub status: u16,
    pub tries: u32,
    pub stream: bool,
}

impl UsageRecord {
    /// 手写 JSONL 行：serde_json 的 Number 不收 u128（需 arbitrary_precision feature，
    /// 我方未启用），手拼规避；字符串字段经 serde_json 转义，注入安全。
    fn to_jsonl(&self) -> String {
        let esc = |v: &String| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string());
        format!(
            "{{\"t\":{},\"acct\":{},\"model\":{},\"up\":{},\"code\":{},\"input_tokens\":{},\"output_tokens\":{},\"cache_read\":{},\"ttfb_ms\":{},\"total_ms\":{},\"bytes\":{},\"status\":{},\"tries\":{},\"stream\":{}}}",
            self.t,
            esc(&self.acct),
            esc(&self.model),
            esc(&self.up),
            esc(&self.code),
            self.input_tokens,
            self.output_tokens,
            self.cache_read,
            self.ttfb_ms,
            self.total_ms,
            self.bytes,
            self.status,
            self.tries,
            self.stream
        )
    }
}

/// 追加一条用量到 dir/usage.jsonl（文件名与参考实现一致）；超过 8MB 轮转为 .1（覆盖旧 .1）。
/// dir 为 None 或任何 IO 失败（目录不存在/占用等）一律静默返回；串行化写避免交错行。
static USAGE_LOCK: Mutex<()> = Mutex::new(());

pub fn append_usage(dir: Option<&Path>, rec: &UsageRecord) {
    let Some(dir) = dir else { return };
    let line = rec.to_jsonl();
    let _guard = USAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("usage.jsonl");
    if let Ok(m) = std::fs::metadata(&path) {
        if m.len() > ROTATE_BYTES {
            let old = dir.join("usage.jsonl.1");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&path, &old);
        }
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let _ = f.write_all(line.as_bytes());
    let _ = f.write_all(b"\n");
}

// ===== 错误码提取 =====

/// 从 head 文本提取短码：优先 `"code":数字` / `"code":"字符串"`（逐字移植 zcode-pool
/// peek_code），其次 Anthropic 风格 `"type":"..._error"`，再次词面线索（风控→abnormal、
/// 验证码→captcha，词表与 mod.rs classify_plan_err/is_captcha_challenge 一致）；都没有返回空串。
pub fn head_error_code(head: &str) -> String {
    let mut from = 0usize;
    while let Some(rel) = head[from..].find("\"code\"") {
        let i = from + rel + "\"code\"".len();
        let rest = head[i..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            from = i;
            continue;
        };
        let rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix('"') {
            if let Some(end) = r.find('"') {
                let c = r[..end].trim();
                if !c.is_empty() {
                    return c.to_string();
                }
            }
        } else {
            let c: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !c.is_empty() {
                return c;
            }
        }
        from = i;
    }
    if let Some(t) = error_type(head) {
        return t;
    }
    let l = head.to_lowercase();
    if l.contains("unusual activity") {
        return "abnormal".into();
    }
    if l.contains("captcha")
        || l.contains("verify token")
        || l.contains("verify failed")
        || l.contains("human verification")
        || l.contains("verifycode")
    {
        return "captcha".into();
    }
    String::new()
}

/// `"type":"xxx_error"`（信封 "type":"error" 不算）；找不到返回 None。
fn error_type(head: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(rel) = head[from..].find("\"type\"") {
        let i = from + rel + "\"type\"".len();
        let rest = head[i..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            from = i;
            continue;
        };
        let rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix('"') {
            if let Some(end) = r.find('"') {
                let t = &r[..end];
                if t.ends_with("_error") {
                    return Some(t.to_string());
                }
            }
        }
        from = i;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    /// 读完整个流并收集转发字节，返回 (转发内容, 摘要)
    fn drain<R: Read>(mut m: Meter<R>, bufsize: usize) -> (Vec<u8>, MeterSummary) {
        let mut got = Vec::new();
        let mut buf = vec![0u8; bufsize];
        loop {
            let n = m.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
        let s = m.finish();
        (got, s)
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "zsw-meter-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    #[test]
    fn usage_scan_takes_max_and_is_transparent() {
        let body: &[u8] = br#"{"model":"glm-4.6","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":7},"extra":"x","output_tokens":42,"input_tokens":33,"cache_creation_input_tokens":999,"xinput_tokens":777,"cache_read_input_tokens":12}"#;
        let (got, s) = drain(Meter::new(Cursor::new(body.to_vec()), 200, false), 7);
        // 逐字节透明
        assert_eq!(got, body.to_vec());
        assert_eq!(s.bytes, body.len() as u64);
        assert_eq!(s.status, 200);
        assert!(!s.stream);
        // 同名键取最大值；前缀词 / cache_creation 不误计（有界扫描）
        assert_eq!(s.input_tokens, 33);
        assert_eq!(s.output_tokens, 42);
        assert_eq!(s.cache_read, 12);
        // 短响应：head == 整个体
        assert_eq!(s.head, String::from_utf8_lossy(body).into_owned());
    }

    #[test]
    fn head_tail_windows_only() {
        // 2048(head) + 4096(丢弃区) + 8192(tail)
        let mut body = vec![b'a'; 2048 + 4096 + 8192];
        let mut put = |off: usize, s: &str| body[off..off + s.len()].copy_from_slice(s.as_bytes());
        put(100, "\"output_tokens\":55"); // 只落 head
        put(5000, "\"input_tokens\":999"); // 落 head/tail 之间的丢弃区，必须丢失
        put(14100, "\"input_tokens\":333"); // 落 tail
        put(14150, "\"cache_read_input_tokens\":21");
        drop(put);
        let (_, s) = drain(Meter::new(Cursor::new(body.clone()), 200, true), 3000);
        assert_eq!(s.bytes, body.len() as u64);
        assert!(s.stream);
        assert_eq!(s.head.len(), HEAD_CAP);
        assert_eq!(s.head, String::from_utf8_lossy(&body[..HEAD_CAP]).into_owned());
        assert_eq!(s.input_tokens, 333); // 999 已随丢弃区消失
        assert_eq!(s.output_tokens, 55); // 来自 head
        assert_eq!(s.cache_read, 21);
    }

    #[test]
    fn ttfb_and_total_measured() {
        struct Slow {
            left: usize,
        }
        impl Read for Slow {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.left == 0 {
                    return Ok(0);
                }
                std::thread::sleep(Duration::from_millis(25)); // sleep 至少 25ms → ttfb_ms 必 > 0
                let n = out.len().min(self.left).min(4);
                out[..n].fill(b'z');
                self.left -= n;
                Ok(n)
            }
        }
        let (_, s) = drain(Meter::new(Slow { left: 9 }, 200, true), 16);
        assert_eq!(s.bytes, 9);
        assert!(s.ttfb_ms > 0, "ttfb 应大于 0，实测 {}", s.ttfb_ms);
        assert!(s.total_ms >= s.ttfb_ms);
    }

    #[test]
    fn append_usage_writes_rotates_and_cleans() {
        let dir = temp_dir("rotate");
        std::fs::create_dir_all(&dir).unwrap();
        // 一条 acct 直接写超 8MB，下一条触发轮转
        let big = UsageRecord {
            t: 1,
            acct: "x".repeat(ROTATE_BYTES as usize + 1024),
            model: "big".into(),
            up: String::new(),
            code: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            ttfb_ms: 0,
            total_ms: 0,
            bytes: 0,
            status: 200,
            tries: 1,
            stream: false,
        };
        append_usage(Some(dir.as_path()), &big);
        let small = UsageRecord {
            t: 2,
            acct: "small-acct".into(),
            model: "glm-5.3".into(),
            up: "zcode-plan".into(),
            code: "1113".into(),
            input_tokens: 11,
            output_tokens: 22,
            cache_read: 3,
            ttfb_ms: 4,
            total_ms: 5,
            bytes: 6,
            status: 200,
            tries: 2,
            stream: true,
        };
        append_usage(Some(dir.as_path()), &small);
        // 读入内存后再清理，断言失败也不留 8MB 垃圾
        let rolled = std::fs::read_to_string(dir.join("usage.jsonl.1")).unwrap();
        let cur = std::fs::read_to_string(dir.join("usage.jsonl")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(rolled.contains("\"model\":\"big\""));
        assert!(cur.len() < 4096);
        // 手写 JSONL 必须是合法 JSON 且字段名/值正确
        let v: serde_json::Value = serde_json::from_str(cur.trim()).unwrap();
        assert_eq!(v["acct"].as_str(), Some("small-acct"));
        assert_eq!(v["model"].as_str(), Some("glm-5.3"));
        assert_eq!(v["code"].as_str(), Some("1113"));
        assert_eq!(v["input_tokens"].as_u64(), Some(11));
        assert_eq!(v["output_tokens"].as_u64(), Some(22));
        assert_eq!(v["cache_read"].as_u64(), Some(3));
        assert_eq!(v["ttfb_ms"].as_u64(), Some(4));
        assert_eq!(v["total_ms"].as_u64(), Some(5));
        assert_eq!(v["status"].as_u64(), Some(200));
        assert_eq!(v["tries"].as_u64(), Some(2));
        assert_eq!(v["stream"].as_bool(), Some(true));
        assert!(!dir.exists());
    }

    #[test]
    fn jsonl_escapes_strings() {
        let dir = temp_dir("escape");
        std::fs::create_dir_all(&dir).unwrap();
        let rec = UsageRecord {
            t: 3,
            acct: "a\"b\\c\n日".into(),
            model: "m".into(),
            up: "u".into(),
            code: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            ttfb_ms: 0,
            total_ms: 0,
            bytes: 0,
            status: 500,
            tries: 3,
            stream: false,
        };
        append_usage(Some(dir.as_path()), &rec);
        let cur = std::fs::read_to_string(dir.join("usage.jsonl")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let v: serde_json::Value = serde_json::from_str(cur.trim()).unwrap();
        assert_eq!(v["acct"].as_str(), Some("a\"b\\c\n日"));
        assert_eq!(v["status"].as_u64(), Some(500));
    }

    #[test]
    fn append_usage_silent_on_missing_dir() {
        let missing = temp_dir("missing");
        let rec = UsageRecord {
            t: 0,
            acct: String::new(),
            model: String::new(),
            up: String::new(),
            code: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            ttfb_ms: 0,
            total_ms: 0,
            bytes: 0,
            status: 0,
            tries: 0,
            stream: false,
        };
        append_usage(Some(missing.as_path()), &rec); // 目录不存在：不 panic、不创建
        append_usage(None, &rec); // dir 为 None：静默
        assert!(!missing.exists());
    }

    #[test]
    fn head_error_code_extraction() {
        // "code":数字
        assert_eq!(head_error_code("{\"error\":{\"code\":1113,\"msg\":\"no resource package\"}}"), "1113");
        // "code":"字符串"
        assert_eq!(head_error_code("{\"code\": \"3007\"}"), "3007");
        // Anthropic 风格 error.type
        assert_eq!(
            head_error_code("{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"),
            "overloaded_error"
        );
        // 词面线索
        assert_eq!(head_error_code("unusual activity detected"), "abnormal");
        assert_eq!(head_error_code("please pass human verification"), "captcha");
        assert_eq!(head_error_code("all good here"), "");
        assert_eq!(head_error_code(""), "");
        // code 优先于 type
        assert_eq!(head_error_code("{\"error\":{\"code\":3012,\"type\":\"invalid_request_error\"}}"), "3012");
    }
}
