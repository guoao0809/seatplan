// 分座历史记录：只存座位 JSON（不存图片），可由 JSON 回显到排座页。

export interface SeatRecord {
  id: string;
  exportedAt: number;
  rows: number[];
  /** 各组配色；早期记录没有此字段，回退默认调色板 */
  colors?: string[];
  /** 多次排座时的轮次说明，如「第 3 次」；单张记录没有此字段 */
  label?: string;
  seatsPerRow: number;
  singleSeatName: string;
  /** 座位网格（组 → 排 → 座 → 姓名或 null） */
  grid: (string | null)[][][];
  /** 整组轮换（N 个网格）；一次排座生成 N 轮时带此字段。老记录没有它 → 视为单轮 */
  rounds?: (string | null)[][][][];
}

/** 回显到排座页所需的数据子集 */
export type RestorePayload = Pick<
  SeatRecord,
  "rows" | "colors" | "seatsPerRow" | "singleSeatName" | "grid" | "rounds"
>;

export const LS_RECORDS = "seatplan:records";

/** 读取全部记录（最新的在前），损坏则回退空数组 */
export function loadRecords(): SeatRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_RECORDS) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveRecords(list: SeatRecord[]): boolean {
  try {
    localStorage.setItem(LS_RECORDS, JSON.stringify(list));
    return true;
  } catch {
    // localStorage 容量不足（图片 dataURL 较大时可能触顶）
    return false;
  }
}
