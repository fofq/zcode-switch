//! OpenAI chat.completions ↔ Anthropic /v1/messages 的请求/响应/SSE 翻译。
//! 映射参考 .temp-Antigravity-Manager 的 mappers 与 Anthropic 官方协议；
//! 思考块链路与签名回放缓存参考 .temp-glm-zcode-2api（replay.go/translate.go），
//! GLM-5.3 强制思考参考 .temp-zcode-proxy（fixThinking）。
//!
//! 为什么需要回放缓存：OpenAI 客户端只回显文本与 tool_calls，而 zcode-plan 对
//! glm-5.3 强制开启思考，且工具循环要求 assistant 消息原样回传带 signature 的
//! thinking 块——不注回就会 400。缓存键（Turn/ToolIDs/Thinking）三级兜底，
//! 客户端对空白/args 做过规范化时靠 ToolIDsKey 仍能命中。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

// ===== 签名回放缓存（FIFO 512，无 TTL；仅成功请求写入，命中不消费） =====

struct ReplayInner {
    entries: HashMap<String, Vec<Value>>,
    order: VecDeque<String>,
    limit: usize,
}

pub struct ReplayCache {
    inner: Mutex<ReplayInner>,
}

static REPLAY: OnceLock<ReplayCache> = OnceLock::new();

fn replay() -> &'static ReplayCache {
    REPLAY.get_or_init(|| ReplayCache {
        inner: Mutex::new(ReplayInner { entries: HashMap::new(), order: VecDeque::new(), limit: 512 }),
    })
}

/// SHA-256 前 16 字节 hex，加键族前缀（与 glm-zcode-2api 相同的键形状）。
fn hash_key(prefix: &str, value: &str) -> String {
    let h = Sha256::digest(value.as_bytes());
    let hex: String = h[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}:{hex}")
}

/// "文本 + tool_calls 原文指纹" 键：arguments 用客户端回传的原文（仅 trim）。
pub fn turn_key(text: &str, calls: &[Value]) -> String {
    let mut s = String::from("assistant\x00");
    s.push_str(text);
    for c in calls {
        let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let name = c.pointer("/function/name").and_then(|x| x.as_str()).unwrap_or("");
        let args = c.pointer("/function/arguments").and_then(|x| x.as_str()).unwrap_or("");
        s.push_str("\x00");
        s.push_str(id);
        s.push_str("\x00");
        s.push_str(name);
        s.push_str("\x00");
        s.push_str(args.trim());
    }
    hash_key("msg", &s)
}

/// 仅按 tool_call id 序列的键：客户端重排了 args 空白时的兜底。
pub fn tool_ids_key(calls: &[Value]) -> String {
    if calls.is_empty() {
        return String::new();
    }
    let mut s = String::from("tools\x00");
    for c in calls {
        s.push_str(c.get("id").and_then(|x| x.as_str()).unwrap_or(""));
        s.push('\0');
    }
    hash_key("tools", &s)
}

/// reasoning_content 文本键：客户端把思考文本回显回来时的兜底。
pub fn thinking_key(thinking: &str) -> String {
    hash_key("think", thinking)
}

pub fn replay_put(keys: Vec<String>, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    let mut g = replay().inner.lock().unwrap();
    for k in keys {
        if k.is_empty() {
            continue;
        }
        if !g.entries.contains_key(&k) {
            g.order.push_back(k.clone());
        }
        g.entries.insert(k, blocks.clone());
    }
    while g.order.len() > g.limit {
        if let Some(old) = g.order.pop_front() {
            g.entries.remove(&old);
        }
    }
}

/// 请求侧查找：Turn → ToolIDs → Thinking，命中即把带签名的 thinking 块注回 assistant 消息。
pub fn replay_lookup(text: &str, calls: &[Value], reasoning_content: &str) -> Vec<Value> {
    if let Some(b) = replay().inner.lock().unwrap().entries.get(&turn_key(text, calls)) {
        return b.clone();
    }
    let tk = tool_ids_key(calls);
    if !tk.is_empty() {
        if let Some(b) = replay().inner.lock().unwrap().entries.get(&tk) {
            return b.clone();
        }
    }
    if !reasoning_content.is_empty() {
        if let Some(b) = replay().inner.lock().unwrap().entries.get(&thinking_key(reasoning_content)) {
            return b.clone();
        }
    }
    Vec::new()
}

