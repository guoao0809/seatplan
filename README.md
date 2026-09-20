<div align="center">

# 教室排座 SeatPlan

**给老师用的教室座位表工具** — 填好名单，自动排座，拖拽换座，一键导出图片。

[![Release](https://img.shields.io/github/v/release/guoao0809/seatplan?label=下载&color=4F6BF6)](https://github.com/guoao0809/seatplan/releases/latest)

</div>

## 功能

- **自动排座** — 按「组 × 排 × 每排座位数」把名单依次填满，容量不足自动留空位
- **AI 排座** — 输入一句自然语言（如「第三组最后一排和第一组最后一排对调」「保证每个孩子都公平」），由大模型给出排座操作、程序执行；结果先预览，右侧同时显示「将执行的操作」与「为什么这么排」，满意再应用，还能继续追问重排
- **拖拽换座** — 按住任意座位拖到另一个座位即交换两人，带跟手幽灵与换座脉冲动画
- **组别配色** — 每组一个颜色，可在配置弹窗里逐组改排数、选配色、增删组；座位文字会按底色明暗自动取深/浅，保证看得清
- **双视角** — 学生视角（讲台在左上）/ 老师视角（讲台在下方，整块 180° 翻转），一键切换
- **组号反向** — 组号可从右往左数（最右为第一组）
- **导出图片** — 座位图导出为 PNG 存到本地，同时把座位布局存入历史记录
- **历史记录** — 回看并还原任意一次导出时的座位布局与配色

## AI 排座是怎么工作的

大模型**不直接输出座位表**，只输出对当前座位表的**操作**，由程序执行：

```json
{"reason":"为什么这么调","ops":[
  {"op":"swapRows","a":[1,6],"b":[3,7]},   // 两排整排对调
  {"op":"rotateLR"},                        // 每组每排左右对调
  {"op":"rotateRows","group":null,"by":1}   // 组内排前后轮转
]}
```

这样设计的原因：让模型直接写 60 个中文姓名，它得同时做到「抄对姓名、数对每组排数、真的照做」——前两件能靠校验拦，**第三件拦不住**（实测模型会自述「已按要求对调」、结果也通过校验，实际根本没动）。改成只出操作后，姓名与维度根本不经过模型的手，这三类错误在结构上不可能发生。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | Vue 3 + TypeScript + Vite |
| 样式 | Tailwind CSS 4 |
| 图标 | lucide-vue-next |
| 截图 | html-to-image |
| AI 调用 | Rust 侧 `reqwest`（WebView 直接 fetch 会被 CORS 拦） |

## 开发

需要 [Node.js](https://nodejs.org/) **≥ 22.13**、[pnpm](https://pnpm.io/) 11、[Rust](https://rustup.rs/)。

> Node 版本不能低于 22.13：`pnpm@11` 依赖 Node 22.5+ 的内置模块 `node:sqlite`，低版本会在 `pnpm install` 直接报 `No such built-in module: node:sqlite`。

```bash
pnpm install        # 安装依赖
pnpm tauri dev      # 启动桌面应用（开发模式，热更新）
pnpm build          # 仅类型检查 + 构建前端
pnpm tauri build    # 打包为安装程序（产物在 src-tauri/target/release/bundle/）
```

> `pnpm tauri dev` 报 `Port 1420 is already in use` 时，是上次的 vite 进程没退干净：
>
> ```powershell
> Get-NetTCPConnection -LocalPort 1420 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
> ```

## AI 排座配置

「AI 排座」需要一个 OpenAI 兼容接口。在下列任一位置放一个 `config.json`（程序只读，不会改写）：

1. **开发期**：`src-tauri/config.json`
2. **便携版**：与 `seatplan.exe` 同目录
3. **安装版**：`%APPDATA%\com.seatplan.app\config.json`

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-key",
  "model": "deepseek-v4-pro",
  "temperature": 0.7,
  "reasoningEffort": "none"
}
```

- `baseUrl` 不写 `/v1` 也可以，程序会自动补上；DeepSeek、通义、智谱、Kimi、OpenAI 的官方地址同样适用
- `temperature` 可省略，默认 `0.7`
- `reasoningEffort` 控制推理强度。**不填默认 `none`（关掉思考）**——模型只输出「交换哪两排 / 左右对调」这类操作，实际排座由程序执行，不需要深度推理；实测 2~4 秒出结果。若某条复杂指令排得不合意，可填 `off` 走模型默认（会慢一些但更会「琢磨」），或填 `low` / `medium` / `high`
- 该文件已被 `.gitignore` 忽略（含明文密钥，**不要提交**）

找不到或格式错误时，AI 弹窗会直接显示实际查找过的路径。

## 下载

到 [Releases](https://github.com/guoao0809/seatplan/releases) 下载最新的 `SeatPlan_x.y.z_x64-setup.exe`，双击安装即可，无需额外环境。

## 发布新版本

`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处的 `version` 改好后，打 tag 推送即可，GitHub Actions 会自动构建 Windows 安装包并创建 Release（草稿状态，需手动点 Publish）：

```bash
# 先把上面三处的 version 改成 0.3.0
git commit -am "chore: release v0.3.0"
git tag v0.3.0
git push && git push --tags
```

构建约 10 分钟（首次因要编译 Rust 依赖会久一些），完成后到 [Actions](https://github.com/guoao0809/seatplan/actions) 和 [Releases](https://github.com/guoao0809/seatplan/releases) 查看。

## 目录结构

```
src/
  views/SeatView.vue      排座主界面（网格、拖拽、视角切换、配置弹窗、AI 弹窗）
  views/RecordsView.vue   历史记录
  lib/seat.ts             排座核心算法、组配置与配色、自检
  lib/ai.ts               AI 排座：拼提示词、校验并执行模型给出的操作、自检
  lib/records.ts          历史记录持久化
  components/             标题栏、左侧导航、Toast
src-tauri/
  src/ai.rs               AI 接口调用（URL 拼接、reqwest、ai_arrange 命令）
  src/lib.rs              Tauri 入口 + save_png / load_ai_config 命令
  config.json             本地 AI 配置（含密钥，已 gitignore）
  tauri.conf.json         窗口与打包配置
.github/workflows/
  release.yml             打 tag 自动打包发布
```

## 开发说明

- `src/lib/seat.ts` 与 `src/lib/ai.ts` 都带自检，可用 Node 直接跑，不需要起应用：
  ```bash
  node --experimental-strip-types src/lib/seat.ts
  node --experimental-strip-types src/lib/ai.ts
  ```
  为此 `ai.ts` 刻意不含任何静态 import（`invoke` 用函数内动态 `import()`）。
- `src-tauri/src/ai.rs` 的 URL 拼接有单元测试：`cd src-tauri && cargo test`
