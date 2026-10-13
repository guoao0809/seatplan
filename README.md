<div align="center">

# 教室排座 SeatPlan

**给老师用的教室座位表工具** — 填好名单，自动排座，拖拽换座，一键导出图片。

[![Release](https://img.shields.io/github/v/release/guoao0809/seatplan?label=下载&color=4F6BF6)](https://github.com/guoao0809/seatplan/releases/latest)

</div>

## 功能

- **自动排座** — 按「组 × 排 × 每排座位数」把名单依次填满，容量不足自动留空位
- **学生名单** — 表格维护「姓名 / 学生特点 / 注意事项」，支持整段粘贴导入；座位悬停即显示该生的特点与注意事项
- **硬约束「不能同桌」** — 在注意事项里写 `不能同桌:张三`（多个用逗号），程序在每次排座后逐轮校验同桌对，撞上就要求模型重排；重试用尽仍不达标会标黄提示，不会静默放过
- **AI 排座** — 输入一句自然语言（如「第三组最后一排和第一组最后一排对调」「保证每个孩子都公平」），由大模型给出排座操作、程序执行；结果先预览，右侧同时显示「将执行的操作」「为什么这么排」与实时思考过程，满意再应用，还能继续追问重排
- **一次生成多次换座** — 填「生成次数」（1~20）一次生成整学期的 N 次换座；每次以「上一次的结果」为基准累积调整，生成完用左右箭头逐次翻看
- **轮换统计** — 一张表列出每个学生在 N 次里坐过前/中/后排、靠左/靠右各几次，「一次都没轮到」的位置会标出来（只报告，不改座位）
- **拖拽换座** — 按住任意座位拖到另一个座位即交换两人，带跟手幽灵与换座脉冲动画
- **组别配色** — 每组一个颜色，可在配置弹窗里逐组改排数、选配色、增删组；座位文字会按底色明暗自动取深/浅，保证看得清
- **双视角** — 学生视角（讲台在左上）/ 老师视角（讲台在下方，整块 180° 翻转），一键切换
- **组号反向** — 组号可从右往左数（最右为第一组）
- **导出图片** — 一次排座只导出一张 PNG；生成过多次换座时导出一个 zip，内含 `第01次.png`…`第N次.png`
- **历史记录** — 回看并还原任意一次排座；多次换座存成**一条**记录（带「N 次轮换」标签），回显后主页仍可左右切换
- **设置页** — 界面里改 AI 的 Base URL / 模型 / API Key / 推理强度，可「测试连接」「获取模型」，保存后写回 config.json

## AI 排座是怎么工作的

大模型**不直接输出座位表**，只输出对当前座位表的**操作**，由程序执行：

```json
{"reason":"为什么这么调","ops":[
  {"op":"swapRows","a":[1,6],"b":[3,7]},   // 两排整排对调
  {"op":"rotateLR"},                        // 每组每排左右对调
  {"op":"rotateRows","group":null,"by":1}   // 组内排前后轮转
]}
```

一次要生成 N 次换座时，操作按组返回，**每组作用在前一组的结果上**（`current` 是第 1 组的基准）：

```json
{"reason":"为什么这么排","rounds":[[ …第1次的操作… ],[ …第2次的操作… ], …]}
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

「AI 排座」需要一个 OpenAI 兼容接口。配置按下列顺序查找，**用第一个找到的**：

1. **开发期**：`src-tauri/config.json`
2. **exe 同目录**：`config.json`
3. **用户目录**：`%APPDATA%\com.seatplan.app\config.json`
4. **安装包内置**：打包时若 `src-tauri/config.json` 存在，其内容会被编进二进制作为兜底

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
- 也可以在应用里的**「设置」页**直接改这几项（含「推理强度」下拉）：「测试连接」会真发一次请求并报耗时，「获取模型」会拉取模型列表，「保存配置」会写回上面查找链里**第一个命中的那个文件**（开发期就是 `src-tauri/config.json`；若配置来自安装包内置兜底，则写到 `%APPDATA%` 下）

找不到或格式错误时，AI 弹窗会直接显示实际查找过的路径。

### 内置配置与分发（注意）

打包时若 `src-tauri/config.json` 存在，它会被**编进二进制**作为兜底，装完即用、无需用户配置。这意味着：

- **CI 构建的安装包不含密钥**——`config.json` 被 gitignore，CI 里没有这个文件，编进去的是空串。所以公开 Release 是安全的。
- **带密钥的安装包只应私下分发**。密钥能从二进制里被提取（解压安装包或 `strings` exe 即可），**不要**把本地构建的带密钥安装包上传到公开 Release。

给别人用又不方便让对方配置时，两个办法：私下发你本地构建的安装包，或者替对方在 `%APPDATA%\com.seatplan.app\config.json` 放一份。

## 下载

到 [Releases](https://github.com/guoao0809/seatplan/releases) 下载最新的 `SeatPlan_x.y.z_x64-setup.exe`，双击安装即可，无需额外环境。

## 发布新版本

`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处的 `version` 改好后，打 tag 推送即可，GitHub Actions 会自动构建 Windows 安装包并创建 Release（草稿状态，需手动点 Publish）：

```bash
# 先把上面三处的 version 改成 0.4.0
git commit -am "chore: release v0.4.0"
git tag v0.4.0
git push && git push --tags
```

构建约 10 分钟（首次因要编译 Rust 依赖会久一些），完成后到 [Actions](https://github.com/guoao0809/seatplan/actions) 和 [Releases](https://github.com/guoao0809/seatplan/releases) 查看。

## 目录结构

```
src/
  views/SeatView.vue      排座主界面（网格、拖拽、视角切换、多轮轮播、配置弹窗、AI 弹窗、导出）
  views/RecordsView.vue   历史记录
  views/SettingsView.vue  AI 模型设置（Base URL / 模型 / Key / 推理强度、测试连接、获取模型）
  lib/seat.ts             排座核心算法、组配置与配色、自检
  lib/ai.ts               AI 排座：拼提示词、解析（单轮 ops 与多轮 rounds）、执行、自检
  lib/rotation.ts         轮换规则：不能同桌的解析与逐轮冲突检测、公平轮换统计、自检
  lib/records.ts          历史记录持久化（一条记录可含整组 N 轮）
  components/             标题栏、左侧导航、Toast、轮播切换（RoundSwitcher）、轮换统计表（FairnessTable）
src-tauri/
  src/ai.rs               AI 接口调用（URL 拼接、reqwest、SSE 流式、ai_arrange / test_ai_connection / fetch_models）
  src/lib.rs              Tauri 入口 + save_png / load_ai_config / save_ai_config
  config.json             本地 AI 配置（含密钥，已 gitignore）
  tauri.conf.json         窗口与打包配置
.github/workflows/
  release.yml             打 tag 自动打包发布
```

## 开发说明

- `src/lib/` 下三个文件都带自检，可用 Node 直接跑，不需要起应用：
  ```bash
  node --experimental-strip-types src/lib/seat.ts
  node --experimental-strip-types src/lib/ai.ts
  node --experimental-strip-types src/lib/rotation.ts
  ```
  为此 `ai.ts` 刻意不含任何静态 import（`invoke` 用函数内动态 `import()`）。
- `src-tauri/src/ai.rs` 的 URL 拼接有单元测试：`cd src-tauri && cargo test`
