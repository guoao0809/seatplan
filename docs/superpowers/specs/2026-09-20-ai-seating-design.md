# AI 排座 —— 设计文档

日期：2026-09-20
状态：待评审

## 背景

老师每次手动调座位很费时。「公平」是个模糊概念——谁该往前排、谁该换到左边、某两个人上次是不是同桌过——用固定的轮转算法很难表达，但用自然语言描述很自然。

所以：提供一句话输入，交给大模型排座，代码只负责拼提示词、校验结果、渲染。

## 目标

在排座页工具条「导出图片」旁新增 **AI 排座** 按钮。点击后输入提示词 → 发送给 AI → 拿到排好的学生座位表 → 渲染到座位图。

## 范围

**做：**
- 工具条新增按钮 + 输入弹窗
- 读本地配置文件（OpenAI 兼容格式）
- 拼装 payload（当前网格 + 名单 + 历史记录 + 提示词）调用接口
- 严格校验 AI 返回，不通过则拒绝
- 预览后应用

**不做（第一版）：**
- 不做动作清单 / 约束求解器（AI 直接返回完整座位表）
- 不做设置界面（配置只有手写文件）
- 不做流式输出
- 不做多轮对话

## 数据流

```
工具条「AI 排座」→ 输入弹窗
  ↓ 提示词
拼 payload：当前网格 + 名单 + 最近历史 + 提示词
  ↓
调 OpenAI 兼容接口（配置来自 config.json）
  ↓ 返回整张座位表 JSON
校验（任一不过即拒绝，见「校验规则」）
  ↓
预览弹窗 →「应用」
  ↓
覆盖 seatGrid → persistGrid() → 播放换座动画
```

「上一次排的座位」取**当前屏幕上的网格**（要调整的就是眼前这张），另附最近 2 条导出记录（`records.ts`，可能为空），让 AI 能看到多轮轮换情况。公平与否由 AI 判断，这正是它优于固定轮转算法的地方。

**不新增快照存储**：当前网格本身已持久化在 `seatplan:grid`，导出记录已有 `records.ts`，两者合起来即是所需上下文。历史为空时 AI 只看当前网格，恰好就是「根据上一次排的座位」这个主场景。

## 技术选型

### 网络请求：`tauri-plugin-http`

Tauri 的 WebView 内直接 `fetch` 第三方 API 会被 CORS 拦截——多数模型厂商不返回 CORS 头。`tauri-plugin-http` 的 `fetch` 经 Rust 发出，绕过 CORS。

备选是在 `lib.rs` 用 `reqwest` 手写命令，代码更多且没有额外收益，故不采用。

需新增：
- `src-tauri/Cargo.toml` → `tauri-plugin-http = "2"`
- `package.json` → `@tauri-apps/plugin-http`
- `lib.rs` → `.plugin(tauri_plugin_http::init())`
- `src-tauri/capabilities/default.json` → 允许向用户配置的域名发请求

> 实施时需核对 capability 权限的确切写法（`http:default` 的 scope 如何覆盖动态 baseUrl），以实现时的插件文档为准。

### 配置文件

不写设置界面，用户手写 `config.json`。Rust 侧新增命令 `load_ai_config`，按序查找：

1. `src-tauri/config.json` —— **仅开发期**（`#[cfg(debug_assertions)]`，即 `CARGO_MANIFEST_DIR`）。`target/` 会被 `cargo clean` 清掉，所以不放 exe 同目录
2. exe 同目录（绿色版 / 便携版）
3. `%APPDATA%\com.seatplan.app\config.json`（安装版；装到 Program Files 时 exe 同目录不可写）

格式：

```json
{
  "baseUrl": "http://ai.medical-deep.com:20248/v1",
  "apiKey": "sk-xxx",
  "model": "deepseek-v4-pro",
  "temperature": 0.7
}
```

`baseUrl` **写到 `/v1` 为止**，代码拼接 `/chat/completions`——这是 OpenAI 兼容接口的通用约定（DeepSeek、通义、智谱、Kimi、OpenAI 一致）。

程序**只读不写**。UI 上显示实际命中哪个文件；找不到则提示去创建。

**安全**：`config.json` 含明文 API Key，已在 `.gitignore` 中（`config.json` 为无路径模式，覆盖任意层级）。已用 `git check-ignore` 验证不会被提交。

