//! 官方 system 提示词提取与回放 —— 套餐路由过 3012 风控的关键。
//! 上游对 /v1/messages 的 system 只校验到身份段为止，但校验是逐字节比对：
//! 必须恰好是「固定前缀 + 身份段」两块，identity 里改一个字符就 3012。
//! 这两段不在任何常量里，而是藏在安装的 ZCode 客户端 zcode.cjs 的两个
//! section 构造函数（source:"cli_prefix" / source:"identity"）里，构建期才会拼出来。
//! 本模块带一个极小 JS 求值器把它们静态还原：extract_from_source 纯提取+校验，
//! official_system_blocks 负责定位/进程与磁盘缓存，apply_system 把官方两块垫进请求体。
//! 提取/校验/求值算法照搬参考实现 .temp-sources/zcode-pool/src-tauri/src/prompt.rs
//! （已对真实 bundle 验证可用），应用方式参考其 gateway.rs::external_body。
//! 全部为同步 API：注册表扫描 / 读十几 MB 的 cjs / 解析求值都是重活，
//! 由调用方（套餐路由）放 spawn_blocking 执行。

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

const PROMPT_PREFIX: &str = "You are ZCode, an interactive coding agent";

/// 服务端只校验到身份段为止：`system` 必须恰好是「固定前缀 + 身份段」两块，且逐字节相等。
/// 身份段之后的 Desktop Context / Session guidance / Environment / Context management
/// 全部可有可无（实测：把它们整段删掉照样 200，改动身份段里任意一个字符就 3012）。
///
/// 所以这里**有意只发这两块**。被丢掉的那些段落要么点名客户端专属的东西
/// （`::code-comment` 指令、`/<skill>` 走 Skill 工具），要么把本机路径、
/// 伪造的环境信息塞进每一次请求里 —— 对第三方客户端全是噪音。
const IDENTITY_PREFIX: &str = "You are an interactive ZCode agent";

const CACHE_FILE: &str = "system_prompt.json";
/// 定位/提取失败后的重扫冷却：注册表 /s 扫描 + 多路径探测不便宜，
/// 不该在没装客户端的机器上每个请求都付一遍（冷却期内放进去的
/// system_prompt.json 仍会生效——磁盘缓存读在冷却检查之前）。
const MISS_COOLDOWN_MS: u64 = 300_000;

/// 从 zcode.cjs 源码静态提取官方两段 system 块（cli_prefix + identity）。
/// 返回恰好两个 {"type":"text","text":...,"cache_control":{"type":"ephemeral"}}：
/// 块0 必须逐字节等于固定前缀；块1 以身份段开头、800-8000 字符；
/// 含 undefined / [object / `${` / `,,` 等静默降级痕迹即失败（宁缺毋滥，缺了顶多 503，
/// 发出去一段被模板插值掏空的 identity 是 3012 封号）。
pub fn extract_from_source(src: &str) -> Result<Vec<serde_json::Value>, String> {
    let src: Rc<str> = Rc::from(src);

    let mut ev = Ev::new(src.clone());

    let cli = ev.build_section(r#"source:"cli_prefix""#, &[])?;
    let identity = ev.build_section(r#"source:"identity""#, &[Val::Null])?;

    let ordered: Vec<Val> = vec![cli, identity];
    let inj = |ev: &mut Ev, v: &Val| -> Result<String, String> {
        Ok(val_to_string(ev.get_prop(v, "injectionTarget")?))
    };
    let src_of = |ev: &mut Ev, v: &Val| -> Result<String, String> {
        Ok(val_to_string(ev.get_prop(v, "source")?))
    };
    let content = |ev: &mut Ev, v: &Val| -> Result<String, String> {
        match ev.get_prop(v, "content")? {
            Val::Str(s) => Ok(s.to_string()),
            _ => Err("section.content 不是字符串".to_string()),
        }
    };

    let mut b0: Vec<String> = Vec::new();
    let mut b1: Vec<String> = Vec::new();
    for s in &ordered {
        if inj(&mut ev, s)? != "system" {
            continue;
        }
        if src_of(&mut ev, s)? == "cli_prefix" {
            b0.push(content(&mut ev, s)?);
        } else {
            b1.push(content(&mut ev, s)?);
        }
    }

    let blocks = vec![
        json!({ "type": "text", "text": b0.join("\n\n"), "cache_control": { "type": "ephemeral" } }),
        json!({ "type": "text", "text": b1.join("\n\n"), "cache_control": { "type": "ephemeral" } }),
    ];

    validate(&blocks)?;
    Ok(blocks)
}

/// 官方两块的进程级 OnceLock 缓存；cache_dir 给定时读写磁盘缓存 system_prompt.json
/// （原子写 tmp+rename，有合规缓存则免掉整份 cjs 的解析）。
/// 定位 zcode.cjs：先注册表（InstallLocation，缺省从 UninstallString 推导安装目录），
/// 再试常见安装路径；目标永远是 安装目录\resources\glm\zcode.cjs。全部失败返回 None。
pub fn official_system_blocks(cache_dir: Option<&std::path::Path>) -> Option<Vec<serde_json::Value>> {
    static BLOCKS: OnceLock<Vec<Value>> = OnceLock::new();
    if let Some(v) = BLOCKS.get() {
        return Some(v.clone());
    }

    // 磁盘缓存优先：命中且校验通过就不碰 zcode.cjs（也免掉注册表扫描）
    if let Some(dir) = cache_dir {
        let p = dir.join(CACHE_FILE);
        if let Ok(bytes) = fs::read(&p) {
            match serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.as_array().cloned())
            {
                Some(b) => match validate(&b) {
                    Ok(()) => {
                        let _ = BLOCKS.set(b.clone());
                        return Some(b);
                    }
                    Err(e) => eprintln!("[zsw] sysprompt 缓存文件不合规（{e}），改从 ZCode 抽取"),
                },
                None => eprintln!("[zsw] sysprompt 缓存文件不是 JSON 数组，改从 ZCode 抽取"),
            }
        }
    }

    if miss_cooling() {
        return None;
    }
    let cjs = match find_zcode_cjs() {
        Some(p) => p,
        None => {
            note_miss();
            return None;
        }
    };
    let src = match fs::read_to_string(&cjs) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[zsw] sysprompt 读取 {} 失败：{e}", cjs.display());
            note_miss();
            return None;
        }
    };
    match extract_from_source(&src) {
        Ok(b) => {
            if let Some(dir) = cache_dir {
                cache_write_atomic(&dir.join(CACHE_FILE), &b);
            }
            let _ = BLOCKS.set(b.clone());
            Some(b)
        }
        Err(e) => {
            eprintln!("[zsw] sysprompt 抽取失败（{}）：{e}", cjs.display());
            note_miss();
            None
        }
    }
}

/// 把官方块应用为请求体的 system：官方两块在前，调用方原 system 追加在后
/// （字符串 → 单个 text 块；数组 → 原样扩展；缺省/空串/其他形态宽容处理 → 只有官方两块）。
pub fn apply_system(body: &mut serde_json::Value, blocks: &[serde_json::Value]) {
    let Some(obj) = body.as_object_mut() else {
        return; // 非 JSON 对象的请求体不碰（宽容）
    };
    let caller = obj.get("system").cloned();
    let mut out: Vec<Value> = blocks.to_vec();
    match caller {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            out.push(json!({ "type": "text", "text": s }))
        }
        Some(Value::Array(a)) => out.extend(a),
        _ => {}
    }
    obj.insert("system".into(), Value::Array(out));
}

// ===== 定位与缓存 =====

static LAST_MISS_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn miss_cooling() -> bool {
    let last = LAST_MISS_MS.load(Ordering::Relaxed);
    last != 0 && now_ms().saturating_sub(last) < MISS_COOLDOWN_MS
}

fn note_miss() {
    LAST_MISS_MS.store(now_ms(), Ordering::Relaxed);
}

