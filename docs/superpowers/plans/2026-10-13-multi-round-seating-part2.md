# 多次排座（追加）：一次调用生成 N 组操作

> **For agentic workers:** 这是 `2026-10-13-multi-round-seating.md` 的追加任务，前置 Task 1~9 已全部完成并通过审查。

**背景**：原本 Task 8 是「N 轮串行调用、每轮喂回公平计分表、撞硬约束只重跑那一轮」。老师实测后裁定改为**一次调用返回 N 组操作**：耗时从 8×(50~80 秒) 降到一次调用，代价是**失去逐轮反馈**——硬约束撞了要整组重生成，公平性由模型自己心算。用户已在明确知道代价的情况下选择此方案。

**连带后果（必须一起处理）**：
- `roundStats`（每轮喂回的公平计分表）失去意义，且会**误导**模型（它只统计起始那一张图，模型会读成「前几次换座的分布」）→ **删除**。`fairnessReport` 保留（界面上的轮换统计表仍在用）。
- 进度文案不再有「第 i / N 次」。
- 硬约束冲突 → 整组重新生成，上限 2 次。

## Global Constraints

- 只改点名的文件，不顺手重构。
- 硬约束（`不能同桌`）仍由**程序**校验，不交给模型自觉。
- N 仍钳在 1~20；`aiReqId` 取消机制必须继续生效。
- 本项目无测试框架：lib 的测试 = 自带自检（`node src/lib/*.ts`）；Vue 组件只跑 `npx vue-tsc --noEmit` + `pnpm build`。
- 中文注释与文案；不新增依赖。

---

### Task 11: AI 侧 —— 多轮返回格式与解析（去掉 roundStats）

**Files:**
- Modify: `src/lib/ai.ts`（SYSTEM_PROMPT、新增 `parseRoundSets`、payload 去掉 `roundStats`、自检）
- Modify: `src/lib/rotation.ts`（删除 `roundStatsOf` 及其断言）

**Interfaces:**
- Produces: `parseRoundSets(text: string, base: Grid, labels: string[], want: number): ParseRoundsOutcome`
- Produces: `interface ParsedRounds { grid: Grid; ops: SeatOp[]; summary: string }`
- Produces: `type ParseRoundsOutcome = { ok: true; rounds: ParsedRounds[]; reason: string } | { ok: false; error: string }`

- [ ] **Step 1: 写失败的断言**

在 `src/lib/ai.ts` 的 `runAiSelfCheck()` 末尾（函数闭合的 `}` 之前）追加：

