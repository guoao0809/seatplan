# AI 排座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在排座页工具条「导出图片」旁加「AI 排座」按钮：输入一句自然语言要求 → 发给大模型 → 模型返回调整后的座位表 → 校验通过 → 预览 → 应用到座位图。

**Architecture:** 请求走 Rust 侧 `reqwest`（WebView 直接 fetch 会被 CORS 拦截），URL 拼接与请求实现移植自已跑通的 `D:\wok\worknotes\gitreport\src-tauri\src\ai.rs`。密钥从用户手写的 `config.json` 读取，程序只读不写。前端 `src/lib/ai.ts` 负责拼提示词、解析并严格校验模型返回（姓名集合必须与当前座位完全一致，否则拒绝）。校验逻辑纯函数、可独立自检。

**Tech Stack:** Tauri 2 + Rust (`reqwest` blocking) + Vue 3 + TypeScript + Tailwind 4 + lucide-vue-next

## Global Constraints

- TypeScript `strict: true`；索引数组元素统一加 `!`（与 `src/lib/seat.ts` 现有风格一致）
- 座位格样式统一 `flex h-14 w-24 ... rounded-lg text-sm font-medium`，已坐 `bg-[#86C166] text-white`，空位 `bg-surface border border-dashed border-border text-muted`
- 弹窗结构统一：遮罩 `fixed inset-0 z-40 flex items-center justify-center bg-black/40` + `@click.self` 关闭，面板 `rounded-xl bg-panel shadow-2xl`
- 提示统一走 `showToast(msg, "success" | "error" | "info")`（`src/components/toast.ts`），Toast 显示在右上角
- `config.json` 含明文密钥，已在 `.gitignore`（任意层级）——**任何时候不得提交**
- git commit message 不加任何 `Co-Authored-By` 署名
- 每个 Task 结束必须提交（frequent commits）
- 自检函数风格沿用 `src/lib/seat.ts` 的 `runSelfCheck()`：失败抛 `Error`，`import.meta.env.DEV` 时在 `onMounted` 调用

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src-tauri/src/ai.rs`（新增） | URL 拼接、HTTP POST、响应取文本、`ai_arrange` 命令、单元测试 |
| `src-tauri/src/lib.rs`（修改） | 声明 `mod ai`、`load_ai_config` 命令、注册两个命令 |
| `src-tauri/Cargo.toml`（修改） | 加 `reqwest` 依赖 |
| `src/lib/ai.ts`（新增） | 纯函数：拼提示词、剥围栏、解析、校验、自检；加两个 invoke 包装 |
| `src/views/SeatView.vue`（修改） | 工具条按钮、AI 弹窗（输入态 / 预览态）、应用逻辑 |
| `src-tauri/config.json`（已存在） | 用户手写配置，**不进版本库** |
| `README.md`（修改） | 补 AI 排座的配置说明 |

---

### Task 1: Rust AI 调用模块

**Files:**
- Create: `src-tauri/src/ai.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs:1-3`（只加 `mod ai;`，命令注册留到 Task 2）

**Interfaces:**
- Consumes: 无
- Produces:
  - `pub struct AiConfig { base_url: String, api_key: String, model: String, temperature: Option<f64> }`（serde `camelCase`，对应 JSON 的 `baseUrl` / `apiKey` / `model` / `temperature`）
  - `#[tauri::command] pub fn ai_arrange(config: AiConfig, system: String, user: String) -> Result<String, String>`
  - 私有：`normalize_base(&str) -> String`、`request_url(&str) -> String`

- [ ] **Step 1: 加依赖**

修改 `src-tauri/Cargo.toml`，在 `[dependencies]` 段末尾追加一行：

```toml
reqwest = { version = "0.12", features = ["json", "blocking"] }
```

- [ ] **Step 2: 写测试 + 空实现（先让它失败）**

创建 `src-tauri/src/ai.rs`：

