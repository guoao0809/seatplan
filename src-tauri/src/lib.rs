//! Tauri 应用入口：最小壳 + 保存座位图 + AI 排座。

mod ai;

use ai::AiConfig;
use std::path::PathBuf;
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

/// 按序查找 config.json：开发期源码目录 → exe 同目录 → AppData。
/// 只读不写；找不到时把所有查找过的路径一并报出，便于用户放置。
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

    let path = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| format!("未找到 config.json，已查找：\n{searched}"))?;

    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let config: AiConfig = serde_json::from_str(&text)
        .map_err(|e| format!("{} 不是合法 JSON：{e}", path.display()))?;

    Ok(LoadedAiConfig {
        config,
        path: path.display().to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_png,
            load_ai_config,
            ai::ai_arrange
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