```ts
  // ---- parseRoundSets：一次返回 N 组操作 ----
  {
    const roundsBase: Grid = [[["a1", "a2"]]];
    const roundsLabels = ["第一组"];
    // 两组 rotateLR：每组都把两个座位对调，两组叠加应回到原样——证明是逐组套用，不是各自从 base 算
    const two = parseRoundSets(
      JSON.stringify({ reason: "轮流左右", rounds: [[{ op: "rotateLR" }], [{ op: "rotateLR" }]] }),
      roundsBase,
      roundsLabels,
      2,
    );
    must(two.ok, `两组 rotateLR 应解析成功，实际 ${two.ok ? "" : two.error}`);
    if (two.ok) {
      must(
        JSON.stringify(two.rounds[0]!.grid) === JSON.stringify([[["a2", "a1"]]]),
        `第 1 组应左右对调，实际 ${JSON.stringify(two.rounds[0]!.grid)}`,
      );
      must(
        JSON.stringify(two.rounds[1]!.grid) === JSON.stringify(roundsBase),
        `第 2 组应再对调一次回到原样（逐组套用），实际 ${JSON.stringify(two.rounds[1]!.grid)}`,
      );
      must(two.rounds[1]!.summary.includes("左右对调"), "每组应各自带一份操作摘要");
    }

    // 单轮形状 {reason, ops} 仍要接受（追问「当前这次」还在用）
    const one = parseRoundSets(
      JSON.stringify({ reason: "r", ops: [{ op: "rotateLR" }] }),
      roundsBase,
      roundsLabels,
      1,
    );
    must(one.ok && one.rounds.length === 1, "单轮形状 {reason, ops} 应被接受");

    // 组数不符 → 报错
    const short = parseRoundSets(
      JSON.stringify({ reason: "r", rounds: [[{ op: "rotateLR" }]] }),
      roundsBase,
      roundsLabels,
      2,
    );
    must(!short.ok && short.error.includes("2"), `组数不足应报错，实际 ${short.ok ? "ok" : short.error}`);

    // 第 2 组下标越界 → 报错要点名「第 2 次」
    const broken = parseRoundSets(
      JSON.stringify({
        reason: "r",
        rounds: [[{ op: "rotateLR" }], [{ op: "swapSeats", a: [0, 0, 0], b: [9, 9, 9] }]],
      }),
      roundsBase,
      roundsLabels,
      2,
    );
    must(
      !broken.ok && broken.error.includes("第 2 次"),
      `第 2 组下标越界应点名第 2 次，实际 ${broken.ok ? "ok" : broken.error}`,
    );

    // rounds 里每一项写成 {ops:[…]} 也要接受
    const wrapped = parseRoundSets(
      JSON.stringify({ reason: "r", rounds: [{ ops: [{ op: "rotateLR" }] }] }),
      roundsBase,
      roundsLabels,
      1,
    );
    must(wrapped.ok, `{ops:[…]} 形状应被接受，实际 ${wrapped.ok ? "" : wrapped.error}`);

    // 既没有 rounds 也没有 ops
    const empty = parseRoundSets(JSON.stringify({ reason: "r" }), roundsBase, roundsLabels, 1);
    must(!empty.ok, "既无 rounds 也无 ops 应报错");
  }

  // ---- payload 不应再有 roundStats，但要有 rounds（要求生成几次）----
  {
    const p = JSON.parse(
      buildMessages({ grid: base, labels, singleSeatName: "", history: [], instruction: "排座" }).user,
    ) as { roundStats?: unknown; rounds?: unknown };
    must(!("roundStats" in p), "payload 不应再带 roundStats");
    must(!SYSTEM_PROMPT.includes("roundStats"), "提示词不应再提 roundStats");
    must(!("rounds" in p), "不传 rounds 时 payload 不该出现该字段（单次场景）");

    const many = JSON.parse(
      buildMessages({
        grid: base,
        labels,
        singleSeatName: "",
        history: [],
        instruction: "排座",
        rounds: 8,
      }).user,
    ) as { rounds?: unknown };
    must(many.rounds === 8, `rounds=8 应原样进 payload，实际 ${JSON.stringify(many.rounds)}`);
  }
```

- [ ] **Step 2: 跑自检，确认失败**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/ai.ts`
Expected: FAIL —— `parseRoundSets is not a function`

- [ ] **Step 3: 实现**

`src/lib/ai.ts` 里：删掉 `ArrangeInput.roundStats` 字段、`buildMessages` 里那行 `roundStats`、`SYSTEM_PROMPT` 里 roundStats 那条规则（删掉后把后面的规则编号顺延）。**同时加上「要求生成几次」的字段**——模型得知道 `rounds` 数组该给几组：

```ts
  /** 要求一次生成几次换座；不传或为 1 表示单次（追问路径）。payload 里只有 > 1 时才出现 */
  rounds?: number;
```

`buildMessages` 的 payload 里加上（紧跟 `deskPairs` 那行之后）：

```ts
    ...(input.rounds && input.rounds > 1 ? { rounds: input.rounds } : {}),
```

新增：

```ts
/** 一次调用返回的多轮结果：rounds[i] 是第 i+1 次换座（作用在第 i 次的结果上） */
export interface ParsedRounds {
  grid: Grid;
  ops: SeatOp[];
  summary: string;
}
export type ParseRoundsOutcome =
  | { ok: true; rounds: ParsedRounds[]; reason: string }
  | { ok: false; error: string };