```rust
//! AI 排座接口调用（OpenAI 兼容协议）。
//! URL 拼接与请求实现移植自 D:\wok\worknotes\gitreport\src-tauri\src\ai.rs。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// Base URL 智能拼接：去掉尾部 '/'；不以 /v1 或 /chat/completions 结尾则补 /v1。
fn normalize_base(_base_url: &str) -> String {
    String::new() // 占位，下一步实现
}

/// 构造 chat completions 请求 URL
fn request_url(_base_url: &str) -> String {
    String::new() // 占位，下一步实现
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_appends_v1_when_missing() {
        assert_eq!(
            normalize_base("http://ai.medical-deep.com:20248"),
            "http://ai.medical-deep.com:20248/v1"
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
            request_url("http://ai.medical-deep.com:20248"),
            "http://ai.medical-deep.com:20248/v1/chat/completions"
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
}
```

- [ ] **Step 3: 声明模块，确认测试失败**

修改 `src-tauri/src/lib.rs`，在文件顶部 `//!` 文档注释之后加一行：

```rust
mod ai;
```

运行：

```bash
cd src-tauri && cargo test
```

预期：编译通过，`normalize_appends_v1_when_missing` 等 4 个测试 **FAIL**（返回空串不等于期望值）。

- [ ] **Step 4: 实现 URL 拼接，让测试通过**

把 `src-tauri/src/ai.rs` 里两个占位函数替换为真实实现：

```rust
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
```

运行：

```bash
cd src-tauri && cargo test
```

预期：6 个测试全部 **PASS**。

- [ ] **Step 5: 实现 HTTP 调用与命令**

在 `src-tauri/src/ai.rs` 的 `request_url` 之后、`#[cfg(test)]` 之前插入：

```rust
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

/// 调 AI 排座，返回模型输出的原始文本（解析与校验交给前端）
#[tauri::command]
pub fn ai_arrange(config: AiConfig, system: String, user: String) -> Result<String, String> {
    if config.base_url.trim().is_empty() {
        return Err("配置里的 baseUrl 为空".into());
    }
    if config.api_key.trim().is_empty() {
        return Err("配置里的 apiKey 为空".into());
    }
    if config.model.trim().is_empty() {
        return Err("配置里的 model 为空".into());
    }

    let url = request_url(&config.base_url);
    let body = json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": config.temperature.unwrap_or(0.7),
        "stream": false
    });

    let text = post_json(&url, &config, &body)?;
    extract_text(&text)
}
```

- [ ] **Step 6: 确认编译通过、测试仍全绿**

运行：

```bash
cd src-tauri && cargo test
```

预期：6 个测试 PASS，无 warning。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/ai.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(ai): Rust 侧 AI 排座调用模块（URL 拼接 + reqwest + ai_arrange 命令）"
```

---

### Task 2: 读取 config.json

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ai::AiConfig`（Task 1）
- Produces:
  - `#[tauri::command] fn load_ai_config(app: tauri::AppHandle) -> Result<LoadedAiConfig, String>`，序列化为 `{ "config": AiConfig, "path": String }`
  - 注册 `save_png`、`load_ai_config`、`ai_arrange` 三个命令

- [ ] **Step 1: 改 `src-tauri/src/lib.rs`**

整个文件替换为：

```rust
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
```

- [ ] **Step 2: 确认编译通过**

```bash
cd src-tauri && cargo test
```

预期：编译通过，6 个测试仍 PASS。

- [ ] **Step 3: 在 README 补配置说明**

打开 `README.md`，找到 `## 开发` 章节的结尾（`> pnpm tauri dev 报 Port 1420 is already in use 时…` 那段引用块之后），在其后插入新章节：

```markdown
## AI 排座配置

「AI 排座」需要一个 OpenAI 兼容接口。在下列任一位置放一个 `config.json`（程序只读，不会改写）：

1. **开发期**：`src-tauri/config.json`
2. **便携版**：与 `seatplan.exe` 同目录
3. **安装版**：`%APPDATA%\com.seatplan.app\config.json`

```json
{
  "baseUrl": "http://ai.medical-deep.com:20248",
  "apiKey": "sk-your-key",
  "model": "deepseek-v4-pro",
  "temperature": 0.7
}
```

- `baseUrl` 不写 `/v1` 也可以，程序会自动补上；DeepSeek、通义、智谱、Kimi、OpenAI 的官方地址同样适用
- `temperature` 可省略，默认 `0.7`
- 该文件已被 `.gitignore` 忽略（含明文密钥，**不要提交**）

找不到或格式错误时，AI 弹窗会直接显示实际查找过的路径。
```