/// 成功响应后写入回放缓存。blocks 为带 signature 的 thinking 块 + redacted 块。
pub fn store_replay_parts(text: &str, calls: &[Value], blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    let mut keys = vec![turn_key(text, calls)];
    let thinking = blocks
        .iter()
        .find_map(|b| b.get("thinking").and_then(|t| t.as_str()))
        .unwrap_or("");
    if !thinking.is_empty() {
        keys.push(thinking_key(thinking));
    }
    let tk = tool_ids_key(calls);
    if !tk.is_empty() {
        keys.push(tk);
    }
    replay_put(keys, blocks);
}

/// 非流式 Anthropic 响应 → 提取 (可见文本, OpenAI 形态 tool_calls, 可回放块)。
fn anthropic_replay_parts(up: &Value) -> (String, Vec<Value>, Vec<Value>) {
    let mut text = String::new();
    let mut calls: Vec<Value> = vec![];
    let mut blocks: Vec<Value> = vec![];
    for b in up.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
            Some("thinking") => {
                let t = b.get("thinking").and_then(|x| x.as_str()).unwrap_or("");
                let s = b.get("signature").and_then(|x| x.as_str()).unwrap_or("");
                if !t.is_empty() && !s.is_empty() {
                    blocks.push(json!({"type": "thinking", "thinking": t, "signature": s}));
                }
            }
            Some("redacted_thinking") => {
                blocks.push(json!({"type": "redacted_thinking", "data": b.get("data").cloned().unwrap_or(Value::Null)}));
            }
            Some("tool_use") => {
                let input = b.get("input").cloned().unwrap_or(json!({}));
                calls.push(json!({
                    "id": b.get("id").cloned().unwrap_or(json!("")),
                    "type": "function",
                    "function": {
                        "name": b.get("name").cloned().unwrap_or(json!("")),
                        "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".into()),
                    }
                }));
            }
            _ => {}
        }
    }
    (text, calls, blocks)
}

/// 非流式路径的回放缓存写入（仅成功响应时由 translate_response 调用）。
pub fn store_replay_from_anthropic(up: &Value) {
    let (text, calls, blocks) = anthropic_replay_parts(up);
    store_replay_parts(&text, &calls, blocks);
}

// ===== 请求翻译 =====

fn text_of_content(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None // 图片等 v1 暂不支持
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn normalize_effort(e: &str) -> Option<&'static str> {
    match e.trim().to_lowercase().as_str() {
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "max" | "xhigh" => Some("max"),
        _ => None,
    }
}

/// 缺 id 的 tool_use 用 call_<sha256(name+NUL+args)[:12]> 合成，保证回放缓存的
/// ToolIDsKey 能在下一轮命中（glm-zcode-2api 同款）。
fn synthetic_tool_id(name: &str, args: &str) -> String {
    let h = Sha256::digest(format!("{name}\x00{}", args.trim()).as_bytes());
    let hex: String = h[..12].iter().map(|b| format!("{b:02x}")).collect();
    format!("call_{hex}")
}

