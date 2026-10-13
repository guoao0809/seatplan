# 导出图片支持多轮（zip）

> **For agentic workers:** 这是 `2026-10-13-multi-round-seating.md` / `-part2.md` 之后的追加任务。前置 12 个任务已完成；老师已实测跑通 8 次生成 + 应用到主页。

**背景**：老师用 AI 排了 8 次并应用到主页后，发现「导出图片」只能导出**当前显示的那一张**。要的是：**多轮时导出成一个 zip（内含 N 张 PNG）**，单轮时仍只导出一张 PNG。

**已确认的取舍**：为 zip 引入 `fflate`（约 10KB，浏览器端最快最小的 zip 库）。**这是本功能唯一的新依赖**；若不想加依赖，替代方案是「选一个文件夹、直接写 N 张 PNG」，需另行改。

## Global Constraints

- 只改 `src/views/SeatView.vue` 与 `package.json`/锁文件（新增依赖）。
- **N = 1 时行为与现在逐字一致**：同一个 save 对话框、同样的默认文件名格式（`座位图-YYYY-MM-DD-12345.png`）。
- 截图参数（`pixelRatio: 2`、`backgroundColor`、`scrollWidth/scrollHeight`、`style: { margin: "0" }`）**必须原样保留**——那几行是踩过坑写下来的，新代码不得绕开。
- 导出过程要能让用户看见进度；导出结束后**停在原来那一轮**（不能把用户停的轮次留在导出时的最后一轮）。
- 中文注释与文案。

---

### Task 13: 导出多轮为 zip

**Files:**
- Modify: `package.json`（`pnpm add fflate`）
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- 本文件内新增：`exporting: Ref<boolean>`、`exportProgress: Ref<{ done: number; total: number }>`、`captureChart(): Promise<Uint8Array>`
- `exportImage()` 改成：单轮走原路径，多轮打包 zip

- [ ] **Step 1: 装依赖**

```bash
cd /d/wok/worknotes/seatplan && pnpm add fflate
```

- [ ] **Step 2: 抽出截图函数（保留全部既有参数）**

把 `exportImage()` 里那段 `toPng(...)` 调用原样搬进新函数，参数一个都不许动：

```ts
/**
 * 把座位图截成 PNG 字节。
 *
 * 三个坑照旧（原实现里踩出来的，不要简化）：
 * 1. pixelRatio 2：默认 1 在高分屏上偏糊；
 * 2. scrollWidth/scrollHeight 而非 clientWidth：元素盒子被容器夹住时 clientWidth 偏小；
 * 3. margin 清零：克隆节点会带上 mx-auto 算出的实际外边距，导致内容在画布上整体右移、右侧被裁掉。
 */
async function captureChart(): Promise<Uint8Array> {
  const node = seatChartRef.value;
  if (!node) throw new Error("找不到座位图");
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    backgroundColor: "#ffffff",
    width: node.scrollWidth,
    height: node.scrollHeight,
    style: { margin: "0" },
  });
  return dataUrlToBytes(dataUrl);
}
```

- [ ] **Step 3: 改 exportImage**

