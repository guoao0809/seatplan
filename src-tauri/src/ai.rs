//! AI 排座接口调用（OpenAI 兼容协议）。
//! URL 拼接与请求实现移植自 D:\wok\worknotes\gitreport\src-tauri\src\ai.rs。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

// 实测网关完成一次排座要 53~80 秒；命令已 async + spawn_blocking（不冻 UI），
// 且弹窗可在请求中途关闭，故放宽到 300 秒。
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    /// 推理强度。不填默认 "none"（关掉思考）——实测 2~4 秒出结果，且 10/10 条指令
    /// 都被正确翻译成操作。之所以敢关：模型只输出「交换/轮转」这类操作，机械活儿全由
    /// 代码执行，排错了在「将执行的操作」里一眼可见，不会像直接输出座位表那样静默排错。
    /// 填 "off" 则不发送该参数（走模型默认，复杂多约束指令可用）；也可填 low / medium / high。
    #[serde(default)]
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

/// 发 JSON POST，返回响应文本（HTTP 错误透传 status + body 前 200 字符）
fn post_json(url: &str, config: &AiConfig, body: &Value) -> Result<String, String> {
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
    let text = resp.text().map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("AI 接口返回错误（HTTP {status}）：{snippet}"));
    }
    Ok(text)
}

/// 从响应 JSON 取 choices[0].message.content
fn extract_text(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "响应中未找到文本（choices[0].message.content）：{}",
                body.chars().take(200).collect::<String>()
            )
        })
}

/// 调 AI 排座，返回模型输出的原始文本（解析与校验交给前端）。
/// async + spawn_blocking：Tauri 2 非 async 命令跑在主线程，阻塞式 reqwest 会冻住 UI，
/// 因此把整个阻塞过程丢到线程池执行。
#[tauri::command]
pub async fn ai_arrange(config: AiConfig, messages: Vec<ChatMessage>) -> Result<String, String> {
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
            "stream": false
        });
        if let Some(effort) = reasoning_effort(&config) {
            body["reasoning_effort"] = json!(effort);
        }

        let text = post_json(&url, &config, &body)?;
        extract_text(&text)
    })
    .await
    .map_err(|e| format!("排座任务执行失败：{e}"))?
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
}