/// GLM-5.3 系强制思考（zcode-plan 上游不允许禁用）：budget = min(8192, max_tokens-1024)，
/// 下限 1024；reasoning_effort 缺省 max，客户端显式给的（经 normalize）优先。
fn apply_thinking(out: &mut Value, model: &str, max_tokens: u32) {
    if !model.to_lowercase().contains("5.3") {
        return;
    }
    let mt = (max_tokens as usize).max(1024);
    let mut budget = 8192usize.min(mt.saturating_sub(1024));
    if budget < 1024 {
        budget = 1024;
    }
    match out.get("thinking").and_then(|t| t.as_object()).cloned() {
        Some(o) if o.get("type").and_then(|t| t.as_str()) == Some("enabled") => {
            let mut o = o;
            o.entry("budget_tokens".to_string()).or_insert(json!(budget));
            out["thinking"] = Value::Object(o);
        }
        _ => {
            out["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
        }
    }
    if out.get("reasoning_effort").map(|e| e.as_str().map(|s| s.is_empty()).unwrap_or(true)).unwrap_or(true) {
        out["reasoning_effort"] = json!("max");
    }
}

/// OpenAI chat.completions 请求 → Anthropic /v1/messages 请求
pub fn translate_request(v: &Value) -> Result<Value, String> {
    let obj = v.as_object().ok_or("请求体不是 JSON 对象")?;
    let model = obj.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let mut system_parts: Vec<String> = vec![];
    let mut msgs: Vec<Value> = vec![];

    for m in obj.get("messages").and_then(|m| m.as_array()).into_iter().flatten() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        match role {
            "system" | "developer" => {
                let t = text_of_content(m.get("content").unwrap_or(&Value::Null));
                if !t.is_empty() {
                    system_parts.push(t);
                }
            }
            "user" => {
                let t = text_of_content(m.get("content").unwrap_or(&Value::Null));
                msgs.push(json!({"role": "user", "content": [{"type": "text", "text": t}]}));
            }
            "assistant" => {
                let mut blocks: Vec<Value> = vec![];
                let t = text_of_content(m.get("content").unwrap_or(&Value::Null));
                if !t.is_empty() {
                    blocks.push(json!({"type": "text", "text": t}));
                }
                for tc in m.get("tool_calls").and_then(|t| t.as_array()).into_iter().flatten() {
                    let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("");
                    let f = tc.get("function");
                    let name = f.and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("");
                    let args_raw = f.and_then(|f| f.get("arguments")).and_then(|a| a.as_str()).unwrap_or("{}");
                    // 解析失败包 {"_raw": args} 保活工具循环（glm-zcode-2api 同款）
                    let input: Value = serde_json::from_str(args_raw).unwrap_or(json!({"_raw": args_raw.trim()}));
                    let id = if id.is_empty() { synthetic_tool_id(name, args_raw) } else { id.to_string() };
                    blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
                }
                // 签名回放：命中缓存就把带签名的 thinking 块插到 assistant 内容最前
                let reasoning = m.get("reasoning_content").and_then(|x| x.as_str()).unwrap_or("");
                let calls = m.get("tool_calls").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                let cached = replay_lookup(&t, &calls, reasoning);
                if !cached.is_empty() {
                    let mut all = cached;
                    all.extend(blocks);
                    blocks = all;
                }
                if !blocks.is_empty() {
                    msgs.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            "tool" => {
                let t = text_of_content(m.get("content").unwrap_or(&Value::Null));
                let call_id = m.get("tool_call_id").and_then(|x| x.as_str()).unwrap_or("");
                msgs.push(json!({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": call_id, "content": [{"type": "text", "text": t}]}]
                }));
            }
            _ => {}
        }
    }

    // Anthropic 要求 user/assistant 交替：合并相邻同角色消息
    let mut merged: Vec<Value> = vec![];
    for m in msgs {
        let role = m.get("role").cloned().unwrap_or(Value::Null);
        if let Some(last) = merged.last_mut() {
            if last.get("role") == Some(&role) {
                if let (Some(a), Some(b)) = (
                    last.get_mut("content").and_then(|c| c.as_array_mut()),
                    m.get("content").and_then(|c| c.as_array()),
                ) {
                    a.extend(b.iter().cloned());
                    continue;
                }
            }
        }
        merged.push(m);
    }

    let tools: Vec<Value> = obj
        .get("tools")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let f = t.get("function")?;
            let name = f.get("name").and_then(|n| n.as_str())?;
            Some(json!({
                "name": name,
                "description": f.get("description").cloned().unwrap_or(json!("")),
                "input_schema": f.get("parameters").cloned().unwrap_or(json!({"type": "object", "properties": {}})),
            }))
        })
        .collect();

    let max_tokens = obj
        .get("max_tokens")
        .and_then(|x| x.as_u64())
        .or_else(|| obj.get("max_completion_tokens").and_then(|x| x.as_u64()))
        .unwrap_or(8192)
        .clamp(1, 128_000) as u32;
    let stop: Vec<String> = match obj.get("stop") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|s| s.as_str().map(String::from)).collect(),
        _ => vec![],
    };

    let mut out = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": merged,
    });
    if !system_parts.is_empty() {
        out["system"] = json!(system_parts.join("\n\n"));
    }
    if !tools.is_empty() {
        out["tools"] = json!(tools);
    }
    if let Some(t) = obj.get("temperature").and_then(|x| x.as_f64()) {
        out["temperature"] = json!(t);
    }
    if let Some(t) = obj.get("top_p").and_then(|x| x.as_f64()) {
        out["top_p"] = json!(t);
    }
    if !stop.is_empty() {
        out["stop_sequences"] = json!(stop);
    }
    if obj.get("stream").and_then(|x| x.as_bool()).unwrap_or(false) {
        out["stream"] = json!(true);
    }
    // 客户端显式给的推理档位（reasoning_effort / reasoning.effort）归一化后透传
    let effort_raw = obj
        .get("reasoning_effort")
        .and_then(|x| x.as_str())
        .or_else(|| obj.get("reasoning").and_then(|r| r.get("effort")).and_then(|x| x.as_str()));
    if let Some(e) = effort_raw.and_then(normalize_effort) {
        out["reasoning_effort"] = json!(e);
    }
    apply_thinking(&mut out, &model, max_tokens);
    Ok(out)
}

fn map_finish(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("max_tokens") => "length",
        Some("tool_use") => "tool_calls",
        _ => "stop",
    }
}