fn cache_write_atomic(path: &Path, blocks: &[Value]) {
    let s = match serde_json::to_string(blocks) {
        Ok(s) => s,
        Err(_) => return,
    };
    let tmp = path.with_extension("json.tmp");
    // 原子写：先落 tmp 再改名，避免并发请求读到半截 JSON；失败静默（缓存是优化不是依赖）
    if fs::write(&tmp, s.as_bytes()).is_ok() {
        if fs::rename(&tmp, path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

fn find_zcode_cjs() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = find_install_dir_via_registry() {
        dirs.push(d);
    }
    for exe in client_exe_candidates() {
        if exe.is_empty() {
            continue;
        }
        if let Some(d) = Path::new(&exe).parent() {
            dirs.push(d.to_path_buf());
        }
    }
    for d in &dirs {
        if let Some(p) = cjs_in_dir(d) {
            return Some(p);
        }
    }
    None
}

/// 仿 quota::zcode_app_version 的注册表 /s 扫描，但抓的是安装目录：
/// 优先 InstallLocation，缺省从 UninstallString（卸载器全路径）取父目录推导。
fn find_install_dir_via_registry() -> Option<PathBuf> {
    for hive in [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ] {
        let Ok(out) = no_window("reg").args(["query", hive, "/s"]).output() else {
            continue;
        };
        let txt = String::from_utf8_lossy(&out.stdout);
        let (mut name, mut install, mut uninstall) =
            (String::new(), String::new(), String::new());
        for line in txt.lines() {
            let l = line.trim();
            if l.starts_with("HKEY_") {
                if let Some(d) = zcode_install_dir(&name, &install, &uninstall) {
                    return Some(d);
                }
                name.clear();
                install.clear();
                uninstall.clear();
                continue;
            }
            if let Some(rest) = l.strip_prefix("DisplayName") {
                name = reg_value(rest);
            } else if let Some(rest) = l.strip_prefix("InstallLocation") {
                install = reg_value(rest);
            } else if let Some(rest) = l.strip_prefix("UninstallString") {
                uninstall = reg_value(rest);
            }
        }
        if let Some(d) = zcode_install_dir(&name, &install, &uninstall) {
            return Some(d);
        }
    }
    None
}

/// reg query 输出形如 `DisplayName    REG_SZ    ZCode`（列名已被 strip_prefix 剥掉），
/// 这里剥掉类型列取值；REG_EXPAND_SZ 的可展开串不做环境变量展开，凑合用。
fn reg_value(rest: &str) -> String {
    let t = rest.trim_start();
    let t = t.strip_prefix("REG_EXPAND_SZ").unwrap_or(t).trim_start();
    t.strip_prefix("REG_SZ").unwrap_or(t).trim().to_string()
}

fn zcode_install_dir(name: &str, install: &str, uninstall: &str) -> Option<PathBuf> {
    if !is_zcode_display_name(name) {
        return None;
    }
    if !install.is_empty() {
        return Some(PathBuf::from(install));
    }
    let u = strip_quotes(uninstall);
    if u.is_empty() {
        return None;
    }
    PathBuf::from(u).parent().map(|p| p.to_path_buf())
}

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 {
        let b = t.as_bytes();
        let quoted = (b[0] == b'"' && b[t.len() - 1] == b'"')
            || (b[0] == b'\'' && b[t.len() - 1] == b'\'');
        if quoted {
            return t[1..t.len() - 1].trim().to_string();
        }
    }
    t.to_string()
}

/// 常见安装路径（exedir 候选；参考 zcode-pool store::client_path_candidates，
/// Windows 文件名不区分大小写，覆盖 %LOCALAPPDATA%\Programs\ZCode 一项即可）
fn client_exe_candidates() -> Vec<String> {
    match std::env::consts::OS {
        "macos" => vec![
            "/Applications/ZCode.app/Contents/MacOS/ZCode".to_string(),
            format!(
                "{}/Applications/ZCode.app/Contents/MacOS/ZCode",
                std::env::var("HOME").unwrap_or_default()
            ),
            "/usr/local/bin/zcode".to_string(),
        ],
        "windows" => vec![
            r"C:\Program Files\ZCode\ZCode.exe".to_string(),
            std::env::var("LOCALAPPDATA")
                .map(|l| format!(r"{l}\Programs\ZCode\ZCode.exe"))
                .unwrap_or_default(),
        ],
        _ => vec![
            "/usr/local/bin/zcode".to_string(),
            "/usr/bin/zcode".to_string(),
            "/opt/ZCode/zcode".to_string(),
            format!(
                "{}/.local/bin/zcode",
                std::env::var("HOME").unwrap_or_default()
            ),
        ],
    }
}

/// 安装目录 → resources/glm/zcode.cjs（安装目录本身与其上一级都试，
/// 兼容 exe 落在 bin/ 之类子目录的布局）
fn cjs_in_dir(dir: &Path) -> Option<PathBuf> {
    let rel = Path::new("resources").join("glm").join("zcode.cjs");
    let here = dir.join(&rel);
    if here.is_file() {
        return Some(here);
    }
    if let Some(up) = dir.parent() {
        let there = up.join(&rel);
        if there.is_file() {
            return Some(there);
        }
    }
    None
}

// 同 quota.rs 的同名私有助手：Windows 下拉起子进程不闪控制台窗口
#[cfg(windows)]
fn no_window(prog: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(prog);
    c.creation_flags(0x0800_0000);
    c
}
#[cfg(not(windows))]
fn no_window(prog: &str) -> std::process::Command {
    std::process::Command::new(prog)
}

fn is_zcode_display_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.contains("zcode") && !l.contains("switch")
}

// ===== 校验 =====

fn validate(blocks: &[Value]) -> Result<(), String> {
    if blocks.len() != 2 {
        return Err(format!("block 数应为 2，实为 {}", blocks.len()));
    }
    let mut texts: Vec<String> = Vec::with_capacity(2);
    for (i, b) in blocks.iter().enumerate() {
        let o = b.as_object().ok_or(format!("block {i} 不是对象"))?;
        if o.get("type").and_then(Value::as_str) != Some("text") {
            return Err(format!("block {i} 的 type 不是 \"text\""));
        }
        let t = o
            .get("text")
            .and_then(Value::as_str)
            .ok_or(format!("block {i} 缺 text 字符串"))?;
        let cc = o
            .get("cache_control")
            .and_then(Value::as_object)
            .and_then(|c| c.get("type"))
            .and_then(Value::as_str);
        if cc != Some("ephemeral") {
            return Err(format!("block {i} 的 cache_control.type 不是 \"ephemeral\""));
        }
        texts.push(t.to_string());
    }

    if texts[0] != PROMPT_PREFIX {
        return Err(format!(
            "block0 不等于固定前缀（实得 {} 字符）",
            texts[0].chars().count()
        ));
    }

    for (i, t) in texts.iter().enumerate() {
        for pat in ["undefined", "[object", "${", ",,"] {
            if t.contains(pat) {
                return Err(format!("block{i} 含污染特征 {pat:?}（疑似静默降级）"));
            }
        }
    }

    if !texts[1].trim_start().starts_with(IDENTITY_PREFIX) {
        let head: String = texts[1].trim_start().chars().take(40).collect();
        return Err(format!("block1 不以身份段开头（实得 {head:?}）"));
    }
    let l1 = texts[1].chars().count();
    if !(800..=8000).contains(&l1) {
        return Err(format!("block1 长度 {l1} 不在 [800,8000]"));
    }
    Ok(())
}

// ===== 极小 JS 求值器 =====
// 只需要看懂 zcode.cjs 里两个 section 构造函数能触达的那部分语法：
// 字符串/模板串/数组/对象字面量、三元、短路、四则与比较、标识符的全局回溯解析
// （esbuild 改名后的 function 声明与顶层赋值）、少量内置方法。其余语法一律报错，
// 反正真正被解析的只有锚点函数体和被回溯解析到的定义，bundle 顶层代码从不进入解析器。

type NR = Rc<Node>;
type Scope = Rc<RefCell<HashMap<String, Val>>>;

#[derive(Clone)]
enum Val {
    Null,
    Bool(bool),
    Num(f64),
    Str(Rc<str>),
    Arr(Rc<RefCell<Vec<Val>>>),
    Obj(Rc<ObjVal>),
    Set(Rc<Vec<String>>),
    Func(Rc<FuncDef>),
}

impl Val {
    fn str(s: &str) -> Val {
        Val::Str(Rc::from(s))
    }
}

struct ObjVal {
    pairs: RefCell<Vec<(String, Deferred)>>,
}

enum Deferred {
    Done(Val),
    Pending { node: NR, scope: Scope },
    Placeholder,
}

struct FuncDef {
    params: Vec<(String, Option<NR>)>,
    body: Vec<Stmt>,
}

fn val_to_string(v: Val) -> String {
    match v {
        Val::Null => String::new(),
        Val::Bool(true) => "true".to_string(),
        Val::Bool(false) => "false".to_string(),
        Val::Num(n) => num_to_string(n),
        Val::Str(s) => s.to_string(),
        _ => String::new(),
    }
}

fn num_to_string(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn truthy(v: &Val) -> bool {
    match v {
        Val::Null => false,
        Val::Bool(b) => *b,
        Val::Num(n) => *n != 0.0 && !n.is_nan(),
        Val::Str(s) => !s.is_empty(),
        Val::Arr(a) => !a.borrow().is_empty(),
        Val::Obj(o) => !o.pairs.borrow().is_empty(),
        _ => true,
    }
}

fn strict_eq(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Null, Val::Null) => true,
        (Val::Bool(x), Val::Bool(y)) => x == y,
        (Val::Num(x), Val::Num(y)) => x == y,
        (Val::Str(x), Val::Str(y)) => x == y,
        _ => false,
    }
}

