<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="host">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast"
      :class="t.tone"
      @click="dismiss(t.id)"
    >
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.host {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 999;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  padding: 9px 16px;
  border-radius: 8px;
  background: #242a36;
  color: #fff;
  font-size: 12.5px;
  box-shadow: 0 8px 24px rgba(20, 26, 40, 0.22);
  cursor: pointer;
  animation: rise 0.22s ease;
  max-width: 520px;
}

.toast.ok {
  background: #157f3d;
}

.toast.warn {
  background: #a35b06;
}

.toast.error {
  background: #b42318;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
