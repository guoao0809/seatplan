//! AI 排座接口调用（OpenAI 兼容协议）。
//! URL 拼接与请求实现移植自 D:\wok\worknotes\gitreport\src-tauri\src\ai.rs。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::BufRead;
use std::time::{Duration, Instant};

// 实测网关完成一次排座要 53~80 秒；命令已 async + spawn_blocking（不冻 UI），
// 且弹窗可在请求中途关闭，故放宽到 300 秒。
const TIMEOUT: Duration = Duration::from_secs(300);
/// 测试连接与拉模型列表都是小请求，卡住就该早点报错
const SHORT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 推理强度。不填默认 "none"（关掉思考）——实测 2~4 秒出结果，且 10/10 条指令
    /// 都被正确翻译成操作。之所以敢关：模型只输出「交换/轮转」这类操作，机械活儿全由
    /// 代码执行，排错了在「将执行的操作」里一眼可见，不会像直接输出座位表那样静默排错。
    /// 填 "off" 则不发送该参数（走模型默认，复杂多约束指令可用）；也可填 low / medium / high。
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// 解析要发给网关的 reasoning_effort。
/// None（未配置）→ "none"；Some("off") → 不发该参数；其余原样透传。
fn reasoning_effort(config: &AiConfig) -> Option<&str> {
    match config.reasoning_effort.as_deref() {
        Some("off") => None,
        Some(v) => Some(v),
        None => Some("none"),
    }
}

/// 一条对话消息。字段名本就是单词小写，无需 rename。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式增量事件：思考过程与正文分开推，前端把 reasoning 显示成「思考中」，正文攒起来解析。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AiStreamEvent {
    /// 模型的思考过程增量（网关不支持 reasoning 时一直为空）
    Reasoning { text: String },
    /// 正文增量（最终那串 JSON 操作）
    Content { text: String },
}

/// Base URL 智能拼接：去掉尾部 '/'；不以 /v1 或 /chat/completions 结尾则补 /v1。
fn normalize_base(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") || base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/v1")
    }
}

/// 构造 chat completions 请求 URL
fn request_url(base_url: &str) -> String {
    let base = normalize_base(base_url);
    if base.ends_with("/chat/completions") {
        base
    } else {
        format!("{base}/chat/completions")
    }
}

/// 发流式 JSON POST，返回还没读完的响应（HTTP 错误透传 status + body 前 200 字符）。
/// 用 blocking 版：整个命令跑在 spawn_blocking 里，逐行读 SSE 恰好也要一个专用线程。
fn post_sse(url: &str, config: &AiConfig, body: &Value) -> Result<reqwest::blocking::Response, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(body)
        .send()
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("AI 接口返回错误（HTTP {status}）：{snippet}"));
    }
    Ok(resp)
}

/// 逐行读 SSE，把增量推给前端，返回拼好的正文。
///
/// 两样都边到边推——开着推理时一次排座要 50~80 秒，前端得看得见它在动。
fn pump_sse(
    resp: reqwest::blocking::Response,
    on_event: &tauri::ipc::Channel<AiStreamEvent>,
) -> Result<String, String> {
    let mut out = String::new();
    for line in std::io::BufReader::new(resp).lines() {
        let line = line.map_err(|e| format!("读取响应流失败：{e}"))?;
        let chunk = parse_sse_line(&line);
        if chunk.done {
            break;
        }
        if !chunk.reasoning.is_empty() {
            let _ = on_event.send(AiStreamEvent::Reasoning { text: chunk.reasoning });
        }
        if !chunk.content.is_empty() {
            out.push_str(&chunk.content);
            let _ = on_event.send(AiStreamEvent::Content { text: chunk.content });
        }
    }
    if out.trim().is_empty() {
        return Err("模型返回了空内容（流里没读到任何正文）".into());
    }
    Ok(out)
}

/// 一行 SSE 的解析结果
#[derive(Debug, Default, PartialEq)]
struct SseChunk {
    /// 思考过程增量
    reasoning: String,
    /// 正文增量
    content: String,
    /// 收到了 `[DONE]`
    done: bool,
}

