import { ref } from "vue";

export type ToastType = "error" | "success";

export const activeToast = ref<{ message: string; type: ToastType } | null>(null);

let dismissTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, type: ToastType = "success", duration = 4000) {
  if (dismissTimer) clearTimeout(dismissTimer);
  activeToast.value = { message, type };
  dismissTimer = setTimeout(() => { activeToast.value = null; }, duration);
}

export function showError(message: string) {
  showToast(message, "error", 5000);
}

export function dismissToast() {
  if (dismissTimer) clearTimeout(dismissTimer);
  activeToast.value = null;
}