/// Anthropic /v1/messages 非流式响应 → OpenAI chat.completion 响应。
/// thinking 文本进 reasoning_content；带签名的思考块写入回放缓存（工具循环下一轮注入）。
pub fn translate_response(up: &Value, fallback_model: &str) -> Value {
    let model = up.get("model").and_then(|m| m.as_str()).unwrap_or(fallback_model).to_string();
    let id = up.get("id").and_then(|i| i.as_str()).unwrap_or("chatcmpl-zsw").to_string();
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Value> = vec![];
    for b in up.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
            Some("thinking") => {
                if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                    reasoning.push_str(t);
                }
            }
            Some("tool_use") => {
                let input = b.get("input").cloned().unwrap_or(json!({}));
                tool_calls.push(json!({
                    "id": b.get("id").cloned().unwrap_or(json!(format!("call_{}", tool_calls.len()))),
                    "type": "function",
                    "function": {
                        "name": b.get("name").cloned().unwrap_or(json!("")),
                        "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".into()),
                    },
                    "index": tool_calls.len(),
                }));
            }
            _ => {}
        }
    }
    let mut message = json!({"role": "assistant"});
    message["content"] = if text.is_empty() { Value::Null } else { json!(text) };
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    let usage = up.pointer("/usage").cloned().unwrap_or(Value::Null);
    let usage_in = usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0)
        + usage.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0)
        + usage.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let usage_out = usage.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    store_replay_from_anthropic(up);
    json!({
        "id": id,
        "object": "chat.completion",
        "created": chrono::Local::now().timestamp(),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": map_finish(up.get("stop_reason").and_then(|s| s.as_str()))}],
        "usage": {"prompt_tokens": usage_in, "completion_tokens": usage_out, "total_tokens": usage_in + usage_out},
    })
}

struct BlockInfo {
    openai_tool_index: Option<usize>,
}

struct ToolAcc {
    id: String,
    name: String,
    args: String,
}

/// Anthropic SSE → OpenAI chunk 流的逐行转换器。
/// thinking_delta 外发成 reasoning_content；signature 只累积喂回放缓存；
/// redacted_thinking 不外发只收集。结束后用 replay_parts 取回放材料。
/// 用法：对上游每个 SSE 行调 push_line；结束后调 finish 补齐 finish_reason / usage / [DONE]。
pub struct SseTransformer {
    model: String,
    id: String,
    started: bool,
    blocks: HashMap<u64, BlockInfo>,
    tool_seq: usize,
    tools: Vec<ToolAcc>,
    text_acc: String,
    thinking: String,
    signature: String,
    redacted: Vec<Value>,
    stop_reason: Option<String>,
    usage_in: u64,
    usage_out: u64,
    finished: bool,
    error_seen: bool,
}

