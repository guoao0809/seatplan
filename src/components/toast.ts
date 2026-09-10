import { ref } from "vue";

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

export const toasts = ref<ToastItem[]>([]);
let seq = 0;

/** 弹出全局提示，3 秒自动消失 */
export function showToast(message: string, type: ToastType = "info") {
  const id = ++seq;
  toasts.value.push({ id, message, type });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}
