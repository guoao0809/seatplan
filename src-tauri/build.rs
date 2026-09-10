fn main() {
    // 图标变化时强制重新运行 build script，避免 dev 模式复用旧图标
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