fn loose_eq(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Bool(x), Val::Num(y)) | (Val::Num(y), Val::Bool(x)) => {
            (*x as i32 as f64) == *y
        }
        _ => strict_eq(a, b),
    }
}

#[derive(Clone)]
enum Tok {
    Str(String),
    Tpl(Vec<TplPart>),
    Num(f64),
    Ident(String),
    Punct(String),
    Eof,
}

#[derive(Clone)]
enum TplPart {
    S(String),
    E(NR),
}

struct Lexer {
    src: Rc<str>,
    i: usize,
    n: usize,
}

impl Lexer {
    fn new(src: Rc<str>) -> Lexer {
        let n = src.len();
        Lexer { src, i: 0, n }
    }

    fn skip_ws(&mut self) -> Result<(), String> {
        let src = self.src.clone();
        let b = src.as_bytes();
        while self.i < self.n {
            let c = b[self.i];
            if c == b' ' || c == b'\t' || c == b'\r' || c == b'\n' {
                self.i += 1;
                continue;
            }

            if c == 0xEF && self.i + 2 < self.n && b[self.i + 1] == 0xBB && b[self.i + 2] == 0xBF
            {
                self.i += 3;
                continue;
            }
            if c == b'/' && self.i + 1 < self.n {
                if b[self.i + 1] == b'/' {
                    match self.src[self.i..].find('\n') {
                        Some(k) => {
                            self.i += k;
                            continue;
                        }
                        None => {
                            self.i = self.n;
                            continue;
                        }
                    }
                }
                if b[self.i + 1] == b'*' {
                    match self.src[self.i + 2..].find("*/") {
                        Some(k) => {
                            self.i += 2 + k + 2;
                            continue;
                        }
                        None => return Err("未闭合的块注释".to_string()),
                    }
                }
            }
            return Ok(());
        }
        Ok(())
    }

    fn next(&mut self) -> Result<Tok, String> {
        self.skip_ws()?;
        if self.i >= self.n {
            return Ok(Tok::Eof);
        }
        let src = self.src.clone();
        let b = src.as_bytes();
        let c = b[self.i];

        if c == b'"' || c == b'\'' {
            let q = c;
            let mut j = self.i + 1;
            while j < self.n {
                if b[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if b[j] == q {
                    break;
                }
                j += 1;
            }
            if j >= self.n {
                return Err("未闭合的字符串字面量".to_string());
            }
            let raw = &self.src[self.i + 1..j];
            self.i = j + 1;
            return Ok(Tok::Str(js_unescape(raw.as_bytes())));
        }

        if c == b'`' {
            let (parts, ni) = read_template(&self.src, self.i)?;
            self.i = ni;
            return Ok(Tok::Tpl(parts));
        }

        if c.is_ascii_digit() || (c == b'.' && self.i + 1 < self.n && b[self.i + 1].is_ascii_digit())
        {
            let mut j = self.i;
            while j < self.n
                && (b[j].is_ascii_digit()
                    || matches!(
                        b[j],
                        b'.' | b'e'
                            | b'E'
                            | b'x'
                            | b'X'
                            | b'a'..=b'd'
                            | b'A'..=b'D'
                            | b'f'
                            | b'F'
                    ))
            {
                j += 1;
            }
            let raw = &self.src[self.i..j];
            self.i = j;
            return Ok(Tok::Num(parse_num(raw)));
        }

        if is_ident_start(c) {
            let mut j = self.i;
            while j < self.n && is_ident_byte(b[j]) {
                j += 1;
            }
            let name = self.src[self.i..j].to_string();
            self.i = j;
            return Ok(Tok::Ident(name));
        }

        let rest = &self.src[self.i..];
        for p in ["===", "!==", "...", "**="] {
            if rest.starts_with(p) {
                self.i += p.len();
                return Ok(Tok::Punct(p.to_string()));
            }
        }
        for p in ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "**", "+=", "-="] {
            if rest.starts_with(p) {
                self.i += p.len();
                return Ok(Tok::Punct(p.to_string()));
            }
        }
        if b"()[]{},;:?.+-*/%<>=!&|^~".contains(&c) {
            self.i += 1;
            return Ok(Tok::Punct((c as char).to_string()));
        }
        Err(format!("无法识别的字符 {:?} @{}", c as char, self.i))
    }
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

fn parse_num(raw: &str) -> f64 {
    if let Some(h) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        i64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(f64::NAN)
    } else {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    }
}

