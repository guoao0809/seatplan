use std::path::PathBuf;

/// 把 config.json 的内容编进二进制，作为「找不到配置文件时」的兜底。
///
/// 这样两边都满足：
/// - 本地构建（src-tauri/config.json 存在，含真实密钥）→ 装完即用，无需用户配置
/// - CI 构建（该文件被 gitignore，不存在）→ 编进去的是空串，公开的安装包里不含密钥
///
/// 注意：编进去的密钥能从二进制里被提取出来，所以带密钥的安装包只应私下分发，
/// 不要上传到公开的 Release。
fn embed_config() {
    const CONFIG: &str = "config.json";
    // config.json 变化时重新运行本脚本
    println!("cargo:rerun-if-changed={CONFIG}");

    let content = std::fs::read_to_string(CONFIG).unwrap_or_default();
    // 用 {:?} 生成合法的 Rust 字符串字面量（自动转义引号、反斜杠、换行）
    let generated = format!("pub const EMBEDDED_CONFIG: &str = {content:?};\n");

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"))
        .join("embedded_config.rs");
    std::fs::write(&out, generated).expect("写入 embedded_config.rs 失败");
}

fn main() {
    // 图标变化时强制重新运行 build script，避免 dev 模式复用旧图标
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // build script 的工作目录就是 src-tauri/，直接找同目录的 config.json
    embed_config();
    tauri_build::build()
}