```ts
/** 导出的进度状态：多轮时按钮上显示「正在导出第 i / N 张…」 */
const exporting = ref(false);
const exportProgress = ref({ done: 0, total: 0 });

/** 导出：单轮导一张 PNG；多轮打包成 zip（第01次.png …） */
async function exportImage() {
  if (exporting.value) return;
  if (nameCount.value === 0) {
    showToast("没有学生，无法导出", "error");
    return;
  }
  const original = roundIndex.value;
  exporting.value = true;
  try {
    // 文件名带 5 位随机数，避免同一天多次导出时重名
    const rand5 = Math.floor(Math.random() * 90000) + 10000;
    const stamp = new Date().toISOString().slice(0, 10);

    if (seatRounds.value.length <= 1) {
      const bytes = await captureChart();
      const path = await save({
        title: "保存座位图",
        defaultPath: `座位图-${stamp}-${rand5}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return; // 用户取消
      await invoke("save_png", { path, data: Array.from(bytes) });
      showToast("已导出座位图", "success");
      return;
    }

    // 多轮：逐轮切到图上截图。切换会走 showRound（它会写 localStorage），
    // 所以最后必须切回原来那一轮，不能把老师停的位置留在导出时的最后一轮。
    const files: Record<string, Uint8Array> = {};
    const total = seatRounds.value.length;
    for (let i = 0; i < total; i++) {
      exportProgress.value = { done: i + 1, total };
      showRound(i);
      await nextTick(); // 等 DOM 换成这一轮再截
      files[`第${String(i + 1).padStart(2, "0")}次.png`] = await captureChart();
    }

    // level: 0（只打包不压缩）——PNG 本身就是压缩过的，再压一遍只费 CPU 不减体积
    const zip = zipSync(files, { level: 0 });
    const path = await save({
      title: "保存座位图（zip）",
      defaultPath: `座位图-${stamp}-${rand5}.zip`,
      filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
    });
    if (!path) return; // 用户取消
    await invoke("save_png", { path, data: Array.from(zip) });
    showToast(`已导出 ${total} 次座位图（zip）`, "success");
  } catch (e) {
    showToast(`导出失败：${e}`, "error");
  } finally {
    exportProgress.value = { done: 0, total: 0 };
    exporting.value = false;
    showRound(original); // 恢复老师原来停的那一轮
  }
}
```

（`save_png` 这个 Rust 命令就是「把字节写到指定路径」，名字带 png 但写 zip 完全没问题，不必为它改名或新增命令。）

- [ ] **Step 4: import 与按钮**

`<script setup>` 顶部加：

```ts
import { zipSync } from "fflate";
```

导出按钮改成显示进度并禁用重入：

```vue
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="exporting"
        @click="exportImage"
      >
        <LoaderCircle v-if="exporting" :size="14" class="animate-spin" />
        <Download v-else :size="14" />
        {{ exporting ? `正在导出第 ${exportProgress.done} / ${exportProgress.total} 张…` : "导出图片" }}
      </button>
```

- [ ] **Step 5: 验证**

```bash
cd /d/wok/worknotes/seatplan && npx vue-tsc --noEmit && pnpm build
```
预期：两条命令都退出码 0。

GUI 由老师自验（见下），**不要启动应用**（老师的实例可能正开着，1420 端口会冲突）。

- [ ] **Step 6: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add package.json pnpm-lock.yaml src/views/SeatView.vue
git commit -m "feat(seat): 多轮座位导出为 zip（单轮仍导出单张 PNG）"
```

---

## 给老师的验收（自验）

1. **单轮**：`seatplan:rounds` 只有 1 张（或新开一张座位图）→ 点「导出图片」→ 仍弹 PNG 保存框、文件名依旧是 `座位图-日期-随机数.png`，与之前**完全一样**。
2. **多轮**：生成 8 次并应用到主页 → 点「导出图片」→ 按钮变「正在导出第 i / 8 张…」、图上会依次切换 → 弹 zip 保存框 → 存出来的 zip 里应有 **8 个文件**：`第01次.png` … `第08次.png`。
3. **导出完停在原来那一轮**：导出前切到第 3 张，导出完成后应仍停在第 3 张（不是第 8 张）。
4. **取消保存框**：导出过程中/保存框点取消 → 不报错、不写文件、按钮恢复正常。
5. **zip 里的图**：随便解出一张，应是一张完整的座位图（讲台、单座、各组座位、配色都在），没有右侧被裁或整体偏移。

---

### Task 14: 一条记录装下整组轮换（导出与回显都跟着改）

**背景**：老师要求「导出时存 **1 条**记录，回显到主页后仍能轮播切换」。这要求记录能装下整组 N 轮——而 `SeatRecord` 现在只有一张图（`grid`），主页的多轮另存于 `localStorage["seatplan:rounds"]`。老记录（只有 `grid`）必须继续可用。