- [ ] **Step 4: 手动验证配置能读到**

```bash
pnpm tauri dev
```

预期：应用正常启动（此时前端还没调 `load_ai_config`，只是确认加了 `mod ai` 和 `reqwest` 后仍能构建运行）。若报端口占用，先执行 README 里那条杀进程命令。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lib.rs README.md
git commit -m "feat(ai): 按序查找并读取 config.json；README 补配置说明"
```

---

### Task 3: 提示词拼装与结果校验（TS）

**Files:**
- Create: `src/lib/ai.ts`

**Interfaces:**
- Consumes: 无（`src/lib/ai.ts` 不 import 任何东西，保证可被 Node 独立执行）
- Produces:
  - `interface AiConfig { baseUrl: string; apiKey: string; model: string; temperature?: number }`
  - `interface LoadedAiConfig { config: AiConfig; path: string }`
  - `interface ArrangeInput { grid: (string|null)[][][]; singleSeatName: string; history: (string|null)[][][][]; instruction: string; rows: number[]; seatsPerRow: number }`
  - `type ParseResult = { ok: true; grid: (string|null)[][][] } | { ok: false; reason: string }`
  - `flattenNames(grid: (string|null)[][][]): string[]`
  - `buildMessages(input: ArrangeInput): { system: string; user: string }`
  - `stripToJson(text: string): string`
  - `validateGrid(raw: unknown, rows: number[], seatsPerRow: number, expectedNames: string[]): string | null`
  - `parseArrangement(text: string, rows: number[], seatsPerRow: number, expectedNames: string[]): ParseResult`
  - `runAiSelfCheck(): void`
  - `loadAiConfig(): Promise<LoadedAiConfig>`
  - `arrangeSeats(config: AiConfig, system: string, user: string): Promise<string>`

- [ ] **Step 1: 写自检 + 空实现（先让它失败）**

创建 `src/lib/ai.ts`：

```ts
// AI 排座：拼提示词、解析并校验模型返回的座位表。
// 本文件不含任何静态 import，可独立自检：node --experimental-strip-types src/lib/ai.ts

/** config.json 的内容（OpenAI 兼容） */
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

/** Rust load_ai_config 的返回 */
export interface LoadedAiConfig {
  config: AiConfig;
  path: string;
}

export interface ArrangeInput {
  /** 当前网格：组 → 排 → 座 → 姓名或 null */
  grid: (string | null)[][][];
  /** 单座学生姓名（不参与网格排座，仅作上下文） */
  singleSeatName: string;
  /** 最近几次历史网格（最新在前） */
  history: (string | null)[][][][];
  /** 用户的自然语言要求 */
  instruction: string;
  /** 每组排数 */
  rows: number[];
  /** 每排座位数 */
  seatsPerRow: number;
}

export type ParseResult =
  | { ok: true; grid: (string | null)[][][] }
  | { ok: false; reason: string };

/** 展平网格，取出所有非空姓名 */
export function flattenNames(grid: (string | null)[][][]): string[] {
  return []; // 占位，下一步实现
}

/** 构造发给 AI 的两条消息 */
export function buildMessages(input: ArrangeInput): { system: string; user: string } {
  return { system: "", user: "" }; // 占位，下一步实现
}

/** 剥掉 markdown 代码块围栏与前后闲话，取出 JSON 文本 */
export function stripToJson(text: string): string {
  return text; // 占位，下一步实现
}

/** 校验网格结构与姓名集合；通过返回 null，否则返回中文原因 */
export function validateGrid(
  _raw: unknown,
  _rows: number[],
  _seatsPerRow: number,
  _expectedNames: string[],
): string | null {
  return null; // 占位，下一步实现
}

/** 解析 + 校验 AI 返回 */
export function parseArrangement(
  text: string,
  rows: number[],
  seatsPerRow: number,
  expectedNames: string[],
): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripToJson(text));
  } catch (e) {
    return { ok: false, reason: `返回不是合法 JSON：${e}` };
  }
  const reason = validateGrid(raw, rows, seatsPerRow, expectedNames);
  if (reason) return { ok: false, reason };
  return { ok: true, grid: raw as (string | null)[][][] };
}