impl SseTransformer {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            id: format!("chatcmpl-zsw-{}", chrono::Local::now().timestamp_millis()),
            started: false,
            blocks: HashMap::new(),
            tool_seq: 0,
            tools: Vec::new(),
            text_acc: String::new(),
            thinking: String::new(),
            signature: String::new(),
            redacted: Vec::new(),
            stop_reason: None,
            usage_in: 0,
            usage_out: 0,
            finished: false,
            error_seen: false,
        }
    }

    fn write_chunk(&self, out: &mut Vec<u8>, delta: Value, finish: Option<&str>) {
        let c = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": chrono::Local::now().timestamp(),
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        out.extend_from_slice(format!("data: {c}\n\n").as_bytes());
    }

    pub fn push_line(&mut self, line: &str, out: &mut Vec<u8>) {
        let line = line.trim();
        if !line.starts_with("data:") {
            return; // event: / 注释 / 空行都不需要
        }
        let payload = line[5..].trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else { return };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "message_start" => {
                if let Some(id) = v.pointer("/message/id").and_then(|x| x.as_str()) {
                    self.id = id.to_string();
                }
                if let Some(model) = v.pointer("/message/model").and_then(|x| x.as_str()) {
                    self.model = model.to_string();
                }
                let u = v.pointer("/message/usage").cloned().unwrap_or(Value::Null);
                self.usage_in = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0)
                    + u.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0)
                    + u.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                self.started = true;
                self.write_chunk(out, json!({"role": "assistant", "content": ""}), None);
            }
            "content_block_start" => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0);
                let kind = v.pointer("/content_block/type").and_then(|x| x.as_str()).unwrap_or("");
                match kind {
                    "tool_use" => {
                        let openai_idx = self.tool_seq;
                        self.tool_seq += 1;
                        let id = v.pointer("/content_block/id").and_then(|x| x.as_str()).unwrap_or("");
                        let name = v.pointer("/content_block/name").and_then(|x| x.as_str()).unwrap_or("");
                        // 上游可能把初始 input 直接放在 content_block_start 里
                        let preset = match v.pointer("/content_block/input") {
                            Some(i) if !i.is_null() => {
                                let raw = serde_json::to_string(i).unwrap_or_default();
                                let raw = raw.trim();
                                if raw.is_empty() || raw == "{}" || raw == "null" { String::new() } else { raw.to_string() }
                            }
                            _ => String::new(),
                        };
                        self.tools.push(ToolAcc { id: id.to_string(), name: name.to_string(), args: preset.clone() });
                        self.write_chunk(
                            out,
                            json!({"tool_calls": [{"index": openai_idx, "id": id, "type": "function", "function": {"name": name, "arguments": preset}}]}),
                            None,
                        );
                        self.blocks.insert(idx, BlockInfo { openai_tool_index: Some(openai_idx) });
                    }
                    "thinking" => {
                        let init = v.pointer("/content_block/thinking").and_then(|x| x.as_str()).unwrap_or("");
                        if !init.is_empty() {
                            self.thinking.push_str(init);
                            self.write_chunk(out, json!({"reasoning_content": init}), None);
                        }
                        self.blocks.insert(idx, BlockInfo { openai_tool_index: None });
                    }
                    "redacted_thinking" => {
                        let data = v.pointer("/content_block/data").cloned().unwrap_or(Value::Null);
                        self.redacted.push(json!({"type": "redacted_thinking", "data": data}));
                        self.blocks.insert(idx, BlockInfo { openai_tool_index: None });
                    }
                    _ => {
                        self.blocks.insert(idx, BlockInfo { openai_tool_index: None });
                    }
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0);
                let dt = v.pointer("/delta/type").and_then(|x| x.as_str()).unwrap_or("");
                match dt {
                    "text_delta" => {
                        let t = v.pointer("/delta/text").and_then(|x| x.as_str()).unwrap_or("");
                        if !t.is_empty() {
                            self.text_acc.push_str(t);
                            self.write_chunk(out, json!({"content": t}), None);
                        }
                    }
                    "thinking_delta" => {
                        let t = v.pointer("/delta/thinking").and_then(|x| x.as_str()).unwrap_or("");
                        if !t.is_empty() {
                            self.thinking.push_str(t);
                            self.write_chunk(out, json!({"reasoning_content": t}), None);
                        }
                    }
                    "signature_delta" => {
                        // 只累积喂回放缓存，不外发（OpenAI 侧无对应字段）
                        let t = v.pointer("/delta/signature").and_then(|x| x.as_str()).unwrap_or("");
                        self.signature.push_str(t);
                    }
                    "input_json_delta" => {
                        if let Some(bi) = self.blocks.get(&idx) {
                            if let Some(oi) = bi.openai_tool_index {
                                let partial = v.pointer("/delta/partial_json").and_then(|x| x.as_str()).unwrap_or("");
                                if !partial.is_empty() {
                                    if let Some(t) = self.tools.get_mut(oi) {
                                        t.args.push_str(partial);
                                    }
                                    self.write_chunk(
                                        out,
                                        json!({"tool_calls": [{"index": oi, "function": {"arguments": partial}}]}),
                                        None,
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                self.stop_reason = v.pointer("/delta/stop_reason").and_then(|x| x.as_str()).map(String::from);
                if let Some(o) = v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()) {
                    self.usage_out = o;
                }
                // api.z.ai 系通道把最终 input_tokens 放在 message_delta
                if let Some(i) = v.pointer("/usage/input_tokens").and_then(|x| x.as_u64()) {
                    if i > self.usage_in {
                        self.usage_in = i;
                    }
                }
            }
            "message_stop" => {
                if !self.finished {
                    self.finished = true;
                    self.write_chunk(out, json!({}), Some(map_finish(self.stop_reason.as_deref())));
                    let usage = json!({"prompt_tokens": self.usage_in, "completion_tokens": self.usage_out, "total_tokens": self.usage_in + self.usage_out});
                    out.extend_from_slice(
                        format!("data: {}\n\n", json!({
                            "id": self.id, "object": "chat.completion.chunk",
                            "created": chrono::Local::now().timestamp(), "model": self.model,
                            "choices": [], "usage": usage,
                        }))
                        .as_bytes(),
                    );
                    out.extend_from_slice(b"data: [DONE]\n\n");
                }
            }
            "error" => {
                let msg = v.pointer("/error/message").and_then(|x| x.as_str()).unwrap_or("上游流错误");
                self.error_seen = true;
                self.finished = true;
                out.extend_from_slice(
                    format!("data: {}\n\n", json!({"error": {"message": msg, "type": "upstream_error"}})).as_bytes(),
                );
                out.extend_from_slice(b"data: [DONE]\n\n");
            }
            _ => {} // ping 等
        }
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if self.finished {
            return;
        }
        self.finished = true;
        if !self.started {
            self.write_chunk(out, json!({"role": "assistant", "content": ""}), None);
        }
        self.write_chunk(out, json!({}), Some(map_finish(self.stop_reason.as_deref())));
        out.extend_from_slice(b"data: [DONE]\n\n");
    }

    pub fn error_seen(&self) -> bool {
        self.error_seen
    }

    fn tool_calls_openai(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|t| {
                let args = t.args.trim();
                let args = if args.is_empty() { "{}" } else { args };
                json!({"id": t.id, "type": "function", "function": {"name": t.name, "arguments": args}})
            })
            .collect()
    }

    /// 流结束后的回放材料：(可见文本, OpenAI 形态 tool_calls, 带签名/redaacted 块)。
    /// 无可回放内容时返回 None。
    pub fn replay_parts(&self) -> Option<(String, Vec<Value>, Vec<Value>)> {
        let mut blocks: Vec<Value> = Vec::new();
        if !self.thinking.is_empty() && !self.signature.is_empty() {
            blocks.push(json!({"type": "thinking", "thinking": self.thinking, "signature": self.signature}));
        }
        blocks.extend(self.redacted.iter().cloned());
        if blocks.is_empty() {
            return None;
        }
        Some((self.text_acc.clone(), self.tool_calls_openai(), blocks))
    }
}

