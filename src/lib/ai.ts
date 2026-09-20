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

/** 一条对话消息（与 OpenAI 协议一致） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  | { ok: true; grid: (string | null)[][][]; reason: string }
  | { ok: false; error: string };

/** 展平网格，取出所有非空姓名 */
export function flattenNames(grid: (string | null)[][][]): string[] {
  const out: string[] = [];
  for (const g of grid) for (const r of g) for (const n of r) if (n) out.push(n);
  return out;
}

const SYSTEM_PROMPT = [
  "你是教室排座助手。用户给你当前座位表和排座要求，你返回调整后的座位表。",
  "",
  "返回格式（严格遵守，就这一个 JSON 对象）：",
  '{"reason":"用一两句中文说明你这样调整的理由","grid":[[["姓名","姓名"],["姓名","姓名"]]]}',
  "",
  "硬性规则：",
  "1. 只返回 JSON，不要任何解释文字，不要 markdown 代码块围栏。",
  "2. grid 的维度必须与 current 完全一致：组数、每组排数、每排座位数都不能变。",
  "3. 只能使用 roster 中出现的姓名，一个不多一个不少；不允许改名、不允许编造姓名。",
  "4. 空座位保持为 null。",
  "5. roster 中位于 singleSeat 的姓名不要放进 grid。",
  "6. reason 只说思路（谁换到了哪一类位置、为什么这样更公平），不要复述整张座位表。",
  "7. 用户追问时，基于你上一条给出的座位表继续调整，仍然返回完整网格。",
].join("\n");

/** 构造首轮的 system + user 消息 */
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
  // 起点取最早的 { 或 [（模型返回 {"reason":…,"grid":[…]} 时若只找 [ 会丢掉 reason）；
  // 终点从后往前收缩到每个 } 或 ] 逐个试解析，命中第一个合法片段即返回。
  const braces = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  if (braces.length === 0) return body;
  const start = Math.min(...braces);
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    const cand = body.slice(start, end);
    try {
      JSON.parse(cand);
      return cand;
    } catch {
      /* 收缩到前一个 } / ] 再试 */
    }
  }
  return body.slice(start);
}

/**
 * 从解析结果里取出网格与理由。
 * 兼容两种返回：{"reason":…,"grid":[…]} 与裸数组 […]（后者理由为空）。
 * 两者都不像则返回 null。
 */
export function extractGrid(raw: unknown): { grid: unknown; reason: string } | null {
  if (Array.isArray(raw)) return { grid: raw, reason: "" };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (!("grid" in o)) return null;
    return { grid: o.grid, reason: typeof o.reason === "string" ? o.reason.trim() : "" };
  }
  return null;
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
    return { ok: false, error: `返回不是合法 JSON：${e}` };
  }
  const got = extractGrid(raw);
  if (!got)
    return {
      ok: false,
      error: '返回里没有 grid 字段（应为 {"reason":"…","grid":[[…]]}）',
    };
  const bad = validateGrid(got.grid, rows, seatsPerRow, expectedNames);
  if (bad) return { ok: false, error: bad };
  return { ok: true, grid: got.grid as (string | null)[][][], reason: got.reason };
}

/** 追问时追加的消息：把上一轮模型原文和本轮要求接进对话 */
export function appendFollowUp(
  messages: ChatMessage[],
  previousReply: string,
  instruction: string,
): ChatMessage[] {
  return [
    ...messages,
    { role: "assistant", content: previousReply },
    { role: "user", content: instruction },
  ];
}