fn js_unescape(s: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let n = s.len();
    let mut i = 0;
    while i < n {
        let c = s[i];
        if c != b'\\' {
            out.push(c);
            i += 1;
            continue;
        }
        i += 1;
        if i >= n {
            break;
        }
        let e = s[i];
        match e {
            b'n' => {
                out.push(b'\n');
                i += 1;
            }
            b'r' => {
                out.push(b'\r');
                i += 1;
            }
            b't' => {
                out.push(b'\t');
                i += 1;
            }
            b'b' => {
                out.push(0x08);
                i += 1;
            }
            b'f' => {
                out.push(0x0C);
                i += 1;
            }
            b'v' => {
                out.push(0x0B);
                i += 1;
            }
            b'0' => {
                out.push(0);
                i += 1;
            }
            b'u' => {
                if i + 1 < n && s[i + 1] == b'{' {
                    if let Some(close) = s[i + 2..].iter().position(|&x| x == b'}') {
                        let hex = std::str::from_utf8(&s[i + 2..i + 2 + close]).unwrap_or("");
                        push_codepoint(&mut out, u32::from_str_radix(hex, 16).unwrap_or(0xFFFD));
                        i = i + 2 + close + 1;
                    } else {
                        i += 1;
                    }
                } else {
                    let hex = std::str::from_utf8(&s[i + 1..(i + 5).min(n)]).unwrap_or("");
                    push_codepoint(&mut out, u32::from_str_radix(hex, 16).unwrap_or(0xFFFD));
                    i += 5;
                }
            }
            b'x' => {
                let hex = std::str::from_utf8(&s[i + 1..(i + 3).min(n)]).unwrap_or("");
                push_codepoint(&mut out, u32::from_str_radix(hex, 16).unwrap_or(0xFFFD));
                i += 3;
            }
            b'\r' | b'\n' => {
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn push_codepoint(out: &mut Vec<u8>, cp: u32) {
    if let Some(ch) = char::from_u32(cp) {
        let mut buf = [0u8; 4];
        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
    }
}

fn skip_string(src: &str, i: usize) -> Result<usize, String> {
    let b = src.as_bytes();
    let n = b.len();
    let q = b[i];
    let mut j = i + 1;
    while j < n {
        let c = b[j];
        if c == b'\\' {
            j += 2;
            continue;
        }
        if q == b'`' && c == b'$' && j + 1 < n && b[j + 1] == b'{' {
            let close = match_close(src, j + 1)?;
            j = close + 1;
            continue;
        }
        if c == q {
            return Ok(j + 1);
        }
        j += 1;
    }
    Err("未闭合的字符串字面量".to_string())
}

fn match_close(src: &str, i: usize) -> Result<usize, String> {
    let b = src.as_bytes();
    let n = b.len();
    if i >= n || b[i] != b'{' {
        return Err("match_close 期望 '{'".to_string());
    }
    let mut depth = 0i32;
    let mut j = i;
    while j < n {
        let c = b[j];
        if c == b'"' || c == b'\'' || c == b'`' {
            j = skip_string(src, j)?;
            continue;
        }
        if c == b'/' && j + 1 < n {
            if b[j + 1] == b'/' {
                match src[j..].find('\n') {
                    Some(k) => {
                        j += k;
                        continue;
                    }
                    None => return Err("未闭合的块".to_string()),
                }
            }
            if b[j + 1] == b'*' {
                match src[j + 2..].find("*/") {
                    Some(k) => {
                        j += k + 4;
                        continue;
                    }
                    None => return Err("未闭合的块注释".to_string()),
                }
            }
        }
        if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                return Ok(j);
            }
        }
        j += 1;
    }
    Err("花括号未闭合".to_string())
}

fn read_template(src: &str, i: usize) -> Result<(Vec<TplPart>, usize), String> {
    let b = src.as_bytes();
    let n = b.len();
    let mut j = i + 1;
    let mut parts: Vec<TplPart> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    while j < n {
        let c = b[j];
        if c == b'\\' {
            buf.extend_from_slice(&b[j..(j + 2).min(n)]);
            j += 2;
            continue;
        }
        if c == b'`' {
            parts.push(TplPart::S(js_unescape(&buf)));
            return Ok((parts, j + 1));
        }
        if c == b'$' && j + 1 < n && b[j + 1] == b'{' {
            if !buf.is_empty() {
                parts.push(TplPart::S(js_unescape(&buf)));
                buf.clear();
            }
            let close = match_close(src, j + 1)?;
            let inner = &src[j + 2..close];
            let node = parse_expr_src(inner, true)?;
            parts.push(TplPart::E(node));
            j = close + 1;
            continue;
        }
        buf.push(c);
        j += 1;
    }
    Err("未闭合的模板字面量".to_string())
}

enum ArrE {
    Elem(NR),
    Spread(NR),
}

enum Node {
    Str(String),
    Tpl(Vec<TplPart>),
    Num(f64),
    Bool(bool),
    Null,
    Ident(String),
    Arr(Vec<ArrE>),
    Obj(Vec<(String, NR)>),
    Mem(NR, String),
    Index(NR, NR),
    Call(NR, Vec<NR>),
    New(NR, Vec<NR>),
    Ternary(NR, NR, NR),
    Bin(String, NR, NR),
    Un(String, NR),
    Seq(Vec<NR>),
    Assign(NR, NR),
}

enum Stmt {
    Block(Vec<Stmt>),
    Empty,
    Decl(Vec<(String, Option<NR>)>),
    Return(Option<NR>),
    If(NR, Box<Stmt>, Option<Box<Stmt>>),
    Expr(NR),
}

struct P {
    lx: Lexer,
    buf: Vec<Tok>,
    i: usize,
}

impl P {
    fn new(src: Rc<str>) -> P {
        P {
            lx: Lexer::new(src),
            buf: Vec::new(),
            i: 0,
        }
    }

    fn ensure(&mut self, k: usize) -> Result<(), String> {
        let need = self.i + k + 1;
        while self.buf.len() < need {
            let t = self.lx.next()?;
            self.buf.push(t);
        }
        Ok(())
    }

    fn peek(&mut self, k: usize) -> Result<Tok, String> {
        self.ensure(k)?;
        Ok(self.buf[self.i + k].clone())
    }

    fn next_tok(&mut self) -> Result<Tok, String> {
        self.ensure(0)?;
        let t = self.buf[self.i].clone();
        self.i += 1;
        Ok(t)
    }

    fn is_punct(&mut self, v: &str) -> Result<bool, String> {
        Ok(matches!(self.peek(0)?, Tok::Punct(p) if p == v))
    }

    fn is_ident(&mut self, v: &str) -> Result<bool, String> {
        Ok(matches!(self.peek(0)?, Tok::Ident(n) if n == v))
    }

    fn eat_punct(&mut self, v: &str) -> Result<bool, String> {
        if self.is_punct(v)? {
            self.i += 1;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn expect_punct(&mut self, v: &str) -> Result<(), String> {
        let t = self.next_tok()?;
        if matches!(&t, Tok::Punct(p) if p == v) {
            Ok(())
        } else {
            Err(format!("期望 {v:?}，实到 {}", tok_desc(&t)))
        }
    }
}

fn tok_desc(t: &Tok) -> String {
    match t {
        Tok::Str(s) => format!("字符串{:?}", s.chars().take(20).collect::<String>()),
        Tok::Tpl(_) => "模板串".to_string(),
        Tok::Num(n) => format!("数字{n}"),
        Tok::Ident(s) => format!("标识符{s}"),
        Tok::Punct(s) => format!("标点{s}"),
        Tok::Eof => "结束".to_string(),
    }
}

fn parse_expr_src(src: &str, no_comma: bool) -> Result<NR, String> {
    let mut p = P::new(Rc::from(src));
    let (node, _) = parse_expr(&mut p, no_comma)?;
    Ok(node)
}

fn parse_expr(p: &mut P, no_comma: bool) -> Result<(NR, usize), String> {
    if no_comma {
        let n = parse_assign(p)?;
        return Ok((n, p.i));
    }
    let node = parse_assign(p)?;
    if p.is_punct(",")? {
        let mut items = vec![node];
        while p.eat_punct(",")? {
            items.push(parse_assign(p)?);
        }
        return Ok((Rc::new(Node::Seq(items)), p.i));
    }
    Ok((node, p.i))
}

fn parse_assign(p: &mut P) -> Result<NR, String> {
    let left = parse_ternary(p)?;
    if p.is_punct("=")? {
        p.next_tok()?;
        let value = parse_assign(p)?;
        return Ok(Rc::new(Node::Assign(left, value)));
    }
    if p.is_punct("+=")? || p.is_punct("-=")? {
        let op = match p.next_tok()? {
            Tok::Punct(op) => op,
            _ => unreachable!(),
        };
        let value = parse_assign(p)?;
        return Ok(Rc::new(Node::Assign(
            left.clone(),
            Rc::new(Node::Bin(op[..1].to_string(), left, value)),
        )));
    }
    Ok(left)
}

fn parse_ternary(p: &mut P) -> Result<NR, String> {
    let cond = parse_binary(p)?;
    if p.eat_punct("?")? {
        let a = parse_assign(p)?;
        p.expect_punct(":")?;
        let b = parse_assign(p)?;
        return Ok(Rc::new(Node::Ternary(cond, a, b)));
    }
    Ok(cond)
}

fn binary_level<F>(p: &mut P, sub: F, ops: &[&str]) -> Result<NR, String>
where
    F: Fn(&mut P) -> Result<NR, String>,
{
    let mut left = sub(p)?;
    loop {
        let t = p.peek(0)?;
        if let Tok::Punct(v) = &t {
            if ops.contains(&v.as_str()) {
                let v = v.clone();
                p.next_tok()?;
                let right = sub(p)?;
                left = Rc::new(Node::Bin(v, left, right));
                continue;
            }
        }
        return Ok(left);
    }
}

fn parse_binary(p: &mut P) -> Result<NR, String> {
    binary_level(p, parse_eq, &["??", "||", "&&"])
}
fn parse_eq(p: &mut P) -> Result<NR, String> {
    binary_level(p, parse_rel, &["===", "!=", "==", "!="])
}
fn parse_rel(p: &mut P) -> Result<NR, String> {
    binary_level(p, parse_add, &["<=", ">=", "<", ">"])
}
fn parse_add(p: &mut P) -> Result<NR, String> {
    binary_level(p, parse_mul, &["+", "-"])
}
fn parse_mul(p: &mut P) -> Result<NR, String> {
    binary_level(p, parse_unary, &["*", "/", "%"])
}

fn parse_unary(p: &mut P) -> Result<NR, String> {
    let t = p.peek(0)?;
    match &t {
        Tok::Punct(v) if v == "!" || v == "-" || v == "+" => {
            let v = v.clone();
            p.next_tok()?;
            Ok(Rc::new(Node::Un(v, parse_unary(p)?)))
        }
        Tok::Ident(v) if v == "void" || v == "typeof" || v == "delete" => {
            let v = v.clone();
            p.next_tok()?;
            Ok(Rc::new(Node::Un(v, parse_unary(p)?)))
        }
        _ => parse_postfix(p),
    }
}

fn parse_postfix(p: &mut P) -> Result<NR, String> {
    let mut node = parse_primary(p)?;
    loop {
        if p.is_punct(".")? {
            p.next_tok()?;
            match p.next_tok()? {
                Tok::Ident(v) => node = Rc::new(Node::Mem(node, v)),
                other => return Err(format!("成员访问期望标识符，实到 {}", tok_desc(&other))),
            }
        } else if p.is_punct("[")? {
            p.next_tok()?;
            let (idx, _) = parse_expr(p, true)?;
            p.expect_punct("]")?;
            node = Rc::new(Node::Index(node, idx));
        } else if p.is_punct("(")? {
            let args = parse_args(p)?;
            node = Rc::new(Node::Call(node, args));
        } else {
            return Ok(node);
        }
    }
}

fn parse_args(p: &mut P) -> Result<Vec<NR>, String> {
    p.expect_punct("(")?;
    let mut args = Vec::new();
    if p.eat_punct(")")? {
        return Ok(args);
    }
    loop {
        args.push(parse_assign(p)?);
        if p.eat_punct(",")? {
            continue;
        }
        p.expect_punct(")")?;
        return Ok(args);
    }
}

fn parse_primary(p: &mut P) -> Result<NR, String> {
    let t = p.peek(0)?;
    match t {
        Tok::Str(v) => {
            p.next_tok()?;
            Ok(Rc::new(Node::Str(v)))
        }
        Tok::Tpl(v) => {
            p.next_tok()?;
            Ok(Rc::new(Node::Tpl(v)))
        }
        Tok::Num(v) => {
            p.next_tok()?;
            Ok(Rc::new(Node::Num(v)))
        }
        Tok::Ident(v) => match v.as_str() {
            "true" => {
                p.next_tok()?;
                Ok(Rc::new(Node::Bool(true)))
            }
            "false" => {
                p.next_tok()?;
                Ok(Rc::new(Node::Bool(false)))
            }
            "null" | "undefined" => {
                p.next_tok()?;
                Ok(Rc::new(Node::Null))
            }
            "new" => {
                p.next_tok()?;
                let callee = parse_postfix(p)?;
                match &*callee {
                    Node::Call(c, a) => Ok(Rc::new(Node::New(c.clone(), a.clone()))),
                    _ => Err("不支持的无参 new".to_string()),
                }
            }
            "this" => Err("不支持 this".to_string()),
            "function" => Err("不支持内联 function 表达式".to_string()),
            _ => {
                p.next_tok()?;
                Ok(Rc::new(Node::Ident(v)))
            }
        },
        Tok::Punct(v) => match v.as_str() {
            "(" => {
                p.next_tok()?;
                let (node, _) = parse_expr(p, false)?;
                p.expect_punct(")")?;
                Ok(node)
            }
            "[" => parse_array(p),
            "{" => parse_object(p),
            _ => Err(format!("无法解析的 primary token：{v:?}")),
        },
        Tok::Eof => Err("表达式意外结束".to_string()),
    }
}

fn parse_array(p: &mut P) -> Result<NR, String> {
    p.expect_punct("[")?;
    let mut elems: Vec<ArrE> = Vec::new();
    if p.eat_punct("]")? {
        return Ok(Rc::new(Node::Arr(elems)));
    }
    loop {
        if p.is_punct(",")? {
            // 稀疏数组的洞近似成空串（目标代码里不会出现，仅兜底）
            elems.push(ArrE::Elem(Rc::new(Node::Str(String::new()))));
        } else if p.is_punct("...")? {
            p.next_tok()?;
            elems.push(ArrE::Spread(parse_assign(p)?));
        } else {
            elems.push(ArrE::Elem(parse_assign(p)?));
        }
        if p.eat_punct(",")? {
            if p.is_punct("]")? {
                break;
            }
            continue;
        }
        break;
    }
    p.expect_punct("]")?;
    Ok(Rc::new(Node::Arr(elems)))
}

fn parse_object(p: &mut P) -> Result<NR, String> {
    p.expect_punct("{")?;
    let mut pairs: Vec<(String, NR)> = Vec::new();
    if p.eat_punct("}")? {
        return Ok(Rc::new(Node::Obj(pairs)));
    }
    loop {
        let t = p.next_tok()?;
        if matches!(&t, Tok::Punct(v) if v == "...") {
            return Err("不支持对象展开".to_string());
        }
        let key: String;
        let shorthand: Option<String>;
        match &t {
            Tok::Ident(v) => {
                key = v.clone();
                shorthand = Some(v.clone());
            }
            Tok::Str(v) => {
                key = v.clone();
                shorthand = None;
            }
            Tok::Num(v) => {
                key = num_to_string(*v);
                shorthand = None;
            }
            other => return Err(format!("对象键非法：{}", tok_desc(other))),
        }
        let val = if p.is_punct(":")? {
            p.next_tok()?;
            parse_assign(p)?
        } else {
            // 简写键 {content} 等价 {content: content}
            match shorthand {
                Some(n) => Rc::new(Node::Ident(n)),
                None => return Err("对象简写键非法".to_string()),
            }
        };
        pairs.push((key, val));
        if p.eat_punct(",")? {
            if p.is_punct("}")? {
                break;
            }
            continue;
        }
        break;
    }
    p.expect_punct("}")?;
    Ok(Rc::new(Node::Obj(pairs)))
}

fn parse_block_stmts(p: &mut P) -> Result<Vec<Stmt>, String> {
    p.expect_punct("{")?;
    let mut stmts = Vec::new();
    while !p.is_punct("}")? {
        if matches!(p.peek(0)?, Tok::Eof) {
            return Err("语句块未闭合".to_string());
        }
        stmts.push(parse_stmt(p)?);
    }
    p.expect_punct("}")?;
    Ok(stmts)
}

fn parse_stmt(p: &mut P) -> Result<Stmt, String> {
    if p.is_punct("{")? {
        return Ok(Stmt::Block(parse_block_stmts(p)?));
    }
    if p.is_punct(";")? {
        p.next_tok()?;
        return Ok(Stmt::Empty);
    }
    if p.is_ident("let")? || p.is_ident("var")? || p.is_ident("const")? {
        p.next_tok()?;
        let mut decls = Vec::new();
        loop {
            let name = match p.next_tok()? {
                Tok::Ident(n) => n,
                _ => return Err("声明期望标识符".to_string()),
            };
            let init = if p.is_punct("=")? {
                p.next_tok()?;
                Some(parse_assign(p)?)
            } else {
                None
            };
            decls.push((name, init));
            if p.eat_punct(",")? {
                continue;
            }
            break;
        }
        p.eat_punct(";")?;
        return Ok(Stmt::Decl(decls));
    }
    if p.is_ident("return")? {
        p.next_tok()?;
        if p.is_punct(";")? || p.is_punct("}")? {
            p.eat_punct(";")?;
            return Ok(Stmt::Return(None));
        }
        let (node, _) = parse_expr(p, false)?;
        p.eat_punct(";")?;
        return Ok(Stmt::Return(Some(node)));
    }
    if p.is_ident("if")? {
        p.next_tok()?;
        p.expect_punct("(")?;
        let (cond, _) = parse_expr(p, false)?;
        p.expect_punct(")")?;
        let cons = Box::new(parse_stmt(p)?);
        let alt = if p.is_ident("else")? {
            p.next_tok()?;
            Some(Box::new(parse_stmt(p)?))
        } else {
            None
        };
        return Ok(Stmt::If(cond, cons, alt));
    }
    if p.is_ident("throw")? {
        return Err("不支持 throw".to_string());
    }
    let (node, _) = parse_expr(p, false)?;
    p.eat_punct(";")?;
    Ok(Stmt::Expr(node))
}

struct Ev {
    src: Rc<str>,
    globals: HashMap<String, Val>,
    funcs: HashMap<String, Rc<FuncDef>>,
    in_progress: HashSet<String>,
}

impl Ev {
    fn new(src: Rc<str>) -> Ev {
        Ev {
            src,
            globals: HashMap::new(),
            funcs: HashMap::new(),
            in_progress: HashSet::new(),
        }
    }

    fn build_section(&mut self, anchor: &str, args: &[Val]) -> Result<Val, String> {
        let fidx = find_builder_function(&self.src, anchor)?;
        let f = Rc::new(parse_function_at(&self.src, fidx)?);
        self.call_function(&f, args.to_vec())
            .map_err(|e| format!("构造 section {anchor} 失败：{e}"))
    }

    fn find_function_idx(&self, name: &str) -> Option<usize> {
        let b = self.src.as_bytes();
        let n = b.len();
        let mut from = 0usize;
        while let Some(rel) = self.src[from..].find("function") {
            let p = from + rel;
            let prev_ok = p == 0 || (!is_ident_byte(b[p - 1]) && b[p - 1] != b'.');
            if prev_ok {
                let mut k = p + "function".len();
                while k < n && b[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k > p + "function".len() && self.src[k..].starts_with(name) {
                    let mut m = k + name.len();
                    // 名字必须完整（后面不能还是标识符字符），再往后跳过空白须是 '('
                    if m >= n || !is_ident_byte(b[m]) {
                        while m < n && b[m].is_ascii_whitespace() {
                            m += 1;
                        }
                        if m < n && b[m] == b'(' {
                            return Some(p);
                        }
                    }
                }
            }
            from = p + "function".len();
        }
        None
    }

    fn find_assignment(&self, name: &str) -> Option<usize> {
        let b = self.src.as_bytes();
        let n = b.len();
        let mut from = 0usize;
        while let Some(rel) = self.src[from..].find(name) {
            let p = from + rel;
            let prev_ok = p == 0 || (!is_ident_byte(b[p - 1]) && b[p - 1] != b'.');
            if prev_ok {
                let mut q = p + name.len();
                while q < n && b[q].is_ascii_whitespace() {
                    q += 1;
                }
                if q < n
                    && b[q] == b'='
                    && (q + 1 >= n || (b[q + 1] != b'=' && b[q + 1] != b'>'))
                {
                    return Some(q + 1);
                }
            }
            from = p + name.len();
        }
        None
    }

    fn resolve_global(&mut self, name: &str) -> Result<Val, String> {
        if let Some(v) = self.globals.get(name) {
            return Ok(v.clone());
        }
        if let Some(f) = self.funcs.get(name) {
            return Ok(Val::Func(f.clone()));
        }
        if self.in_progress.contains(name) {
            return Err(format!("全局解析出现循环：{name}"));
        }
        self.in_progress.insert(name.to_string());
        let r = self.resolve_global_inner(name);
        self.in_progress.remove(name);
        r
    }

    fn resolve_global_inner(&mut self, name: &str) -> Result<Val, String> {
        if let Some(fidx) = self.find_function_idx(name) {
            let f = Rc::new(parse_function_at(&self.src, fidx)?);
            self.funcs.insert(name.to_string(), f.clone());
            return Ok(Val::Func(f));
        }
        if let Some(pos) = self.find_assignment(name) {
            // 从 '=' 后面截到文件尾再解析单个表达式，解析器自然停在下一个顶层分隔符
            let sub = self.src[pos..].to_string();
            let node = parse_expr_src(&sub, true)?;
            let scope: Scope = Rc::new(RefCell::new(HashMap::new()));
            let val = self.eval(&node, &scope)?;
            self.globals.insert(name.to_string(), val.clone());
            return Ok(val);
        }
        Err(format!("找不到标识符定义：{name}"))
    }

    fn eval(&mut self, node: &NR, scope: &Scope) -> Result<Val, String> {
        match &**node {
            Node::Str(s) => Ok(Val::str(s)),
            Node::Num(n) => Ok(Val::Num(*n)),
            Node::Bool(b) => Ok(Val::Bool(*b)),
            Node::Null => Ok(Val::Null),
            Node::Tpl(parts) => {
                let mut out = String::new();
                for part in parts {
                    match part {
                        TplPart::S(s) => out.push_str(s),
                        TplPart::E(e) => {
                            let v = self.eval(e, scope)?;
                            out.push_str(&val_to_string(v));
                        }
                    }
                }
                Ok(Val::str(&out))
            }
            Node::Ident(name) => {
                if let Some(v) = scope.borrow().get(name) {
                    return Ok(v.clone());
                }
                self.resolve_global(name)
            }
            Node::Arr(elems) => {
                let mut out: Vec<Val> = Vec::new();
                for el in elems {
                    match el {
                        ArrE::Elem(e) => out.push(self.eval(e, scope)?),
                        ArrE::Spread(e) => match self.eval(e, scope)? {
                            Val::Arr(a) => out.extend(a.borrow().iter().cloned()),
                            other => {
                                return Err(format!("spread 目标不是数组：{}", type_name(&other)))
                            }
                        },
                    }
                }
                Ok(Val::Arr(Rc::new(RefCell::new(out))))
            }
            Node::Obj(pairs) => {
                // 对象属性惰性求值：只在真正被读到时才算（bundle 的 section 对象里
                // 挂着 tokens: estimateTokens(...) 这类我们不需要也求不了的东西）
                let ps: Vec<(String, Deferred)> = pairs
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            Deferred::Pending {
                                node: v.clone(),
                                scope: scope.clone(),
                            },
                        )
                    })
                    .collect();
                Ok(Val::Obj(Rc::new(ObjVal {
                    pairs: RefCell::new(ps),
                })))
            }
            Node::Mem(obj, prop) => {
                let o = self.eval(obj, scope)?;
                self.get_prop(&o, prop)
            }
            Node::Index(obj, idx) => {
                let o = self.eval(obj, scope)?;
                let i = self.eval(idx, scope)?;
                match (o, i) {
                    (Val::Arr(a), Val::Num(n)) => {
                        let a = a.borrow();
                        let k = n as usize;
                        a.get(k).cloned().ok_or_else(|| "数组下标越界".to_string())
                    }
                    (o, i) => self.get_prop(&o, &val_to_string(i)),
                }
            }
            Node::Call(callee, args) => self.eval_call(callee, args, scope),
            Node::New(callee, args) => {
                let vals: Result<Vec<Val>, String> =
                    args.iter().map(|a| self.eval(a, scope)).collect();
                let vals = vals?;
                if let Node::Ident(n) = &**callee {
                    if n == "Set" {
                        let items = match vals.into_iter().next() {
                            Some(Val::Arr(a)) => {
                                a.borrow().iter().map(|v| val_to_string(v.clone())).collect()
                            }
                            _ => Vec::new(),
                        };
                        return Ok(Val::Set(Rc::new(items)));
                    }
                }
                Err("不支持的 new 目标".to_string())
            }
            Node::Ternary(c, a, b) => {
                let cond = self.eval(c, scope)?;
                if truthy(&cond) {
                    self.eval(a, scope)
                } else {
                    self.eval(b, scope)
                }
            }
            Node::Bin(op, a, b) => self.eval_bin(op, a, b, scope),
            Node::Un(op, a) => {
                let v = self.eval(a, scope)?;
                match op.as_str() {
                    "!" => Ok(Val::Bool(!truthy(&v))),
                    "-" => match v {
                        Val::Num(n) => Ok(Val::Num(-n)),
                        _ => Err("一元 - 作用在非数字".to_string()),
                    },
                    "+" => match v {
                        Val::Num(n) => Ok(Val::Num(n)),
                        _ => Err("一元 + 作用在非数字".to_string()),
                    },
                    "void" => Ok(Val::Null),
                    other => Err(format!("不支持的一元运算符 {other}")),
                }
            }
            Node::Seq(items) => {
                let mut val = Val::Null;
                for it in items {
                    val = self.eval(it, scope)?;
                }
                Ok(val)
            }
            Node::Assign(target, value) => {
                if let Node::Ident(name) = &**target {
                    let v = self.eval(value, scope)?;
                    scope.borrow_mut().insert(name.clone(), v.clone());
                    return Ok(v);
                }
                Err("不支持的赋值目标".to_string())
            }
        }
    }

    fn eval_bin(&mut self, op: &str, a: &NR, b: &NR, scope: &Scope) -> Result<Val, String> {
        match op {
            "&&" => {
                let l = self.eval(a, scope)?;
                return if truthy(&l) { self.eval(b, scope) } else { Ok(l) };
            }
            "||" => {
                let l = self.eval(a, scope)?;
                return if truthy(&l) { Ok(l) } else { self.eval(b, scope) };
            }
            "??" => {
                let l = self.eval(a, scope)?;
                return if matches!(l, Val::Null) {
                    self.eval(b, scope)
                } else {
                    Ok(l)
                };
            }
            _ => {}
        }
        let x = self.eval(a, scope)?;
        let y = self.eval(b, scope)?;
        match op {
            "===" => Ok(Val::Bool(strict_eq(&x, &y))),
            "!==" => Ok(Val::Bool(!strict_eq(&x, &y))),
            "==" => Ok(Val::Bool(loose_eq(&x, &y))),
            "!=" => Ok(Val::Bool(!loose_eq(&x, &y))),
            "<" | "<=" | ">" | ">=" => {
                let (nx, ny) = (as_num(&x), as_num(&y));
                let r = match op {
                    "<" => nx < ny,
                    "<=" => nx <= ny,
                    ">" => nx > ny,
                    _ => nx >= ny,
                };
                Ok(Val::Bool(r))
            }
            "+" => {
                if matches!(x, Val::Str(_)) || matches!(y, Val::Str(_)) {
                    Ok(Val::str(&format!(
                        "{}{}",
                        val_to_string(x),
                        val_to_string(y)
                    )))
                } else {
                    Ok(Val::Num(as_num(&x) + as_num(&y)))
                }
            }
            "-" => Ok(Val::Num(as_num(&x) - as_num(&y))),
            "*" => Ok(Val::Num(as_num(&x) * as_num(&y))),
            "/" => Ok(Val::Num(as_num(&x) / as_num(&y))),
            "%" => Ok(Val::Num(as_num(&x) % as_num(&y))),
            other => Err(format!("不支持的二元运算符 {other}")),
        }
    }

    fn eval_call(&mut self, callee: &NR, args: &[NR], scope: &Scope) -> Result<Val, String> {
        let vals: Result<Vec<Val>, String> = args.iter().map(|a| self.eval(a, scope)).collect();
        let vals = vals?;
        match &**callee {
            Node::Mem(obj, prop) => {
                let recv = self.eval(obj, scope)?;
                self.call_method(recv, prop, vals)
            }
            Node::Ident(name) => {
                let f = match scope.borrow().get(name) {
                    Some(v) => v.clone(),
                    None => self.resolve_global(name)?,
                };
                match f {
                    Val::Func(fd) => self.call_function(&fd, vals),
                    _ => Err(format!("{name} 不是可调用对象")),
                }
            }
            _ => Err("不支持的调用形式".to_string()),
        }
    }

    fn call_function(&mut self, f: &Rc<FuncDef>, args: Vec<Val>) -> Result<Val, String> {
        let scope: Scope = Rc::new(RefCell::new(HashMap::new()));
        for (i, (pname, pdef)) in f.params.iter().enumerate() {
            let v = if i < args.len() {
                args[i].clone()
            } else if let Some(d) = pdef {
                self.eval(d, &scope)?
            } else {
                Val::Null
            };
            scope.borrow_mut().insert(pname.clone(), v);
        }
        Ok(self.exec_stmts(&f.body, &scope)?.unwrap_or(Val::Null))
    }

    fn exec_stmts(&mut self, stmts: &[Stmt], scope: &Scope) -> Result<Option<Val>, String> {
        for st in stmts {
            match st {
                Stmt::Decl(decls) => {
                    for (name, init) in decls {
                        let v = match init {
                            Some(n) => self.eval(n, scope)?,
                            None => Val::Null,
                        };
                        scope.borrow_mut().insert(name.clone(), v);
                    }
                }
                Stmt::Return(n) => {
                    return Ok(match n {
                        Some(n) => Some(self.eval(n, scope)?),
                        None => None,
                    });
                }
                Stmt::Expr(n) => {
                    self.eval(n, scope)?;
                }
                Stmt::If(cond, cons, alt) => {
                    if truthy(&self.eval(cond, scope)?) {
                        if let Some(r) = self.exec_stmt(cons, scope)? {
                            return Ok(Some(r));
                        }
                    } else if let Some(alt) = alt {
                        if let Some(r) = self.exec_stmt(alt, scope)? {
                            return Ok(Some(r));
                        }
                    }
                }
                Stmt::Block(body) => {
                    if let Some(r) = self.exec_stmts(body, scope)? {
                        return Ok(Some(r));
                    }
                }
                Stmt::Empty => {}
            }
        }
        Ok(None)
    }

    fn exec_stmt(&mut self, st: &Stmt, scope: &Scope) -> Result<Option<Val>, String> {
        match st {
            Stmt::Block(body) => self.exec_stmts(body, scope),
            Stmt::Return(n) => Ok(match n {
                Some(n) => Some(self.eval(n, scope)?),
                None => None,
            }),
            Stmt::Expr(n) => {
                self.eval(n, scope)?;
                Ok(None)
            }
            Stmt::If(cond, cons, alt) => {
                if truthy(&self.eval(cond, scope)?) {
                    self.exec_stmt(cons, scope)
                } else if let Some(alt) = alt {
                    self.exec_stmt(alt, scope)
                } else {
                    Ok(None)
                }
            }
            Stmt::Decl(decls) => {
                for (name, init) in decls {
                    let v = match init {
                        Some(n) => self.eval(n, scope)?,
                        None => Val::Null,
                    };
                    scope.borrow_mut().insert(name.clone(), v);
                }
                Ok(None)
            }
            Stmt::Empty => Ok(None),
        }
    }

    fn get_prop(&mut self, obj: &Val, prop: &str) -> Result<Val, String> {
        match obj {
            Val::Obj(o) => self.obj_get(o, prop),
            Val::Arr(a) if prop == "length" => Ok(Val::Num(a.borrow().len() as f64)),
            Val::Str(s) if prop == "length" => Ok(Val::Num(s.chars().count() as f64)),
            other => Err(format!(
                "无法读取属性 {prop:?}（receiver={}）",
                type_name(other)
            )),
        }
    }

    fn obj_get(&mut self, o: &Rc<ObjVal>, prop: &str) -> Result<Val, String> {
        let d = {
            let mut ps = o.pairs.borrow_mut();
            match ps.iter().position(|(k, _)| k == prop) {
                Some(idx) => std::mem::replace(&mut ps[idx].1, Deferred::Placeholder),
                None => return Err(format!("对象没有属性 {prop:?}")),
            }
        };
        match d {
            Deferred::Done(v) => Ok(v),
            Deferred::Pending { node, scope } => {
                let v = self.eval(&node, &scope)?;
                if let Ok(mut ps) = o.pairs.try_borrow_mut() {
                    if let Some(idx) = ps.iter().position(|(k, _)| k == prop) {
                        ps[idx].1 = Deferred::Done(v.clone());
                    }
                }
                Ok(v)
            }
            Deferred::Placeholder => Err(format!("惰性属性 {prop:?} 求值重入")),
        }
    }

    fn call_method(&mut self, recv: Val, prop: &str, args: Vec<Val>) -> Result<Val, String> {
        match &recv {
            Val::Set(s) if prop == "has" => {
                let needle = args.first().map(|v| val_to_string(v.clone())).unwrap_or_default();
                return Ok(Val::Bool(s.iter().any(|x| *x == needle)));
            }
            Val::Arr(_) if prop == "join" => {
                let sep = args
                    .first()
                    .map(|v| val_to_string(v.clone()))
                    .unwrap_or_else(|| ",".to_string());
                if let Val::Arr(a) = &recv {
                    let parts: Vec<String> =
                        a.borrow().iter().map(|v| val_to_string(v.clone())).collect();
                    return Ok(Val::str(&parts.join(&sep)));
                }
                unreachable!()
            }
            Val::Arr(_) if prop == "push" => {
                if let Val::Arr(a) = &recv {
                    let mut a = a.borrow_mut();
                    a.push(args.into_iter().next().unwrap_or(Val::Null));
                    return Ok(Val::Num(a.len() as f64));
                }
                unreachable!()
            }
            Val::Arr(_) if prop == "slice" => {
                if let Val::Arr(a) = &recv {
                    let a = a.borrow();
                    let start = args.first().map(as_num).unwrap_or(0.0) as i64;
                    let end = args.get(1).map(as_num).unwrap_or(a.len() as f64) as i64;
                    let out: Vec<Val> = slice_range(a.len(), start, end)
                        .into_iter()
                        .map(|i| a[i].clone())
                        .collect();
                    return Ok(Val::Arr(Rc::new(RefCell::new(out))));
                }
                unreachable!()
            }
            Val::Str(s) if prop == "slice" => {
                let chars: Vec<char> = s.chars().collect();
                let start = args.first().map(as_num).unwrap_or(0.0) as i64;
                let end = args.get(1).map(as_num).unwrap_or(chars.len() as f64) as i64;
                let range = slice_range(chars.len(), start, end);
                let out: String = range.into_iter().map(|i| chars[i]).collect();
                return Ok(Val::str(&out));
            }
            Val::Str(s) if prop == "trim" => return Ok(Val::str(s.trim())),
            Val::Str(s) if prop == "replace" => {
                let from = args.first().map(|v| val_to_string(v.clone())).unwrap_or_default();
                let to = args.get(1).map(|v| val_to_string(v.clone())).unwrap_or_default();
                return Ok(Val::str(&s.replace(&from, &to)));
            }
            Val::Str(s) if prop == "startsWith" => {
                let p = args.first().map(|v| val_to_string(v.clone())).unwrap_or_default();
                return Ok(Val::Bool(s.starts_with(&p)));
            }
            _ => {}
        }
        Err(format!(
            "不支持的方法 .{prop}()（receiver={}）",
            type_name(&recv)
        ))
    }
}

fn slice_range(len: usize, start: i64, end: i64) -> Vec<usize> {
    let norm = |v: i64| -> i64 {
        if v < 0 {
            (len as i64 + v).max(0)
        } else {
            v.min(len as i64)
        }
    };
    let s = norm(start);
    let e = norm(end);
    if e <= s {
        Vec::new()
    } else {
        (s..e).map(|i| i as usize).collect()
    }
}

fn as_num(v: &Val) -> f64 {
    match v {
        Val::Num(n) => *n,
        Val::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        _ => f64::NAN,
    }
}

fn type_name(v: &Val) -> &'static str {
    match v {
        Val::Null => "null",
        Val::Bool(_) => "bool",
        Val::Num(_) => "number",
        Val::Str(_) => "string",
        Val::Arr(_) => "array",
        Val::Obj(_) => "object",
        Val::Set(_) => "set",
        Val::Func(_) => "function",
    }
}

/// 锚点（如 `source:"cli_prefix"`）在 bundle 里唯一出现，往前找最近的
/// `function ` 声明头，那就是构造这个 section 的构建函数
fn find_builder_function(src: &str, anchor: &str) -> Result<usize, String> {
    let idx = src
        .find(anchor)
        .ok_or_else(|| format!("找不到锚点：{anchor}"))?;
    if src[idx + 1..].find(anchor).is_some() {
        return Err(format!("锚点不唯一：{anchor}"));
    }
    src[..idx]
        .rfind("function ")
        .ok_or_else(|| format!("锚点之前找不到函数定义：{anchor}"))
}

fn parse_function_at(src: &Rc<str>, i: usize) -> Result<FuncDef, String> {
    let b = src.as_bytes();
    let n = b.len();
    if !src[i..].starts_with("function") {
        return Err(format!("函数头解析失败 @{i}"));
    }
    let mut k = i + "function".len();
    while k < n && b[k].is_ascii_whitespace() {
        k += 1;
    }
    let nstart = k;
    while k < n && is_ident_byte(b[k]) {
        k += 1;
    }
    if k == nstart {
        return Err("函数头解析失败：缺函数名".to_string());
    }
    // 名字只在报错文案里用，但切片必须用绝对下标（nstart/k 都是绝对位置）
    let name = src[nstart..k].to_string();
    while k < n && b[k].is_ascii_whitespace() {
        k += 1;
    }
    if k >= n || b[k] != b'(' {
        return Err(format!("函数 {name} 头解析失败：缺 '('"));
    }
    let pstart = k + 1;
    let mut depth = 1i32;
    let mut j = pstart;
    while j < n && depth > 0 {
        match b[j] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        j += 1;
    }
    let params_raw = &src[pstart..j - 1];
    let params = parse_params(params_raw)?;

    let open = src[j - 1..]
        .find('{')
        .map(|x| j - 1 + x)
        .ok_or_else(|| format!("函数 {name} 体缺 '{{'"))?;
    let end = match_close(src, open)?;
    let body_src = &src[open + 1..end];
    let full: Rc<str> = Rc::from(format!("{{{body_src}}}").as_str());
    let mut p = P::new(full);
    let stmts = parse_block_stmts(&mut p)?;
    Ok(FuncDef {
        params,
        body: stmts,
    })
}

fn parse_params(raw: &str) -> Result<Vec<(String, Option<NR>)>, String> {
    let mut out = Vec::new();
    for piece in split_top_commas(raw) {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        if let Some(eq) = piece.find('=') {
            let (pname, pdef) = piece.split_at(eq);
            let node = parse_expr_src(pdef[1..].trim(), false)?;
            out.push((pname.trim().to_string(), Some(node)));
        } else {
            out.push((piece.to_string(), None));
        }
    }
    Ok(out)
}

fn split_top_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        if c == ',' && depth == 0 {
            out.push(std::mem::take(&mut buf));
        } else {
            buf.push(c);
        }
    }
    out.push(buf);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实 SECURITY_NOTICE（identity.ts 的那条，fixture 里保持逐字一致）
    const NOTICE: &str = "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

    /// 按 zcode.cjs 真实压缩形态搭的最小 bundle：锚点函数 + 顶层赋值 + 回溯解析的帮手函数。
    /// 顶层 `var IJs,gdt=Y(()=>{...})` 这类初始化器从不被解析（锚点法只解析函数体），
    /// 全局量（IJs/mno）靠 find_assignment 从文本回溯取值，帮手函数（CJs/Xmn）靠函数名回溯。
    /// raw string 里保留 `\n` `\u2014` 原样，让 JS 词法层自己解转义。
    fn fixture(cli: &str, notice: &str) -> String {
        let mut s = String::new();
        s.push_str(r##"function hNe(){let e=IJs;return{name:"CLI Prefix",source:"cli_prefix",injectionTarget:"system",cacheHint:"stable",chars:e.length,tokens:wm(e),content:e,preview:e.slice(0,100)}}var IJs,gdt=Y(()=>{"use strict";IJs=""##);
        s.push_str(cli);
        s.push_str(r##"";r(hNe,"buildCliPrefixSection")});
function CJs(e){return[["",e?"You respond to the user according to the active Output Style below while using ZCode's tools and instructions.":"You are an interactive ZCode agent that helps users with software engineering tasks.","",mno].join("\n"),"",Xmn()].join("\n")}
function Qmn(e){let t=CJs(e);return{name:"Agent Identity",source:"identity",injectionTarget:"system",cacheHint:"stable",chars:t.length,tokens:wm(t),content:t,preview:t.slice(0,100)}}var mno,_dt=Y(()=>{mno=""##);
        s.push_str(notice);
        s.push_str(r##"";r(Qmn,"buildIdentitySection")});
function Xmn(){return["# Harness","- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.","- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.","- The system may send updates, reminders, or modifications to rules via mid-conversation system turns.","- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.","- Reference code as `file_path:line_number` \u2014 it's clickable."].join("\n")}"##);
        s
    }

    #[test]
    fn extract_ok_and_shape() {
        let blocks = extract_from_source(&fixture(PROMPT_PREFIX, NOTICE)).expect("应提取成功");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], PROMPT_PREFIX);
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[1]["type"], "text");
        assert_eq!(blocks[1]["cache_control"]["type"], "ephemeral");
        let t1 = blocks[1]["text"].as_str().expect("block1 text");
        assert!(t1.trim_start().starts_with(IDENTITY_PREFIX));
        let n = t1.chars().count();
        assert!((800..=8000).contains(&n), "identity 长度 {n} 应在 [800,8000]");
        // \u2014 转义应被还原成 em dash，而不是留着字面 \u2014
        assert!(t1.contains('\u{2014}'), "身份段应含还原后的 em dash");
    }

    #[test]
    fn extract_prefix_mismatch_fails() {
        let err = extract_from_source(&fixture(
            "You are SomethingElse, an interactive coding agent",
            NOTICE,
        ))
        .unwrap_err();
        assert!(err.contains("block0"), "实际错误：{err}");
    }

    #[test]
    fn extract_pollution_fails() {
        // undefined 混进文本 = 模板插值被静默降级的典型痕迹，必须在本地拦截
        let err = extract_from_source(&fixture(
            PROMPT_PREFIX,
            "IMPORTANT: Assist with undefined tools and ${interpolation}.",
        ))
        .unwrap_err();
        assert!(err.contains("污染"), "实际错误：{err}");
    }

    #[test]
    fn extract_short_identity_fails() {
        // 污染扫描通过但不足 800 字符 → 段长校验兜底
        let err = extract_from_source(&fixture(
            PROMPT_PREFIX,
            "IMPORTANT: Assist with authorized security testing only.",
        ))
        .unwrap_err();
        assert!(err.contains("不在 [800,8000]"), "实际错误：{err}");
    }

    fn two_blocks() -> Vec<Value> {
        vec![
            json!({"type":"text","text":"AAA","cache_control":{"type":"ephemeral"}}),
            json!({"type":"text","text":"BBB","cache_control":{"type":"ephemeral"}}),
        ]
    }

    #[test]
    fn apply_system_string_shape() {
        let mut body = json!({"model":"glm-5.3","max_tokens":100,"system":"用户补充"});
        apply_system(&mut body, &two_blocks());
        let sys = body["system"].as_array().expect("system 应为数组");
        assert_eq!(sys.len(), 3);
        assert_eq!(sys[0]["text"], "AAA");
        assert_eq!(sys[1]["text"], "BBB");
        assert_eq!(sys[2], json!({"type":"text","text":"用户补充"}));
        // 其余字段不动
        assert_eq!(body["model"], "glm-5.3");
        assert_eq!(body["max_tokens"], 100);
    }

    #[test]
    fn apply_system_array_shape() {
        let mut body = json!({"system":[{"type":"text","text":"用户一"},{"type":"text","text":"用户二"}]});
        apply_system(&mut body, &two_blocks());
        let sys = body["system"].as_array().expect("system 应为数组");
        assert_eq!(sys.len(), 4);
        assert_eq!(sys[0]["text"], "AAA");
        assert_eq!(sys[1]["text"], "BBB");
        assert_eq!(sys[2]["text"], "用户一");
        assert_eq!(sys[3]["text"], "用户二");
    }

    #[test]
    fn apply_system_missing_shape() {
        let mut body = json!({"model":"glm-5.3"});
        apply_system(&mut body, &two_blocks());
        let sys = body["system"].as_array().expect("system 应为数组");
        assert_eq!(sys.len(), 2);
        assert_eq!(sys[0]["text"], "AAA");
        assert_eq!(sys[1]["text"], "BBB");
    }

    #[test]
    fn apply_system_blank_string_dropped() {
        // 空白串等价于没给（照搬参考 external_body 的判空）
        let mut body = json!({"system":"   "});
        apply_system(&mut body, &two_blocks());
        assert_eq!(body["system"].as_array().expect("system").len(), 2);
    }

    #[test]
    fn apply_system_non_object_noop() {
        let mut body = json!([1, 2, 3]);
        apply_system(&mut body, &two_blocks());
        assert_eq!(body, json!([1, 2, 3]));
    }
}
