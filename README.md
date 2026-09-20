<div align="center">

# 教室排座 SeatPlan

**给老师用的教室座位表工具** — 填好名单，自动排座，拖拽换座，一键导出图片。

[![Release](https://img.shields.io/github/v/release/guoao0809/seatplan?label=下载&color=4F6BF6)](https://github.com/guoao0809/seatplan/releases/latest)

</div>

## 功能

- **自动排座** — 按「组 × 排 × 每排座位数」把名单依次填满，容量不足自动留空位
- **拖拽换座** — 按住任意座位拖到另一个座位即交换两人，带跟手幽灵与换座脉冲动画
- **双视角** — 学生视角（讲台在左上）/ 老师视角（讲台在下方，整块 180° 翻转），一键切换
- **组号反向** — 组号可从右往左数（最右为第一组）
- **导出图片** — 座位图导出为 PNG 存到本地，同时把座位布局存入历史记录
- **历史记录** — 回看并还原任意一次导出时的座位布局

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | Vue 3 + TypeScript + Vite |
| 样式 | Tailwind CSS 4 |
| 图标 | lucide-vue-next |
| 截图 | html-to-image |

## 开发

需要 [Node.js](https://nodejs.org/) ≥ 20、[pnpm](https://pnpm.io/)、[Rust](https://rustup.rs/)。

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

`src-tauri/tauri.conf.json` 和 `package.json` 里的 `version` 改好后，打 tag 推送即可，GitHub Actions 会自动构建 Windows 安装包并创建 Release（草稿状态，需手动点 Publish）：

```bash
# 先把上面的 version 改成 0.2.0
git commit -am "chore: release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

构建约 10 分钟（首次因要编译 Rust 依赖会久一些），完成后到 [Actions](https://github.com/guoao0809/seatplan/actions) 和 [Releases](https://github.com/guoao0809/seatplan/releases) 查看。

## 目录结构

```
src/
  views/SeatView.vue      排座主界面（网格、拖拽、视角切换）
  views/RecordsView.vue   历史记录
  lib/seat.ts             排座核心算法 + 自检
  lib/records.ts          历史记录持久化
  components/             标题栏、左侧导航、Toast
src-tauri/
  src/lib.rs              Tauri 入口 + save_png 命令
  tauri.conf.json         窗口与打包配置
.github/workflows/
  release.yml             打 tag 自动打包发布
```