/// 解析一行 SSE：只认 `data:`，取 `delta.reasoning_content`（个别网关叫 `reasoning`）与 `delta.content`。
/// 注释、心跳、非 JSON 一律当空行跳过——不因为一行脏数据中断整次请求。
fn parse_sse_line(line: &str) -> SseChunk {
    let mut chunk = SseChunk::default();
    let Some(raw) = line.strip_prefix("data:") else {
        return chunk;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return chunk;
    }
    if raw == "[DONE]" {
        chunk.done = true;
        return chunk;
    }
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return chunk;
    };
    let Some(delta) = v["choices"].get(0).and_then(|c| c.get("delta")) else {
        return chunk;
    };
    chunk.reasoning = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    chunk.content = delta
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    chunk
}

/// 调 AI 排座，流式把思考过程与正文推给前端，返回拼好的原始文本（解析与校验交给前端）。
/// async + spawn_blocking：Tauri 2 非 async 命令跑在主线程，阻塞式 reqwest 会冻住 UI，
/// 因此把整个阻塞过程丢到线程池执行。
#[tauri::command]
pub async fn ai_arrange(
    config: AiConfig,
    messages: Vec<ChatMessage>,
    on_event: tauri::ipc::Channel<AiStreamEvent>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if config.base_url.trim().is_empty() {
            return Err("配置里的 baseUrl 为空".into());
        }
        if config.api_key.trim().is_empty() {
            return Err("配置里的 apiKey 为空".into());
        }
        if config.model.trim().is_empty() {
            return Err("配置里的 model 为空".into());
        }
        if messages.is_empty() {
            return Err("消息为空".into());
        }

        let url = request_url(&config.base_url);
        let mut body = json!({
            "model": config.model,
            "messages": messages,
            "temperature": config.temperature.unwrap_or(0.7),
            "stream": true
        });
        if let Some(effort) = reasoning_effort(&config) {
            body["reasoning_effort"] = json!(effort);
        }

        pump_sse(post_sse(&url, &config, &body)?, &on_event)
    })
    .await
    .map_err(|e| format!("排座任务执行失败：{e}"))?
}

// ===== 设置页：测连接 / 拉模型列表 =====

/// 一次性 POST，返回响应体文本。只有设置页那两个小请求用它，排座走 SSE。
fn post_json(url: &str, config: &AiConfig, body: &Value) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(SHORT_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(body)
        .send()
        .map_err(|e| format!("网络请求失败：{e}"))?;

    let status = resp.status();
    let text = resp.text().map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("AI 接口返回错误（HTTP {status}）：{snippet}"));
    }
    Ok(text)
}

/// 测试连接：发一条 max_tokens=1 的 ping，通了返回耗时（如 "0.8s"）。
/// 同样丢进 spawn_blocking——Tauri 2 的非 async 命令跑在主线程，阻塞式 reqwest 会冻住 UI。
#[tauri::command]
pub async fn test_ai_connection(config: AiConfig) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if config.base_url.trim().is_empty() {
            return Err("Base URL 为空".into());
        }
        if config.model.trim().is_empty() {
            return Err("模型名称为空".into());
        }
        if config.api_key.trim().is_empty() {
            return Err("API Key 为空".into());
        }
        let body = json!({
            "model": config.model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1
        });

        let start = Instant::now();
        let text = post_json(&request_url(&config.base_url), &config, &body)?;
        // 只看能不能解析出 choices：max_tokens=1 时正文可能是空的，不算失败
        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
        if !v["choices"].as_array().is_some_and(|a| !a.is_empty()) {
            return Err(format!(
                "响应里没有 choices：{}",
                text.chars().take(200).collect::<String>()
            ));
        }
        Ok(format!("{:.1}s", start.elapsed().as_secs_f64()))
    })
    .await
    .map_err(|e| format!("测试连接执行失败：{e}"))?
}