/**
 * 解析一次返回的 N 组操作。
 *
 * 兼容两种形状：`{reason, rounds:[…]}`（多轮）与 `{reason, ops:[…]}`（单轮，追问路径仍在用）。
 * rounds 里每一项可以是裸的操作数组，也可以是 `{ops:[…]}`。
 * 逐组校验下标、逐组套用在**前一组的结果**上——不是各自从 base 算，这是「轮换」语义的关键。
 */
export function parseRoundSets(
  text: string,
  base: Grid,
  labels: string[],
  want: number,
): ParseRoundsOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripToJson(text));
  } catch (e) {
    return { ok: false, error: `返回不是合法 JSON：${e}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: '返回应为 {"reason":"…","rounds":[…] } 对象' };
  }
  const rec = parsed as Record<string, unknown>;
  const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";

  const rawSets: unknown[] | null = Array.isArray(rec.rounds)
    ? rec.rounds
    : Array.isArray(rec.ops)
      ? [{ ops: rec.ops }]
      : null;
  if (!rawSets) return { ok: false, error: "返回里既没有 rounds 也没有 ops" };
  if (rawSets.length !== want) {
    return { ok: false, error: `要求生成 ${want} 次换座，模型给了 ${rawSets.length} 次` };
  }

  const out: ParsedRounds[] = [];
  let grid = base;
  for (let i = 0; i < rawSets.length; i++) {
    const item = rawSets[i];
    const opsRaw = Array.isArray(item)
      ? item
      : item && typeof item === "object"
        ? (item as Record<string, unknown>).ops
        : undefined;
    const bad = validateOps(opsRaw, grid);
    if (bad) return { ok: false, error: `第 ${i + 1} 次：${bad}` };
    const ops = opsRaw as SeatOp[];
    grid = applyOps(grid, ops);
    out.push({ grid, ops, summary: describeOps(ops, labels) });
  }
  return { ok: true, rounds: out, reason };
}
```

`SYSTEM_PROMPT` 的返回格式段补上多轮形状（紧跟现有那行 `{"reason":…,"ops":[…]}`）：

```ts
  "用户要求**一次生成 N 次换座**时，改成：",
  '{"reason":"…","rounds":[[操作…],[操作…],…]}   // 正好 N 组；第 i 组作用在第 i-1 组的结果上，current 是第 1 组的基准',
```

「硬性规则」里补一条（编号按删掉 roundStats 条后的实际顺序接上）：

```ts
  "N. 要求生成 N 次时，rounds 必须正好 N 组，且逐组累积——不要每组都从 current 重新算，那样等于原地不动。",
```

`src/lib/rotation.ts`：删除 `roundStatsOf` 函数，以及自检里凡是用到 `roundStatsOf` 的断言（`fairnessReport` 的断言全部保留）。

- [ ] **Step 4: 跑自检，确认通过**

Run: `cd /d/wok/worknotes/seatplan && node src/lib/ai.ts && node src/lib/seat.ts && node src/lib/rotation.ts`
Expected: 三个「自检通过」

- [ ] **Step 5: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/lib/ai.ts src/lib/rotation.ts
git commit -m "feat(ai): 一次返回 N 组操作的解析；去掉逐轮计分表 roundStats"
```

---

### Task 12: 前端 —— 单次调用 + 应用 N 轮 + 进度文案 + 修换行

**Files:**
- Modify: `src/views/SeatView.vue`

**Interfaces:**
- Consumes: Task 11 的 `parseRoundSets`、`buildMessages` 的新参数 `rounds`
- `parseArrangement` 在 `runFollowUp` 里仍在用，**保留该 import**

- [ ] **Step 1: 调用 buildMessages 时传上 rounds**

Task 11 给 `ArrangeInput` 加了 `rounds?: number`，payload 里只有 `> 1` 时才出现。`runAi` 里调用时传 `rounds: total`（下一步的代码已含这一行）。

- [ ] **Step 2: runAi 改成单次调用**

`runAi()` 的循环体整个换掉（函数签名、取消、错误处理、`finally` 结构不变）：

```ts
async function runAi() {
  if (aiBusy.value) return;
  if (nameCount.value === 0) {
    aiError.value = "没有学生，无法排座";
    return;
  }
  if (!aiConfig.value) {
    aiError.value = "配置未加载，请检查 config.json";
    return;
  }

  const total = roundsClamped.value;
  const cfg = aiConfig.value;
  const id = ++aiReqId;
  const labels = currentLabels();
  const rule = aiPrompt.value.trim();
  const pairs = noDeskmatePairs(roster.value);

  aiBusy.value = true;
  aiError.value = "";
  aiThinking.value = "";
  aiRounds.value = [];
  aiRoundIndex.value = 0;

  const base = currentGrid();
  let lastConflict = "";
  try {
    // 一次调用拿 N 组操作；撞硬约束就整组重生成（上限 2 次）
    for (let attempt = 0; attempt <= 2; attempt++) {
      const { system, user } = buildMessages({
        grid: base,
        labels,
        singleSeatName: singleSeatName.value,
        history: [],
        instruction: `${roundInstruction(1, total, rule, "")}${lastConflict ? `\n\n注意：${lastConflict}` : ""}`,
        students: roster.value,
        rounds: total,
      });

      const text = await arrangeSeats(
        cfg,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        (e) => {
          if (id !== aiReqId) return;
          if (e.kind === "reasoning") aiThinking.value += e.text;
        },
      );
      if (id !== aiReqId) return; // 已被作废

      const res = parseRoundSets(text, base, labels, total);
      if (!res.ok) {
        aiError.value = `校验未通过：${res.error}\n\n模型原始返回：\n${text}`;
        return;
      }

      // 逐轮查硬约束：任何一轮撞上就整组重生成
      let conflict: [string, string] | null = null;
      for (const r of res.rounds) {
        const hit = deskmateConflicts(r.grid, pairs);
        if (hit.length > 0) {
          conflict = hit[0]!;
          break;
        }
      }
      if (conflict && attempt < 2) {
        lastConflict = `上一次生成的座位里「${conflict[0]}」和「${conflict[1]}」还是同桌，这次必须把他们拆开。`;
        continue;
      }

      aiRounds.value = res.rounds.map((r) => ({
        grid: r.grid,
        reason: res.reason,
        summary: r.summary,
        warnings: conflict ? [`${conflict[0]} 与 ${conflict[1]} 仍同桌`] : [],
      }));
      return;
    }
  } catch (e) {
    if (id !== aiReqId) return;
    aiError.value = String(e);
  } finally {
    if (id === aiReqId) {
      aiBusy.value = false;
      aiProgress.value = { done: 0, total: 0 };
    }
  }
}
```

- [ ] **Step 3: 进度文案**

- 排座按钮：「排座中（第 i/N 次）…」→「排座中（正在生成 N 次）…」
- 思考框标题：输入态与预览态两处「第 i / N 次 · 模型思考中…」→「正在生成 N 次换座 · 模型思考中…」（`aiProgress.total > 1` 那层判断可以去掉，因为一次调用只有一个阶段）

- [ ] **Step 4: 修「生成次数」label 换行**

那行是 `flex items-center gap-2`，label 没有 `shrink-0`、右边又塞了一长串说明，于是「生成次数」被挤成两行（老师截图确认）。给 label 加 `shrink-0 whitespace-nowrap`，让说明文字自己换行：

```vue
            <label class="shrink-0 whitespace-nowrap text-xs text-text">生成次数</label>
```

- [ ] **Step 5: 验证**

Run: `cd /d/wok/worknotes/seatplan && npx vue-tsc --noEmit && pnpm build`
Expected: 两条都退出码 0。GUI 验证仍由控制者跑。

- [ ] **Step 6: Commit**

```bash
cd /d/wok/worknotes/seatplan
git add src/views/SeatView.vue
git commit -m "feat(seat): 改为一次调用生成 N 次换座；修生成次数标签换行"
```
