//! OpenAI chat.completions ↔ Anthropic /v1/messages 的请求/响应/SSE 翻译。
//! 映射参考 .temp-Antigravity-Manager 的 mappers 与 Anthropic 官方协议。

use serde_json::{json, Value};
use std::collections::HashMap;

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
                    let input: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
                    let id = if id.is_empty() { format!("call_{}", blocks.len()) } else { id.to_string() };
                    blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
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
    Ok(out)
}

fn map_finish(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("max_tokens") => "length",
        Some("tool_use") => "tool_calls",
        _ => "stop",
    }
}

/// Anthropic /v1/messages 非流式响应 → OpenAI chat.completion 响应
pub fn translate_response(up: &Value, fallback_model: &str) -> Value {
    let model = up.get("model").and_then(|m| m.as_str()).unwrap_or(fallback_model).to_string();
    let id = up.get("id").and_then(|i| i.as_str()).unwrap_or("chatcmpl-zsw").to_string();
    let mut text = String::new();
    let mut tool_calls: Vec<Value> = vec![];
    for b in up.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
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
    if !tool_calls.is_empty() {
        message["tool_calls"] = json!(tool_calls);
    }
    let usage_in = up.pointer("/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let usage_out = up.pointer("/usage/output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
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
    is_tool: bool,
    openai_tool_index: Option<usize>,
}

/// Anthropic SSE → OpenAI chunk 流的逐行转换器。
/// 用法：对上游每个 SSE 行调 push_line；结束后调 finish 补齐 finish_reason / usage / [DONE]。
pub struct SseTransformer {
    model: String,
    id: String,
    started: bool,
    blocks: HashMap<u64, BlockInfo>,
    tool_seq: usize,
    stop_reason: Option<String>,
    usage_in: u64,
    usage_out: u64,
    finished: bool,
}

impl SseTransformer {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            id: format!("chatcmpl-zsw-{}", chrono::Local::now().timestamp_millis()),
            started: false,
            blocks: HashMap::new(),
            tool_seq: 0,
            stop_reason: None,
            usage_in: 0,
            usage_out: 0,
            finished: false,
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
                self.usage_in = v.pointer("/message/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                self.started = true;
                self.write_chunk(out, json!({"role": "assistant", "content": ""}), None);
            }
            "content_block_start" => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0);
                let kind = v.pointer("/content_block/type").and_then(|x| x.as_str()).unwrap_or("");
                if kind == "tool_use" {
                    let openai_idx = self.tool_seq;
                    self.tool_seq += 1;
                    let id = v.pointer("/content_block/id").and_then(|x| x.as_str()).unwrap_or("");
                    let name = v.pointer("/content_block/name").and_then(|x| x.as_str()).unwrap_or("");
                    self.write_chunk(
                        out,
                        json!({"tool_calls": [{"index": openai_idx, "id": id, "type": "function", "function": {"name": name, "arguments": ""}}]}),
                        None,
                    );
                    self.blocks.insert(idx, BlockInfo { is_tool: true, openai_tool_index: Some(openai_idx) });
                } else {
                    self.blocks.insert(idx, BlockInfo { is_tool: false, openai_tool_index: None });
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0);
                let dt = v.pointer("/delta/type").and_then(|x| x.as_str()).unwrap_or("");
                match dt {
                    "text_delta" => {
                        let t = v.pointer("/delta/text").and_then(|x| x.as_str()).unwrap_or("");
                        if !t.is_empty() {
                            self.write_chunk(out, json!({"content": t}), None);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(bi) = self.blocks.get(&idx) {
                            if let Some(oi) = bi.openai_tool_index {
                                let partial = v.pointer("/delta/partial_json").and_then(|x| x.as_str()).unwrap_or("");
                                self.write_chunk(
                                    out,
                                    json!({"tool_calls": [{"index": oi, "function": {"arguments": partial}}]}),
                                    None,
                                );
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