fn map_stop_openai_to_anthropic(f: Option<&str>) -> &'static str {
    match f {
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        _ => "end_turn",
    }
}

/// OpenAI chat.completion 响应 → Anthropic /v1/messages 响应（免费模型，anthropic 入站非流式）
pub fn translate_openai_to_anthropic_response(v: &Value, fallback_model: &str) -> Value {
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or(fallback_model).to_string();
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("msg_zsw").to_string();
    let mut blocks: Vec<Value> = vec![];
    let choice = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first());
    if let Some(ch) = choice {
        let msg = ch.get("message");
        if let Some(t) = msg.and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
            if !t.is_empty() {
                blocks.push(json!({"type": "text", "text": t}));
            }
        }
        for tc in msg
            .and_then(|m| m.get("tool_calls"))
            .and_then(|t| t.as_array())
            .into_iter()
            .flatten()
        {
            let tid = tc.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let f = tc.get("function");
            let name = f.and_then(|f| f.get("name")).and_then(|n| n.as_str()).unwrap_or("");
            let args_raw = f.and_then(|f| f.get("arguments")).and_then(|a| a.as_str()).unwrap_or("{}");
            let input: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
            let tid = if tid.is_empty() { format!("toolu_{}", blocks.len()) } else { tid.to_string() };
            blocks.push(json!({"type": "tool_use", "id": tid, "name": name, "input": input}));
        }
    }
    let stop = map_stop_openai_to_anthropic(choice.and_then(|c| c.get("finish_reason")).and_then(|f| f.as_str()));
    let usage_in = v.pointer("/usage/prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let usage_out = v.pointer("/usage/completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": stop,
        "stop_sequence": Value::Null,
        "usage": {"input_tokens": usage_in, "output_tokens": usage_out},
    })
}

/// OpenAI chunk 流 → Anthropic SSE 事件流（免费模型，anthropic 入站流式）。
/// 事件序列：message_start → (content_block_start/delta/stop)* → message_delta → message_stop。
pub struct OpenAiToAnthropicSse {
    model: String,
    id: String,
    started: bool,
    finished: bool,
    next_index: u64,
    text_idx: Option<u64>,
    tool_idx: Option<u64>,
    usage_in: u64,
    usage_out: u64,
    stop: Option<String>,
}