### 该网关的两个特征

- **明文 HTTP**：`http://`，非 HTTPS。API Key 以明文经网络传输。内网网关通常可接受，但需在 capability 里放行 `http://` 协议——只放行 `https://` 会直接请求失败。这是上文标记「实施时核对」的那处不确定点的具体形态。
- **无 `/v1` 前缀**：见上，由 `baseUrl` 承载。

## 提示词与校验

### 发给 AI 的 payload

```json
{
  "instruction": "根据上一次排的座位，自动左右调整，保证每个孩子都公平",
  "roster": ["陈玙宇", "李尹馨", "..."],
  "current": [[["陈玙宇", "李尹馨"], "..."]],
  "history": ["<最近 2 条导出记录的网格，可能为空>"],
  "shape": { "rows": [7, 7, 8, 8], "seatsPerRow": 2 }
}
```

系统提示要求 AI **只返回同形状的 JSON 网格**（姓名或 `null`），不含任何解释文字、不含 markdown 代码块围栏。

### 校验规则

全部通过才可应用，任一不过即拒绝并提示重试：

| 检查 | 不通过意味着 |
|---|---|
| 扁平化后的姓名集合与名单**完全一致**（不重、不漏、不增） | AI 写错或编造了名字 |
| 维度与 `shape` 完全一致 | AI 少给/多给了排或座 |
| 单座姓名保持不变 | 单座不在网格内，AI 无权改动 |

拒绝时**原样显示 AI 的返回并允许复制**——换模型或调提示词时需要看到它错在哪。

校验是必需项而非保险：让模型原样输出 60 个中文姓名，出错概率不低，尤其形近字。宁可重试，不可排错座位。

## UI

- **按钮**：工具条「导出图片」旁，图标 `Sparkles`，文案「AI 排座」
- **输入弹窗**：多行文本框（提示词）+ 显示配置文件路径 + 「开始排座」按钮；请求期间禁用并显示 loading
- **预览弹窗**：只读网格展示 AI 结果（复用现有座位格样式）+ 「应用」「放弃」

请求失败 / 校验不通过：在弹窗内红字提示原因，保留输入内容，可重试。

## 改动文件

| 文件 | 改动 |
|---|---|
| `src/lib/ai.ts` | **新增**：拼 payload、构造提示词、解析与校验返回、`runAiSelfCheck()` |
| `src-tauri/src/lib.rs` | 新增 `load_ai_config` 命令；注册 http 插件 |
| `src-tauri/Cargo.toml` | 加 `tauri-plugin-http` |
| `src-tauri/capabilities/default.json` | 加 http 权限 |
| `package.json` | 加 `@tauri-apps/plugin-http` |
| `src/views/SeatView.vue` | 工具条按钮 + 两个弹窗 + 应用逻辑 |

## 错误处理

| 情况 | 表现 |
|---|---|
| 找不到 `config.json` | 弹窗内提示路径，给「重新读取」按钮 |
| 网络/接口报错（超时、401、限流） | 显示 HTTP 状态与接口返回的 message |
| 返回不是合法 JSON | 显示原始文本，提示换模型重试 |
| 校验不通过 | 指出具体哪条不过（如「多了 2 个名字」「第 3 组排数不符」），并显示原始返回 |
| 配置里 baseUrl/apiKey 为空 | 提前拦截，不发请求 |

## 验证方式

- `src/lib/ai.ts` 的校验函数带自检（沿用 `seat.ts` 的 `runSelfCheck()` 风格）：构造「正常 / 漏名字 / 多名字 / 重名 / 维度不符 / 单座被改」六组样例，断言前一组通过、后五组被拒。DEV 启动时执行。
- 端到端手动验证：配好 key → 输入提示词 → 确认排座结果符合描述 → 应用后网格正确。
- `pnpm build`（含 `vue-tsc --noEmit`）通过。

## 已知风险

- **模型输出不稳定**：同样提示词可能得到不同结果。可接受——预览这一步就是为此设的。`temperature` 放进配置项便于调低。
- **大名单**：60 人约 1~2k input token，成本可忽略；但名单规模远超此数时输出长度可能触顶。第一版不处理，遇到再加分批。