**Files:**
- Modify: `src/lib/records.ts`（`SeatRecord` 加 `rounds?`；`RestorePayload` 的 Pick 里带上它）
- Modify: `src/views/SeatView.vue`（回显、导出存记录、弹窗里的「全部存入记录」）

**Interfaces:**
- Produces: `SeatRecord.rounds?: (string | null)[][][]`（老记录没有此字段 → 视为单轮）

- [ ] **Step 1: 记录加字段**

`src/lib/records.ts` 的 `SeatRecord` 里、`grid` 之后加：

```ts
  /** 整组轮换；一次排座生成 N 轮时带此字段。老记录没有它 → 视为单轮 */
  rounds?: (string | null)[][][];
```

`RestorePayload` 的 Pick 里加上 `"rounds"`。

- [ ] **Step 2: 回显带回整组**

`src/views/SeatView.vue` 的 `applyRestore(p)` 改成：先把名单/配置等前置状态写好（保持既有顺序），然后用 `showRound(0)` 从 `seatRounds[0]` 重建显示，而不是自己拼 `seatGrid`：

```ts
  // 老记录只有单张 grid；带 rounds 的记录回显整组，回显后仍能轮播
  seatRounds.value = p.rounds?.length ? p.rounds : [p.grid];
  roundIndex.value = 0;
  showRound(0); // 它负责重建 seatGrid 并按 seatRounds[0] 落盘
```

（`showRound` 必须在 `groupCfgs` / `reverseGroups` 等都写好之后调用——它内部用到了它们。）

- [ ] **Step 3: 两个存记录的地方都改成 1 条**

导出路径（多轮分支）与 AI 弹窗的 `saveRoundsToRecords()` 都改成**存一条**，把那组轮次放进 `rounds`：

```ts
/** 一次排座的记录：单轮时与老记录同形（不带 rounds），多轮时把整组带上 */
function roundsRecord(grids: (string | null)[][][]): SeatRecord {
  const n = grids.length;
  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    exportedAt: Date.now(),
    // 多轮才带 label 与 rounds：单轮产出的记录与老记录形状一致，不引入新字段
    ...(n > 1 ? { label: `${n} 次轮换`, rounds: grids } : {}),
    rows: rows.value,
    colors: groupCfgs.value.map((c) => c.color),
    seatsPerRow: seatCount.value,
    singleSeatName: singleSeatName.value,
    grid: grids[0]!, // 老字段仍是第一张，任何只读 grid 的既有代码照旧可用
  };
}
```

- 导出：多轮分支在**用户确认保存路径之后**（即 `if (!path) return` 之后）存一条：`saveRecords([roundsRecord(gridsOfRounds), ...loadRecords()])`（**一条**，不是 N 条）。**取消保存框就不该留记录**——存记录必须排在路径确认之后，与单轮路径今天的顺序一致。失败时照旧 toast 提示（`saveRecords` 返回 false）。
  单轮分支**保持现状不动**（仍然是一条不带 `rounds` 的记录 + 原 toast）。
- `saveRoundsToRecords()`：改成 `saveRecords([roundsRecord(aiRounds.map(r => r.grid)), ...])`（一条）。toast 文案相应改成「已存入记录（N 次轮换）」。

- [ ] **Step 4: 验证**

```bash
cd /d/wok/worknotes/seatplan && npx vue-tsc --noEmit && pnpm build
```
预期：两条都退出码 0。GUI 由老师自验。

