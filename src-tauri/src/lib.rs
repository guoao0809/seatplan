//! Tauri 应用入口：最小壳 + 保存座位图命令。

mod ai;

/// 把前端传来的 PNG 字节写入用户指定的路径（std::fs，绕开 fs 插件权限作用域）。
#[tauri::command]
fn save_png(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_png])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