/** 自检：样例该过的过、该拒的拒；失败抛 Error */
export function runAiSelfCheck(): void {
  const rows = [2, 2];
  const seatsPerRow = 2;
  const expected = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const goodGrid: (string | null)[][][] = [
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
    ["正常", goodGrid, true],
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
    ["组数不符", [goodGrid[0]], false],
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
    ["座位值类型", [[[1, "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]], false],
    ["座位值是数组", [[[["甲"], "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]], false],
    ["不是数组", { a: 1 }, false],
  ];

  for (const [name, raw, shouldPass] of cases) {
    const err = validateGrid(raw, rows, seatsPerRow, expected);
    const passed = err === null;
    if (passed !== shouldPass) {
      throw new Error(
        `样例「${name}」期望${shouldPass ? "通过" : "被拒"}，实际${passed ? "通过" : `被拒（${err}）`}`,
      );
    }
  }

  // 座位值类型非法必须被类型检查直接点名（不能只靠后面的姓名比对兜底）
  const typeReason = validateGrid(
    [[[1, "乙"], ["丙", "丁"]], [["戊", "己"], ["庚", "辛"]]],
    rows,
    seatsPerRow,
    expected,
  );
  if (typeReason === null || !typeReason.includes("座位值只能是姓名或 null"))
    throw new Error(`座位值类型非法应由类型检查拒绝，实际：${typeReason}`);

  // 展平
  if (flattenNames(goodGrid).length !== 8) throw new Error("flattenNames 应取到 8 个姓名");

  // 标准形态：{"reason":…,"grid":[…]}，理由要能取出来
  {
    const reply = JSON.stringify({ reason: "按前后轮转，避免有人总坐前排。", grid: goodGrid });
    const r = parseArrangement(reply, rows, seatsPerRow, expected);
    if (!r.ok) throw new Error(`标准返回应能解析，实际被拒：${r.error}`);
    if (!r.reason.includes("前后轮转")) throw new Error(`reason 未取出，实际：${r.reason}`);
  }

  // 裸数组（无 reason）仍应被接受，理由为空
  {
    const r = parseArrangement(JSON.stringify(goodGrid), rows, seatsPerRow, expected);
    if (!r.ok) throw new Error(`裸数组返回应能解析，实际被拒：${r.error}`);
    if (r.reason !== "") throw new Error(`裸数组的 reason 应为空串，实际：${r.reason}`);
  }

  // 有 grid 但网格不合法 → 拒绝，理由透传
  {
    const bad = JSON.stringify({ reason: "x", grid: [goodGrid[0]] });
    const r = parseArrangement(bad, rows, seatsPerRow, expected);
    if (r.ok) throw new Error("组数不符的返回应被拒绝");
  }

  // 缺 grid 字段 → 明确报缺字段，而不是笼统地说「不是数组」
  {
    const r = parseArrangement(JSON.stringify({ reason: "只有理由" }), rows, seatsPerRow, expected);
    if (r.ok) throw new Error("缺 grid 字段的返回应被拒绝");
    if (!r.error.includes("grid")) throw new Error(`错误应点名缺少 grid，实际：${r.error}`);
  }

  // 带 markdown 围栏与前后闲话的标准返回也要能剥出来
  {
    const reply = JSON.stringify({ reason: "轮换前后排。", grid: goodGrid });
    const wrapped = "好的，结果如下：\n```json\n" + reply + "\n```\n以上。";
    const r = parseArrangement(wrapped, rows, seatsPerRow, expected);
    if (!r.ok) throw new Error(`带围栏的返回应能解析，实际被拒：${r.error}`);
    if (!r.reason) throw new Error("带围栏返回的 reason 不应为空");
  }

  // 正确 JSON 后跟含方括号的闲话也应整体解析成功（不能被括号切片截坏）
  {
    const reply = JSON.stringify({ reason: "轮换[前后排]，更公平[1]。", grid: goodGrid });
    const trailing = reply + " 已调整[公平]，请查看[1]。";
    const r = parseArrangement(trailing, rows, seatsPerRow, expected);
    if (!r.ok) throw new Error(`尾部闲话含方括号的返回应能解析，实际被拒：${r.error}`);
    if (!r.reason.includes("前后排"))
      throw new Error(`尾部闲话场景的 reason 应完整取出，实际：${r.reason}`);
  }

  // 凭空多出一个名字必须被拒
  const extra = JSON.parse(JSON.stringify(goodGrid)) as (string | null)[][][];
  extra[1]![1]![1] = "壬";
  if (validateGrid(extra, rows, seatsPerRow, expected) === null)
    throw new Error("多出未在名单中的姓名应被拒绝");

  // 同时缺名与多名：理由里必须同时点出「少了」和「多了」
  const swap = JSON.parse(JSON.stringify(goodGrid)) as (string | null)[][][];
  swap[0]![0]![1] = "壬";
  const swapReason = validateGrid(swap, rows, seatsPerRow, expected);
  if (swapReason === null) throw new Error("少一个又多一个的网格应被拒绝");
  if (!swapReason.includes("少了") || !swapReason.includes("多了"))
    throw new Error(`理由应同时包含「少了」与「多了」，实际：${swapReason}`);

  // 非 JSON 文本必须被拒，而不是抛异常
  const notJson = parseArrangement("这不是 JSON", rows, seatsPerRow, expected);
  if (notJson.ok) throw new Error("非 JSON 文本应被拒绝");

  // buildMessages 发出的 roster 必须与 validateGrid 期待的名单对齐：网格名 + 单座名，current 原样携带
  {
    const grid: (string | null)[][][] = [
      [
        ["甲", "乙"],
        ["丙", null],
      ],
      [
        ["丁", "戊"],
        ["己", null],
      ],
    ];
    const { user } = buildMessages({
      grid,
      singleSeatName: "庚",
      history: [],
      instruction: "换个坐法",
      rows: [2, 2],
      seatsPerRow: 2,
    });
    const payload = JSON.parse(user) as {
      roster: string[];
      current: (string | null)[][][];
    };
    const wantRoster = [...flattenNames(grid), "庚"];
    if (JSON.stringify(payload.roster) !== JSON.stringify(wantRoster))
      throw new Error(
        `buildMessages 的 roster 应为网格姓名+单座，实际：${JSON.stringify(payload.roster)}`,
      );
    if (JSON.stringify(payload.current) !== JSON.stringify(grid))
      throw new Error("buildMessages 的 current 应与输入网格一致");
    // 该 roster 正是 parseArrangement 期待的名单（expectedNames 取网格名）
    const okRes = parseArrangement(
      JSON.stringify({ reason: "r", grid }),
      rows,
      seatsPerRow,
      flattenNames(grid),
    );
    if (!okRes.ok) throw new Error(`网格对自身 roster 的校验应通过，实际被拒：${okRes.error}`);
  }

  // 追问：上一轮模型原文与本轮要求必须按 assistant → user 顺序接在后面
  {
    const base: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
    ];
    const next = appendFollowUp(base, "reply1", "再换一次");
    if (next.length !== 4) throw new Error(`追问后应有 4 条消息，实际 ${next.length}`);
    if (next[2]!.role !== "assistant" || next[2]!.content !== "reply1")
      throw new Error("第 3 条应为上一轮的 assistant 原文");
    if (next[3]!.role !== "user" || next[3]!.content !== "再换一次")
      throw new Error("第 4 条应为本轮的 user 要求");
    if (base.length !== 2) throw new Error("appendFollowUp 不应改动原数组");
  }
}

// ===== 与 Rust 通信（动态 import，保持本文件可独立自检）=====

/** 读取本地 config.json（Rust 侧按序查找） */
export async function loadAiConfig(): Promise<LoadedAiConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoadedAiConfig>("load_ai_config");
}

/** 调 AI 排座，返回模型输出的原始文本 */
export async function arrangeSeats(
  config: AiConfig,
  messages: ChatMessage[],
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("ai_arrange", { config, messages });
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/ai.ts`
declare const process:
  | { stdout: { write: (s: string) => void } }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runAiSelfCheck();
  process.stdout.write("ai 自检通过\n");
}