- [ ] **Step 5: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/records.ts src/views/SeatView.vue
git commit -m "feat(records): 一条记录装下整组轮换；回显后主页仍可轮播"
```

---

## 给老师的验收（Task 13 + Task 14 一起看）

1. **单轮导出与以前逐字一致**：只弹 PNG 保存框、文件名 `座位图-日期-随机数.png`、导出后提示「已保存到：…」、记录页多出 1 条（不带「第 N 次」徽标）。
2. **多轮导出**：生成 8 次并应用到主页 → 点「导出图片」→ 按钮显示「正在导出第 i / 8 张…」→ 存出的 zip 里有 `第01次.png` … `第08次.png` 共 8 个文件。
3. **导出后停回原轮**：导出前切到第 3 张，导出完成后仍停在第 3 张。
4. **记录只多 1 条**：多轮导出后记录页**只新增 1 条**，带「8 次轮换」徽标（不是 8 条）。
5. **回显仍可轮播**：在记录页点这条记录的回显 → 主页出现 8 张、可左右切；切到第 5 张拖拽换座只影响那一张。
6. **老记录不受影响**：以前存的单张记录回显照旧（只有一张、没有箭头）。
7. **取消保存框**：导出中点取消 → 不报错、不写文件、按钮恢复；**且不应该多出记录**（取消时不存记录）。

---

### Task 15: 遗留 Minor 清理（4 处一行改动）

**背景**：全分支终审被取消后，控制者自行裁定了各任务审查留下的 Minor，挑出 4 处值得修的（其余已记录为"接受"）。都是小改动，但其中第 1 条是**真 bug**。

**Files:**
- Modify: `src/views/SeatView.vue`、`src/views/RecordsView.vue`、`src/lib/ai.ts`

- [ ] **Step 1: `showRound` 取配色取错了源（真 bug）**

`showRound(i)` 里 `color: groupColor(gi)` 读的是 `seatGrid.value[gi]?.color`——而此刻 `seatGrid` 还是**上一张**网格（甚至为空）。于是从记录回显一组自带配色的座位时，首屏用的是旧调色板而不是记录里的配色（多轮回显走的正是这条路）。改成直接读组配置：

```ts
    seatGrid.value = grid.map((rowArr, gi) => ({
      label: groupLabel(gi, grid.length, reverseGroups.value),
      // 读组配置而不是 groupColor()：后者读的是 seatGrid 里上一张网格的颜色，
      // 回显自带配色的记录时首屏会取到旧调色板
      color: groupCfgs.value[gi]?.color ?? paletteColor(gi),
      rows: rowArr.map((r) => ({ seats: r.map((n) => ({ name: n })) })),
    }));
```

（`groupColor()` 别的地方照旧用，不动它。）

- [ ] **Step 2: 记录页 label 的间距**

`RecordsView.vue` 里那个 `<span v-if="r.label">` 带 `mr-1.5`，加上 Vue 折叠出的那个空格，实际间距比预期宽 3~4px。**删掉 `mr-1.5`**（留一个空格的间距即可，别去动模板里的换行缩进）。

- [ ] **Step 3: `ai.ts` 文件头措辞**

「本文件不含任何静态 import，可独立自检」已经不准了（现在有一句 `import type`，虽然会被擦除）。改成：

```ts
// 本文件不含任何**运行时** import（只有一句类型导入，编译时会被擦除），可独立自检：
// node --experimental-strip-types src/lib/ai.ts
```

- [ ] **Step 4: 消除 `p.rounds` 的别名**

`applyRestore` 里 `seatRounds.value = p.rounds ? [...]` —— 直接赋值会让 seatRounds 与传入的 payload 共享同一个数组（拖拽换座会就地改到 payload）。今天没有复用路径，但复制一份是零成本的：

```ts
  seatRounds.value = p.rounds?.length ? [...p.rounds] : [p.grid];
```

- [ ] **Step 5: 验证**

```bash
cd /d/wok/worknotes/seatplan && node src/lib/seat.ts && node src/lib/ai.ts && node src/lib/rotation.ts
cd /d/wok/worknotes/seatplan && npx vue-tsc --noEmit && pnpm build
```
预期：三个自检通过、`vue-tsc` 与 build 退出码 0。**不要启动应用**（老师实例可能开着）。

- [ ] **Step 6: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/views/SeatView.vue src/views/RecordsView.vue src/lib/ai.ts
git commit -m "fix: 回显配色取组配置、记录标签间距、文件头措辞、消除 payload 别名"
```