/** 自检：样例该过的过、该拒的拒；失败抛 Error */
export function runAiSelfCheck(): void {
  const rows = [2, 2];
  const seatsPerRow = 2;
  const expected = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const good: (string | null)[][][] = [
    [
      ["甲", "乙"],
      ["丙", "丁"],
    ],
    [
      ["戊", "己"],
      ["庚", "辛"],
    ],
  ];
  const cases: Array<[string, unknown, boolean]> = [
    ["正常", good, true],
    [
      "漏名字",
      [
        [
          ["甲", "乙"],
          ["丙", "丁"],
        ],
        [
          ["戊", "己"],
          ["庚", null],
        ],
      ],
      false,
    ],
    ["组数不符", [good[0]], false],
    [
      "排数不符",
      [
        [["甲", "乙"]],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    [
      "座位数不符",
      [
        [
          ["甲", "乙", "丙"],
          ["丁"],
        ],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    [
      "重名",
      [
        [
          ["甲", "甲"],
          ["丙", "丁"],
        ],
        [
          ["戊", "己"],
          ["庚", "辛"],
        ],
      ],
      false,
    ],
    ["不是数组", { a: 1 }, false],
  ];

  for (const [name, raw, shouldPass] of cases) {
    const reason = validateGrid(raw, rows, seatsPerRow, expected);
    const passed = reason === null;
    if (passed !== shouldPass) {
      throw new Error(
        `样例「${name}」期望${shouldPass ? "通过" : "被拒"}，实际${passed ? "通过" : `被拒（${reason}）`}`,
      );
    }
  }

  // 展平
  if (flattenNames(good).length !== 8) throw new Error("flattenNames 应取到 8 个姓名");

  // 带 markdown 围栏与前后闲话的返回也要能剥出来
  const wrapped = "好的，结果如下：\n```json\n" + JSON.stringify(good) + "\n```\n以上。";
  const r = parseArrangement(wrapped, rows, seatsPerRow, expected);
  if (!r.ok) throw new Error(`带围栏的返回应能解析，实际被拒：${r.reason}`);

  // 凭空多出一个名字必须被拒
  const extra = JSON.parse(JSON.stringify(good)) as (string | null)[][][];
  extra[1]![1]![1] = "壬";
  if (validateGrid(extra, rows, seatsPerRow, expected) === null)
    throw new Error("多出未在名单中的姓名应被拒绝");
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/ai.ts`
declare const process:
  | { stdout: { write: (s: string) => void } }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runAiSelfCheck();
  process.stdout.write("ai 自检通过\n");
}
```

- [ ] **Step 2: 运行自检，确认失败**

```bash
node --experimental-strip-types src/lib/ai.ts
```

预期：**FAIL**，抛 `Error: 样例「漏名字」期望被拒，实际通过`（因为 `validateGrid` 还是永远返回 `null` 的占位）。

- [ ] **Step 3: 实现四个纯函数**

把 `src/lib/ai.ts` 中的 `flattenNames`、`buildMessages`、`stripToJson`、`validateGrid` 四个占位替换为：

```ts
/** 展平网格，取出所有非空姓名 */
export function flattenNames(grid: (string | null)[][][]): string[] {
  const out: string[] = [];
  for (const g of grid) for (const r of g) for (const n of r) if (n) out.push(n);
  return out;
}

const SYSTEM_PROMPT = [
  "你是教室排座助手。用户给你当前座位表和一句排座要求，你返回调整后的座位表。",
  "",
  "硬性规则：",
  "1. 只返回 JSON，不要任何解释文字，不要 markdown 代码块围栏。",
  "2. 返回的网格维度必须与 current 完全一致：组数、每组排数、每排座位数都不能变。",
  "3. 只能使用 roster 中出现的姓名，一个不多一个不少；不允许改名、不允许编造姓名。",
  "4. 空座位保持为 null。",
  "5. roster 中位于 singleSeat 的姓名不要放进网格。",
].join("\n");

/** 构造发给 AI 的两条消息 */
export function buildMessages(input: ArrangeInput): { system: string; user: string } {
  const inGrid = flattenNames(input.grid);
  const payload = {
    instruction: input.instruction,
    shape: { rows: input.rows, seatsPerRow: input.seatsPerRow },
    singleSeat: input.singleSeatName || null,
    roster: input.singleSeatName ? [...inGrid, input.singleSeatName] : inGrid,
    current: input.grid,
    history: input.history,
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

/** 剥掉 markdown 代码块围栏与前后闲话，取出 JSON 文本 */
export function stripToJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** 校验网格结构与姓名集合；通过返回 null，否则返回中文原因 */
export function validateGrid(
  raw: unknown,
  rows: number[],
  seatsPerRow: number,
  expectedNames: string[],
): string | null {
  if (!Array.isArray(raw)) return "返回的不是数组";
  if (raw.length !== rows.length)
    return `组数不符：应为 ${rows.length} 组，实际 ${raw.length} 组`;

  const names: string[] = [];
  for (let g = 0; g < rows.length; g++) {
    const grp = raw[g];
    if (!Array.isArray(grp)) return `第 ${g + 1} 组不是数组`;
    if (grp.length !== rows[g])
      return `第 ${g + 1} 组排数不符：应为 ${rows[g]} 排，实际 ${grp.length} 排`;
    for (let r = 0; r < rows[g]!; r++) {
      const row = grp[r];
      if (!Array.isArray(row)) return `第 ${g + 1} 组第 ${r + 1} 排不是数组`;
      if (row.length !== seatsPerRow)
        return `第 ${g + 1} 组第 ${r + 1} 排座位数不符：应为 ${seatsPerRow} 座，实际 ${row.length} 座`;
      for (const seat of row) {
        if (seat !== null && typeof seat !== "string")
          return `座位值只能是姓名或 null，实际是 ${typeof seat}`;
        if (seat) names.push(seat);
      }
    }
  }

  // 姓名多重集比对（重名也要能被正确检出）
  const tally = (list: string[]) => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const got = tally(names);
  const want = tally(expectedNames);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [n, c] of want) {
    const d = c - (got.get(n) ?? 0);
    if (d > 0) missing.push(d > 1 ? `${n}×${d}` : n);
  }
  for (const [n, c] of got) {
    const d = c - (want.get(n) ?? 0);
    if (d > 0) extra.push(d > 1 ? `${n}×${d}` : n);
  }
  if (missing.length || extra.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`少了 ${missing.length} 个：${missing.join("、")}`);
    if (extra.length) parts.push(`多了 ${extra.length} 个：${extra.join("、")}`);
    return `姓名对不上（${parts.join("；")}）`;
  }
  return null;
}
```

- [ ] **Step 4: 运行自检，确认通过**

```bash
node --experimental-strip-types src/lib/ai.ts
```

预期：输出 `ai 自检通过`。

- [ ] **Step 5: 加两个 invoke 包装**

在 `src/lib/ai.ts` 末尾（自检触发块**之前**）插入。这里用动态 `import()` 而非顶层 import，是为了让本文件保持无静态依赖、可被 Node 直接执行：

```ts
// ===== 与 Rust 通信（动态 import，保持本文件可独立自检）=====

/** 读取本地 config.json（Rust 侧按序查找） */
export async function loadAiConfig(): Promise<LoadedAiConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoadedAiConfig>("load_ai_config");
}

/** 调 AI 排座，返回模型输出的原始文本 */
export async function arrangeSeats(
  config: AiConfig,
  system: string,
  user: string,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("ai_arrange", { config, system, user });
}
```

- [ ] **Step 6: 再跑一次自检，并做类型检查**

```bash
node --experimental-strip-types src/lib/ai.ts && npx vue-tsc --noEmit -p tsconfig.json
```

预期：输出 `ai 自检通过`，且 `vue-tsc` 无输出（无错误）。

- [ ] **Step 7: 提交**

```bash
git add src/lib/ai.ts
git commit -m "feat(ai): 前端提示词拼装与返回校验（含自检）"
```

---

### Task 4: 工具条按钮与 AI 弹窗

**Files:**
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- Consumes: Task 3 的 `loadAiConfig`、`arrangeSeats`、`buildMessages`、`parseArrangement`、`flattenNames`、`runAiSelfCheck`、`AiConfig`
- Produces: 无（终端界面）

- [ ] **Step 1: 扩充 import**

`src/views/SeatView.vue` 第 3 行的 lucide 导入改为：

```ts
import {
  ClipboardList,
  Eraser,
  Settings,
  X,
  Download,
  ArrowUpDown,
  Presentation,
  GraduationCap,
  Sparkles,
  LoaderCircle,
} from "lucide-vue-next";
```

在同文件 `import { showToast } from "../components/toast";` 这一行之前，插入：

```ts
import {
  loadAiConfig,
  arrangeSeats,
  buildMessages,
  parseArrangement,
  flattenNames,
  runAiSelfCheck,
  type AiConfig,
} from "../lib/ai";
```

- [ ] **Step 2: 加状态与逻辑**

在 `<script setup>` 中 `// 弹窗开关（名单 / 配置）` 那两个 `ref` 之后，插入：

```ts
// AI 排座
const showAi = ref(false);
const aiPrompt = ref("根据上一次排的座位，自动左右调整，保证每个孩子都公平");
const aiBusy = ref(false);
const aiError = ref("");
const aiConfigPath = ref("");
const aiConfig = ref<AiConfig | null>(null);
const aiPreview = ref<(string | null)[][][] | null>(null);

const aiPreviewNames = computed(() =>
  aiPreview.value ? flattenNames(aiPreview.value).length : 0,
);

/** 当前网格的纯数据快照（组 → 排 → 座 → 姓名或 null） */
function currentGrid(): (string | null)[][][] {
  return seatGrid.value.map((g) => g.rows.map((r) => r.seats.map((s) => s.name)));
}
```

在 `toggleReverseGroups` 函数之后，插入：

```ts
/** 打开 AI 弹窗并读取配置 */
async function openAi() {
  aiError.value = "";
  aiPreview.value = null;
  aiConfigPath.value = "";
  aiConfig.value = null;
  showAi.value = true;
  try {
    const loaded = await loadAiConfig();
    aiConfig.value = loaded.config;
    aiConfigPath.value = loaded.path;
  } catch (e) {
    aiError.value = String(e);
  }
}

function closeAi() {
  if (aiBusy.value) return;
  showAi.value = false;
  aiPreview.value = null;
  aiError.value = "";
}

/** 发送给 AI，校验返回；通过则进入预览态 */
async function runAi() {
  const cfg = aiConfig.value;
  if (!cfg) {
    aiError.value = "配置未加载，请检查 config.json";
    return;
  }
  aiBusy.value = true;
  aiError.value = "";
  try {
    const grid = currentGrid();
    const messages = buildMessages({
      grid,
      singleSeatName: singleSeatName.value,
      history: loadRecords()
        .slice(0, 2)
        .map((r) => r.grid),
      instruction: aiPrompt.value.trim(),
      rows: rows.value,
      seatsPerRow: seatCount.value,
    });
    const text = await arrangeSeats(cfg, messages.system, messages.user);
    const res = parseArrangement(text, rows.value, seatCount.value, flattenNames(grid));
    if (!res.ok) {
      aiError.value = `校验未通过：${res.reason}\n\n模型原始返回：\n${text}`;
      return;
    }
    aiPreview.value = res.grid;
  } catch (e) {
    aiError.value = String(e);
  } finally {
    aiBusy.value = false;
  }
}

/** 把预览结果写入座位图并持久化 */
function applyAi() {
  const g = aiPreview.value;
  if (!g) return;
  seatGrid.value = g.map((rowsArr, gi) => ({
    label: groupLabel(gi, g.length, reverseGroups.value),
    rows: rowsArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
  }));
  persistGrid();
  showAi.value = false;
  aiPreview.value = null;
  showToast("已应用 AI 排座结果", "success");
}
```

- [ ] **Step 3: onMounted 里加自检**

找到 `onMounted` 中的这一行：

```ts
  if (import.meta.env.DEV) runSelfCheck();
```

替换为：

```ts
  if (import.meta.env.DEV) {
    runSelfCheck();
    runAiSelfCheck();
  }
```

- [ ] **Step 4: 加工具条按钮**

在模板中「导出图片」按钮的 `</button>` 之后、`<span class="ml-auto ...">` 之前插入：

```vue
      <button
        class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
        @click="openAi"
      >
        <Sparkles :size="14" />
        AI 排座
      </button>
```

- [ ] **Step 5: 加 AI 弹窗**

在模板末尾插入。定位方式：模板的根元素是 `<div class="flex h-full flex-col">`，其闭合 `</div>` 紧邻 `</template>` 之前；把下面这段放在那个闭合标签**之前**（即紧跟「配置弹窗」的 `</div>` 之后）：

```vue
    <!-- AI 排座弹窗：输入态 → 预览态 → 应用 -->
    <div
      v-if="showAi"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      @click.self="closeAi"
    >
      <div class="flex max-h-[88vh] w-[min(92vw,1040px)] flex-col rounded-xl bg-panel shadow-2xl">
        <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span class="text-sm font-medium text-title">
            {{ aiPreview ? "AI 排座结果预览" : "AI 排座" }}
          </span>
          <button
            class="rounded p-1 text-muted hover:bg-surface hover:text-title"
            @click="closeAi"
          >
            <X :size="16" />
          </button>
        </div>

        <!-- 输入态 -->
        <div v-if="!aiPreview" class="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          <textarea
            v-model="aiPrompt"
            rows="5"
            placeholder="描述你想要的排座方式…"
            class="h-32 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-title outline-none focus:border-primary"
          ></textarea>
          <div class="flex items-center gap-2 text-xs text-muted">
            <template v-if="aiConfigPath">配置文件：{{ aiConfigPath }}</template>
            <template v-else>正在读取配置…</template>
            <button
              class="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary"
              @click="openAi"
            >
              重新读取
            </button>
          </div>
          <div
            v-if="aiError"
            class="max-h-56 overflow-y-auto rounded-lg bg-red-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-red-600"
          >
            {{ aiError }}
          </div>
        </div>

        <!-- 预览态 -->
        <div v-else class="min-h-0 flex-1 overflow-auto p-5">
          <div class="flex items-start gap-6">
            <div v-for="(g, gi) in aiPreview" :key="gi" class="flex flex-col items-center gap-1.5">
              <div class="text-xs font-medium text-muted">
                {{ groupLabel(gi, aiPreview.length, reverseGroups) }}
              </div>
              <div class="flex flex-col gap-1.5">
                <div v-for="(row, ri) in g" :key="ri" class="flex gap-1.5">
                  <div
                    v-for="(name, si) in row"
                    :key="si"
                    class="flex h-9 w-16 items-center justify-center rounded-md text-xs font-medium"
                    :class="
                      name
                        ? 'bg-[#86C166] text-white'
                        : 'bg-surface border border-dashed border-border text-muted'
                    "
                  >
                    {{ name || "—" }}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="mt-4 text-xs text-muted">
            共 {{ aiPreviewNames }} 人排入网格；单座：{{ singleSeatName || "—" }}（不参与调整）
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <template v-if="!aiPreview">
            <button
              class="rounded-lg border border-border px-4 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
              @click="closeAi"
            >
              取消
            </button>
            <button
              class="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
              :disabled="aiBusy || !aiPrompt.trim()"
              @click="runAi"
            >
              <LoaderCircle v-if="aiBusy" :size="14" class="animate-spin" />
              {{ aiBusy ? "排座中…" : "开始排座" }}
            </button>
          </template>
          <template v-else>
            <button
              class="rounded-lg border border-border px-4 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
              @click="aiPreview = null"
            >
              返回修改
            </button>
            <button
              class="rounded-lg bg-primary px-4 py-1.5 text-xs text-white hover:opacity-90"
              @click="applyAi"
            >
              应用到座位图
            </button>
          </template>
        </div>
      </div>
    </div>
```

- [ ] **Step 6: 类型检查**

```bash
npx vue-tsc --noEmit -p tsconfig.json
```

预期：无输出（无错误）。

- [ ] **Step 7: 启动应用手动走一遍**

```bash
pnpm tauri dev
```

预期：
1. 工具条出现「AI 排座」按钮
2. 点击后弹窗打开，显示配置文件路径（应为 `D:\wok\worknotes\seatplan\src-tauri\config.json`）
3. 输入要求，点「开始排座」→ 按钮变「排座中…」并转圈
4. 返回通过校验 → 切到预览态，网格可读、无倒置
5. 点「应用到座位图」→ 弹窗关闭、主座位图变为 AI 结果、右上角 Toast 提示
6. 点「返回修改」→ 回到输入态，提示词保留

- [ ] **Step 8: 提交**

```bash
git add src/views/SeatView.vue
git commit -m "feat(ai): 工具条 AI 排座按钮、提示词输入与结果预览弹窗"
```

---

### Task 5: 端到端验证与失败路径

**Files:**
- Modify: `src/views/SeatView.vue`（仅在发现问题时）

**Interfaces:**
- Consumes: Task 1–4 的全部产物
- Produces: 无

- [ ] **Step 1: 验证正常路径**

`pnpm tauri dev`，工具栏「学生名单」确认有默认 60 人 → 点「AI 排座」→ 用默认提示词 → 「开始排座」。

预期：预览中的姓名与调整前**完全同一批人**，且位置有变化（左右/前后发生轮换）。点「应用到座位图」后主图正确。

- [ ] **Step 2: 验证配置缺失的提示**

临时把 `src-tauri/config.json` 改名为 `config.json.bak`，重启应用，点「AI 排座」。

预期：弹窗内红字列出**三条查找过的路径**，不发请求。

恢复：改回 `config.json`。

- [ ] **Step 3: 验证密钥错误的提示**

把 `config.json` 里 `apiKey` 改成 `sk-错误的key`，重启，点「AI 排座」→「开始排座」。

预期：红字显示 `AI 接口返回错误（HTTP 401）…`，弹窗保持输入态，提示词不丢。

恢复：改回正确 key。

- [ ] **Step 4: 验证校验拦截**

把 `config.json` 的 `model` 改成一个能力很弱或不存在的行为异常的模型（如 `gpt-3.5-turbo`），点「开始排座」。

预期：要么接口报错，要么走校验分支——红字显示 `校验未通过：…` **并附上模型原始返回**，主座位图**没有被改动**。

恢复：改回 `deepseek-v4-pro`。

- [ ] **Step 5: 验证拖拽与视角未被破坏**

应用一次 AI 结果后，依次确认：
1. 拖动一个座位到另一个座位 → 两人交换，换座动画正常
2. 点「老师视角」→ 整块翻转，讲台在右下方，姓名不倒置
3. 点「学生视角」→ 复原

- [ ] **Step 6: 最终检查并提交**

```bash
node --experimental-strip-types src/lib/ai.ts
cd src-tauri && cargo test && cd ..
npx vue-tsc --noEmit -p tsconfig.json
pnpm build
```

预期：四条全部通过（自检输出 `ai 自检通过`、cargo 6 个测试 PASS、vue-tsc 无输出、vite build 成功）。

```bash
git add -A
git commit -m "test(ai): 端到端验证失败路径与既有功能回归"
```

---

## 未决风险（实现时留意）

1. **同步 Tauri command 里用 `reqwest::blocking`**：`ai_arrange` 是同步 `fn`，最长阻塞 120s。gitreport 用同样写法已验证可行。若实测发现 UI 卡死，改为 `pub async fn ai_arrange(...)` 并把 `post_json` 包进 `tauri::async_runtime::spawn_blocking`——改动局限在 `ai.rs`。
2. **模型可能返回超长输出**：60 人约 1~2k output token，正常。名单规模翻倍时若触发截断，`JSON.parse` 会失败并显示原始文本，属于已知且可见的失败，不静默出错。
3. **`app.path()` 的 API 形态**：`tauri::Manager` trait 提供 `path()`，返回的 `app_config_dir()` 在 Tauri v2 为 `Result<PathBuf>`。若编译报错，对照 `tauri` 2.x 文档核对后调整——影响范围仅 `load_ai_config` 一个函数。
