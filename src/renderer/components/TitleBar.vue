<script setup lang="ts">
import { useVault } from '../composables/useVault'

const { state } = useVault()

function minimize() {
  void window.api.windowMinimize()
}
function toggleMax() {
  void window.api.windowToggleMaximize()
}
function close() {
  void window.api.windowClose()
}
</script>

<template>
  <header class="bar">
    <div class="left">
      <span class="logo">宝</span>
      <span class="name">宝宝巴士</span>
      <span v-if="state.vault.name" class="sep">—</span>
      <span v-if="state.vault.name" class="vault">{{ state.vault.name }}</span>
    </div>

    <div class="drag" />

    <div class="right">
      <button class="wbtn" title="最小化" @click="minimize"><i class="i-min" /></button>
      <button class="wbtn" :title="state.maximized ? '还原' : '最大化'" @click="toggleMax">
        <i :class="state.maximized ? 'i-restore' : 'i-max'" />
      </button>
      <button class="wbtn close" title="关闭" @click="close"><i class="i-close" /></button>
    </div>
  </header>
</template>

<style scoped>
.bar {
  height: 38px;
  flex: 0 0 38px;
  display: flex;
  align-items: center;
  padding-left: 12px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(#fbfbfd, #f4f5f8);
  user-select: none;
}

.left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.logo {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: linear-gradient(135deg, #3b6ef5, #6a8cff);
  color: #fff;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}

.name {
  font-size: 12.5px;
  font-weight: 600;
}

.sep {
  color: var(--faint);
}

.vault {
  font-size: 12px;
  color: var(--muted);
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drag {
  flex: 1;
  height: 100%;
  -webkit-app-region: drag;
}

.right {
  display: flex;
  height: 100%;
}

.wbtn {
  width: 44px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  /* 父级 .drag 是 drag 区，必须显式排除按钮，否则按钮点不动 */
  -webkit-app-region: no-drag;
}

.wbtn:hover {
  background: #e6e9f0;
}

.wbtn.close:hover {
  background: #e81123;
  color: #fff;
}

.wbtn i {
  width: 10px;
  height: 10px;
  display: block;
  position: relative;
}

.i-min::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4.5px;
  width: 10px;
  height: 1px;
  background: currentColor;
}

.i-max::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid currentColor;
  border-radius: 1px;
}

.i-restore::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  width: 8px;
  height: 7px;
  border: 1px solid currentColor;
}

.i-restore::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  width: 8px;
  height: 7px;
  border: 1px solid currentColor;
  background: #f7f8fa;
}

.i-close::before,
.i-close::after {
  content: '';
  position: absolute;
  left: 0;
  top: 4.5px;
  width: 11px;
  height: 1px;
  background: currentColor;
}

.i-close::before {
  transform: rotate(45deg);
}

.i-close::after {
  transform: rotate(-45deg);
}
</style>
