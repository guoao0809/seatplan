//! Tauri 应用入口：最小壳 + 保存座位图 + AI 排座。

mod ai;

use ai::AiConfig;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedAiConfig {
    config: AiConfig,
    path: String,
}

/// 把前端传来的 PNG 字节写入用户指定的路径（std::fs，绕开 fs 插件权限作用域）。
#[tauri::command]
fn save_png(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

/// 构建时由 build.rs 从 config.json 生成；文件不存在（如 CI 构建）时为空串。
mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_config.rs"));
}

/// 解析一段 JSON 配置；失败时给出带来源的报错
fn parse_config(text: &str, source: &str) -> Result<AiConfig, String> {
    serde_json::from_str(text).map_err(|e| format!("{source} 不是合法 JSON：{e}"))
}

/// 按序查找 config.json：开发期源码目录 → exe 同目录 → AppData。
/// 都找不到时回退到构建时编进二进制的配置（本地打包版会把 config.json 编进去，
/// CI 打包版不含，故公开安装包不会带密钥）。
#[tauri::command]
fn load_ai_config(app: tauri::AppHandle) -> Result<LoadedAiConfig, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 开发期：cargo run 的 exe 在 target/debug 下，会被 cargo clean 清掉，故用源码目录
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config.json"));

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("config.json"));
        }
    }
    if let Ok(dir) = app.path().app_config_dir() {
        candidates.push(dir.join("config.json"));
    }

    let searched = candidates
        .iter()
        .map(|p| format!("  {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n");

    // 文件优先：用户放一份就能覆盖内置配置，不必重新打包
    if let Some(path) = candidates.into_iter().find(|p| p.is_file()) {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
        return Ok(LoadedAiConfig {
            config: parse_config(&text, &path.display().to_string())?,
            path: path.display().to_string(),
        });
    }

    if !embedded::EMBEDDED_CONFIG.trim().is_empty() {
        return Ok(LoadedAiConfig {
            config: parse_config(embedded::EMBEDDED_CONFIG, "内置配置")?,
            path: "（安装包内置）".into(),
        });
    }

    Err(format!("未找到 config.json，已查找：\n{searched}"))
}

/// 决定把配置写回哪个文件：优先写回加载时用的那个（可能是源码目录或 exe 同目录）；
/// 加载时压根没有文件（走的是构建期内置兜底，path 会是「（安装包内置）」）则落到 AppData——
/// 那个目录本来就在 load_ai_config 的查找链里，下次启动能读到。
fn config_save_path(loaded_path: &str, app_dir: Option<&Path>) -> Result<PathBuf, String> {
    let loaded = Path::new(loaded_path);
    if loaded.is_file() {
        return Ok(loaded.to_path_buf());
    }
    app_dir
        .map(|dir| dir.join("config.json"))
        .ok_or_else(|| "没找到配置文件，也定位不到 AppData 目录".to_string())
}

/// 设置页保存 AI 配置，返回实际写入的路径（前端用它更新「配置来源」那行字）。
#[tauri::command]
fn save_ai_config(
    app: tauri::AppHandle,
    path: String,
    config: AiConfig,
) -> Result<String, String> {
    let app_dir = app.path().app_config_dir().ok();
    let target = config_save_path(&path, app_dir.as_deref())?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录 {} 失败：{e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化配置失败：{e}"))?;
    std::fs::write(&target, format!("{text}\n"))
        .map_err(|e| format!("写入 {} 失败：{e}", target.display()))?;
    Ok(target.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_png,
            load_ai_config,
            save_ai_config,
            ai::ai_arrange,
            ai::test_ai_connection,
            ai::fetch_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_path_reuses_the_loaded_file() {
        let dir = std::env::temp_dir().join("seatplan-save-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        std::fs::write(&file, "{}").unwrap();
        assert_eq!(
            config_save_path(&file.display().to_string(), None).unwrap(),
            file
        );
    }

    #[test]
    fn save_path_falls_back_to_app_dir_for_embedded_config() {
        let app = PathBuf::from("/tmp/seatplan-appdata");
        assert_eq!(
            config_save_path("（安装包内置）", Some(&app)).unwrap(),
            app.join("config.json")
        );
        // 既没文件也没 AppData → 明确报错，而不是写到一个瞎猜的路径
        assert!(config_save_path("（安装包内置）", None).is_err());
    }
}
