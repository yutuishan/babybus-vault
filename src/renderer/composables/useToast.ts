import { ref } from 'vue'

export type ToastTone = 'info' | 'ok' | 'warn' | 'error'

export interface Toast {
  id: number
  text: string
  tone: ToastTone
}

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  function push(text: string, tone: ToastTone = 'info', duration = 3200) {
    const id = ++seq
    toasts.value.push({ id, text, tone })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
  }

  return {
    toasts,
    info: (t: string) => push(t, 'info'),
    ok: (t: string) => push(t, 'ok'),
    warn: (t: string) => push(t, 'warn'),
    error: (t: string) => push(t, 'error', 5000),
    dismiss: (id: number) => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    },
  }
}
