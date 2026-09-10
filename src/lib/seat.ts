// 教室排座核心逻辑：把名单分配到「组 × 排 × 每排座位」的网格里。

/** 默认示例名单：完全按图片顺序整理（第一组 → 第四组，组内由上到下）。共 60 人。 */
export const DEFAULT_ROSTER = [
  // 第一组（7 排 = 14 人）
  "陈玙宇", "李尹馨", "谌宗山", "刘瑾诺", "杨锦琛", "钟浩宇", "刘若依", "武皓辰",
  "赵家栋", "钟语瑄", "丁璟阳", "白语然", "肖志高", "陈乐仪",
  // 第二组（7 排 = 14 人）
  "张思邈", "夏林磊", "吴屹哲", "乐泽林", "陈语晴", "张浩辰", "杨昊辰", "王淳希",
  "李彦辰", "钱沐阳", "段紫玥", "李柏焱", "白沐兮", "毛伊伊",
  // 第三组（8 排 = 16 人）
  "杨妤芊", "祁博衍", "闫梓航", "胡婧希", "席欣潼", "肖枰宸", "王怿瑶", "魏诗璇",
  "曾舒桐", "周子孺", "邹清妍", "夏林旭", "齐文正", "朱美翼", "吕澄一", "高梓博",
  // 第四组（8 排 = 16 人）
  "刘昊然", "唐夕珈", "张熙雯", "喻衍嘉", "杨依霖", "杨沐晨", "李博彦", "彭欣桐",
  "张金诺", "关哲煜", "郭沐晴", "陈馥安", "井玉程", "康林芸", "蔡彦哲", "李炜彤",
];

/** 每排座位数（默认两人一桌） */
export const DEFAULT_SEATS_PER_ROW = 2;
/** 各组排数 */
export const DEFAULT_ROWS_PER_GROUP = [7, 7, 8, 8];

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 数字转中文（用于「第一组」等，1~99 够用） */
export function cnNum(n: number): string {
  if (n <= 0) return String(n);
  if (n <= 10) return CN_NUM[n - 1];
  if (n < 20) return n % 10 === 0 ? "十" : `十${CN_NUM[(n % 10) - 1]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${CN_NUM[tens - 1]}十${ones === 0 ? "" : CN_NUM[ones - 1]}`;
}

/** 解析名单文本：支持按换行 / 逗号 / 顿号 / 空格分隔，去空项 */
export function parseRoster(text: string): string[] {
  return text
    .split(/[\n,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析每组排数配置：如 "7,7,8,8"，非法项会被过滤；结果为空则回退默认 */
export function parseRows(text: string): number[] {
  const nums = text
    .split(/[,，、;\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return nums.length > 0 ? nums : DEFAULT_ROWS_PER_GROUP;
}

export interface Seat {
  name: string | null;
}
export interface SeatRow {
  seats: Seat[];
}
export interface Group {
  label: string;
  rows: SeatRow[];
}

/**
 * 按显示下标生成组名。reverse 时从右往左数（最右为第一组），文字用阿拉伯数字避免歧义。
 * 列数超过 99 就退回阿拉伯数字，反正 cnNum 也表达不了。
 */
export function groupLabel(index: number, total: number, reverse: boolean): string {
  const n = reverse ? total - index : index + 1;
  return n <= 99 ? `第${cnNum(n)}组` : `第${n}组`;
}

/**
 * 把名单依次填入网格：按组顺序、组内按排从上到下、排内从左到右。
 * 名单不够则留空，超出则忽略。讲台置于顶部时第一排离讲台最近。
 */
export function assignSeats(
  roster: string[],
  rowsPerGroup: number[],
  seatsPerRow: number,
  reverse = false,
): Group[] {
  let idx = 0;
  return rowsPerGroup.map((rowCount, gi) => ({
    label: groupLabel(gi, rowsPerGroup.length, reverse),
    rows: Array.from({ length: rowCount }, () => ({
      seats: Array.from({ length: seatsPerRow }, () => {
        const name = roster[idx++] ?? null;
        return { name };
      }),
    })),
  }));
}

/** 自检：默认名单应恰好铺满默认网格（60 人 = (7+7+8+8)×2 座），失败即抛错。 */
export function runSelfCheck(): void {
  const groups = assignSeats(DEFAULT_ROSTER, DEFAULT_ROWS_PER_GROUP, DEFAULT_SEATS_PER_ROW);
  const capacity = DEFAULT_ROWS_PER_GROUP.reduce((n, r) => n + r) * DEFAULT_SEATS_PER_ROW;
  const placed = groups.flatMap((g) => g.rows.flatMap((r) => r.seats)).filter((s) => s.name);
  if (DEFAULT_ROSTER.length !== capacity)
    throw new Error(`默认名单数 ${DEFAULT_ROSTER.length} 与容量 ${capacity} 不一致`);
  if (placed.length !== DEFAULT_ROSTER.length)
    throw new Error(`名单未铺满：${placed.length}/${DEFAULT_ROSTER.length}`);
  if (groups[0]!.rows[0]!.seats[0]!.name !== "陈玙宇")
    throw new Error(`第一组首座应为「陈玙宇」，实际「${groups[0]!.rows[0]!.seats[0]!.name}」`);
  if (groups[3]!.rows[7]!.seats[1]!.name !== "李炜彤")
    throw new Error(`第四组末座应为「李炜彤」，实际「${groups[3]!.rows[7]!.seats[1]!.name}」`);

  const rev = ["第四组", "第三组", "第二组", "第一组"];
  if (groups.map((_, i) => groupLabel(i, 4, true)).join() !== rev.join())
    throw new Error(`反向组名应为 ${rev.join()}，实际 ${groups.map((_, i) => groupLabel(i, 4, true)).join()}`);
  if (groupLabel(0, 4, false) !== "第一组") throw new Error("正向组名应为「第一组」");
}

// 自检也可用 node 直接跑：`node --experimental-strip-types src/lib/seat.ts`
// 声明避免依赖 node 类型；只有非浏览器环境才会执行
declare const process:
  | { stdout: { write: (s: string) => void }; env: Record<string, string> }
  | undefined;
if (typeof document === "undefined" && typeof process !== "undefined") {
  runSelfCheck();
  process.stdout.write("seat 自检通过\n");
}