/// 拉模型列表：GET {base}/v1/models（OpenAI 标准端点），Bearer 认证。
#[tauri::command]
pub async fn fetch_models(config: AiConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if config.base_url.trim().is_empty() {
            return Err("Base URL 为空".into());
        }
        let url = format!("{}/models", normalize_base(&config.base_url));
        let client = reqwest::blocking::Client::builder()
            .timeout(SHORT_TIMEOUT)
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .send()
            .map_err(|e| format!("网络请求失败：{e}"))?;

        let status = resp.status();
        let text = resp.text().map_err(|e| format!("读取响应失败：{e}"))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            return Err(format!("模型列表接口返回错误（HTTP {status}）：{snippet}"));
        }

        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
        let models: Vec<String> = v["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if models.is_empty() {
            return Err(format!(
                "接口没返回模型列表：{}",
                text.chars().take(200).collect::<String>()
            ));
        }
        Ok(models)
    })
    .await
    .map_err(|e| format!("获取模型列表执行失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalize_appends_v1_when_missing() {
        assert_eq!(
            normalize_base("http://your-gateway.example:20248"),
            "http://your-gateway.example:20248/v1"
        );
    }

    #[test]
    fn normalize_keeps_existing_v1_and_trims_slash() {
        assert_eq!(
            normalize_base("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1"
        );
    }

    #[test]
    fn normalize_keeps_full_path() {
        let u = "https://x.com/v1/chat/completions";
        assert_eq!(normalize_base(u), u);
    }

    #[test]
    fn request_url_appends_chat_completions() {
        assert_eq!(
            request_url("http://your-gateway.example:20248"),
            "http://your-gateway.example:20248/v1/chat/completions"
        );
    }

    #[test]
    fn request_url_keeps_full_path() {
        let u = "https://x.com/v1/chat/completions";
        assert_eq!(request_url(u), u);
    }

    #[test]
    fn config_temperature_is_optional() {
        let c: AiConfig =
            serde_json::from_str(r#"{"baseUrl":"http://x/v1","apiKey":"k","model":"m"}"#).unwrap();
        assert_eq!(c.model, "m");
        assert!(c.temperature.is_none());
    }

    #[test]
    fn reasoning_effort_defaults_to_none() {
        let c: AiConfig =
            serde_json::from_str(r#"{"baseUrl":"http://x/v1","apiKey":"k","model":"m"}"#).unwrap();
        assert_eq!(reasoning_effort(&c), Some("none"));
    }

    #[test]
    fn reasoning_effort_off_omits_the_param() {
        let c: AiConfig = serde_json::from_str(
            r#"{"baseUrl":"http://x/v1","apiKey":"k","model":"m","reasoningEffort":"off"}"#,
        )
        .unwrap();
        assert_eq!(reasoning_effort(&c), None);
    }

    #[test]
    fn reasoning_effort_passes_through_explicit_values() {
        for (raw, want) in [("low", "low"), ("medium", "medium"), ("high", "high")] {
            let c: AiConfig = serde_json::from_str(&format!(
                r#"{{"baseUrl":"http://x/v1","apiKey":"k","model":"m","reasoningEffort":"{raw}"}}"#
            ))
            .unwrap();
            assert_eq!(reasoning_effort(&c), Some(want));
        }
    }

    #[test]
    fn sse_line_splits_reasoning_and_content() {
        let c = parse_sse_line(r#"data: {"choices":[{"delta":{"reasoning_content":"先看同桌"}}]}"#);
        assert_eq!(c.reasoning, "先看同桌");
        assert_eq!(c.content, "");
        assert!(!c.done);

        let c = parse_sse_line(r#"data: {"choices":[{"delta":{"content":"{\"ops\""}}]}"#);
        assert_eq!(c.content, "{\"ops\"");
        assert_eq!(c.reasoning, "");
    }

    #[test]
    fn sse_line_accepts_reasoning_alias() {
        let c = parse_sse_line(r#"data: {"choices":[{"delta":{"reasoning":"换个名字也对"}}]}"#);
        assert_eq!(c.reasoning, "换个名字也对");
    }

    #[test]
    fn sse_line_skips_noise_and_sees_done() {
        assert_eq!(parse_sse_line(""), SseChunk::default());
        assert_eq!(parse_sse_line(": keep-alive"), SseChunk::default());
        assert_eq!(parse_sse_line("event: message"), SseChunk::default());
        assert_eq!(parse_sse_line("data: 半个 json"), SseChunk::default());
        assert_eq!(parse_sse_line(r#"data: {"choices":[]}"#), SseChunk::default());
        assert!(parse_sse_line("data: [DONE]").done);
    }
}