impl OpenAiToAnthropicSse {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            id: format!("msg_zsw_{}", chrono::Local::now().timestamp_millis()),
            started: false,
            finished: false,
            next_index: 0,
            text_idx: None,
            tool_idx: None,
            usage_in: 0,
            usage_out: 0,
            stop: None,
        }
    }

    fn ev(out: &mut Vec<u8>, event: &str, data: &Value) {
        out.extend_from_slice(format!("event: {event}\ndata: {data}\n\n").as_bytes());
    }

    fn close_open_block(&mut self, out: &mut Vec<u8>) {
        if let Some(idx) = self.text_idx.take() {
            Self::ev(out, "content_block_stop", &json!({"type": "content_block_stop", "index": idx}));
        }
        if let Some(idx) = self.tool_idx.take() {
            Self::ev(out, "content_block_stop", &json!({"type": "content_block_stop", "index": idx}));
        }
    }

    pub fn push_line(&mut self, line: &str, out: &mut Vec<u8>) {
        if self.finished {
            return;
        }
        let line = line.trim();
        if !line.starts_with("data:") {
            return;
        }
        let payload = line[5..].trim();
        if payload.is_empty() {
            return;
        }
        if payload == "[DONE]" {
            self.finish(out);
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else { return };
        if !self.started {
            self.started = true;
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                self.id = id.to_string();
            }
            if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                self.model = m.to_string();
            }
            self.usage_in = v.pointer("/usage/prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            Self::ev(out, "message_start", &json!({
                "type": "message_start",
                "message": {
                    "id": self.id, "type": "message", "role": "assistant", "model": self.model,
                    "content": [], "stop_reason": Value::Null, "stop_sequence": Value::Null,
                    "usage": {"input_tokens": self.usage_in, "output_tokens": 0},
                }
            }));
        }
        let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()) else { return };
        let delta = choice.get("delta");
        if let Some(t) = delta.and_then(|d| d.get("content")).and_then(|c| c.as_str()) {
            if !t.is_empty() {
                if self.text_idx.is_none() && self.tool_idx.is_none() {
                    let idx = self.next_index;
                    self.next_index += 1;
                    self.text_idx = Some(idx);
                    Self::ev(out, "content_block_start", &json!({"type": "content_block_start", "index": idx, "content_block": {"type": "text", "text": ""}}));
                }
                if let Some(idx) = self.text_idx {
                    Self::ev(out, "content_block_delta", &json!({"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": t}}));
                }
            }
        }
        if let Some(tcs) = delta.and_then(|d| d.get("tool_calls")).and_then(|t| t.as_array()) {
            for tc in tcs {
                let tid = tc.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let fname = tc.pointer("/function/name").and_then(|x| x.as_str()).unwrap_or("");
                if !tid.is_empty() || !fname.is_empty() {
                    self.close_open_block(out);
                    let idx = self.next_index;
                    self.next_index += 1;
                    self.tool_idx = Some(idx);
                    Self::ev(out, "content_block_start", &json!({"type": "content_block_start", "index": idx, "content_block": {"type": "tool_use", "id": tid, "name": fname, "input": {}}}));
                }
                if let Some(args) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                    if !args.is_empty() {
                        if let Some(idx) = self.tool_idx {
                            Self::ev(out, "content_block_delta", &json!({"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": args}}));
                        }
                    }
                }
            }
        }
        if let Some(u) = v.get("usage") {
            if let Some(x) = u.get("prompt_tokens").and_then(|x| x.as_u64()) {
                self.usage_in = x;
            }
            if let Some(x) = u.get("completion_tokens").and_then(|x| x.as_u64()) {
                self.usage_out = x;
            }
        }
        if let Some(f) = choice.get("finish_reason").and_then(|x| x.as_str()) {
            self.stop = Some(map_stop_openai_to_anthropic(Some(f)).to_string());
        }
    }

    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if self.finished {
            return;
        }
        self.finished = true;
        if !self.started {
            Self::ev(out, "message_start", &json!({
                "type": "message_start",
                "message": {
                    "id": self.id, "type": "message", "role": "assistant", "model": self.model,
                    "content": [], "stop_reason": Value::Null, "stop_sequence": Value::Null,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                }
            }));
        }
        self.close_open_block(out);
        Self::ev(out, "message_delta", &json!({
            "type": "message_delta",
            "delta": {"stop_reason": self.stop.clone().unwrap_or_else(|| "end_turn".into()), "stop_sequence": Value::Null},
            "usage": {"output_tokens": self.usage_out},
        }));
        Self::ev(out, "message_stop", &json!({"type": "message_stop"}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(tr: &mut SseTransformer, lines: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for l in lines {
            tr.push_line(l, &mut out);
        }
        tr.finish(&mut out);
        out
    }

    #[test]
    fn thinking_streams_as_reasoning_and_stores_replay() {
        let mut tr = SseTransformer::new("glm-5.3");
        let out = feed(
            &mut tr,
            &[
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":5,\"cache_creation_input_tokens\":2}}}",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"让我想\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sigABC\"}}",
                "data: {\"type\":\"content_block_stop\",\"index\":0}",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"答案\"}}",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}",
                "data: {\"type\":\"message_stop\"}",
            ],
        );
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("reasoning_content"), "应外发 reasoning_content: {s}");
        assert!(s.contains("让我想"));
        assert!(!s.contains("sigABC"), "signature 不应外发");
        // usage 把 cache_read/creation 计入 prompt_tokens
        assert!(s.contains("\"prompt_tokens\":17"));
        // 回放材料已可取，且写入缓存后能按 TurnKey 查到
        let (text, calls, blocks) = tr.replay_parts().expect("应有回放材料");
        assert_eq!(text, "答案");
        assert!(calls.is_empty());
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["signature"], "sigABC");
        store_replay_parts(&text, &calls, blocks);
        let req = json!({"model":"glm-5.3","max_tokens":4096,"messages":[
            {"role":"user","content":"hi"},
            {"role":"assistant","content":"答案"}
        ]});
        let translated = translate_request(&req).unwrap();
        let blocks_out = &translated["messages"][1]["content"];
        assert_eq!(blocks_out[0]["type"], "thinking", "回放块应插在最前: {blocks_out}");
        assert_eq!(blocks_out[0]["signature"], "sigABC");
        assert_eq!(blocks_out[1]["type"], "text");
    }

    #[test]
    fn replay_tool_ids_key_survives_args_reformat() {
        let calls = vec![json!({"id":"call_x","type":"function","function":{"name":"run","arguments":"{\"a\":1}"}})];
        store_replay_parts(
            "正文",
            &calls,
            vec![json!({"type":"thinking","thinking":"思考","signature":"S"} )],
        );
        // 客户端把 args 序列化格式改了：TurnKey 变了，但 ToolIDsKey 兜底仍命中
        let reformatted = vec![json!({"id":"call_x","type":"function","function":{"name":"run","arguments":"{ \"a\": 1 }"}})];
        assert_ne!(
            turn_key("正文", &calls),
            turn_key("正文", &reformatted),
            "TurnKey 应随 args 原文变化"
        );
        let hit = replay_lookup("正文", &reformatted, "");
        assert!(!hit.is_empty(), "ToolIDsKey 兜底应命中: {hit:?}");
        assert_eq!(hit[0]["signature"], "S");
    }

    #[test]
    fn reasoning_content_echo_hits_thinking_key() {
        store_replay_parts(
            "别的正文",
            &[],
            vec![json!({"type":"thinking","thinking":"独一份的思考串","signature":"S2"} )],
        );
        let hit = replay_lookup("完全不同的正文", &[], "独一份的思考串");
        assert!(!hit.is_empty(), "ThinkingKey 应命中");
    }

    #[test]
    fn glm53_forces_thinking_and_normalizes_effort() {
        let req = json!({"model":"glm-5.3","max_tokens":4096,"reasoning_effort":"XHIGH","messages":[{"role":"user","content":"hi"}]});
        let out = translate_request(&req).unwrap();
        assert_eq!(out["thinking"]["type"], "enabled");
        assert_eq!(out["thinking"]["budget_tokens"], 3072, "min(8192, 4096-1024)");
        assert_eq!(out["reasoning_effort"], "max", "xhigh 归一化为 max");
        // 非 5.3 模型不动
        let req2 = json!({"model":"glm-4.7","max_tokens":4096,"messages":[{"role":"user","content":"hi"}]});
        let out2 = translate_request(&req2).unwrap();
        assert!(out2.get("thinking").is_none());
        // 客户端带 reasoning_content 的 assistant 消息在无缓存时不产生块
        let req3 = json!({"model":"glm-5.3","max_tokens":4096,"messages":[
            {"role":"assistant","content":"答","reasoning_content":"没有缓存的思考","tool_calls":[{"id":"t1","type":"function","function":{"name":"f","arguments":"{}"}}]}
        ]});
        let out3 = translate_request(&req3).unwrap();
        let blocks = &out3["messages"][0]["content"];
        assert_eq!(blocks[0]["type"], "text", "miss 时不注入 thinking: {blocks}");
    }

    #[test]
    fn anthropic_response_thinking_goes_to_reasoning_and_replay() {
        let up = json!({
            "id":"msg_2","model":"glm-5.3","stop_reason":"end_turn",
            "content":[
                {"type":"thinking","thinking":"想想","signature":"SIG"},
                {"type":"text","text":"你好"}
            ],
            "usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":1}
        });
        let out = translate_response(&up, "glm-5.3");
        assert_eq!(out["choices"][0]["message"]["reasoning_content"], "想想");
        assert_eq!(out["usage"]["prompt_tokens"], 4, "input+cache_read");
        // 已写入缓存，下一轮回显文本即命中
        let hit = replay_lookup("你好", &[], "");
        assert_eq!(hit[0]["signature"], "SIG");
    }
}
