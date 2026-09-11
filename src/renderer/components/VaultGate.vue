<script setup lang="ts">
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const { pickForCreate, pickForOpen } = useVault()
const toast = useToast()

async function onCreate() {
  const res = await pickForCreate()
  if (res.status === 'already-vault') {
    toast.warn('该目录已经是加密文件库，请改用「打开文件库」——在此新建会覆盖原数据。')
  }
}

async function onOpen() {
  const res = await pickForOpen()
  if (res.status === 'not-vault') {
    toast.warn('该目录不是加密文件库（未找到 vault.meta）。请选择文件库文件夹，或在此新建。')
  }
}
</script>

<template>
  <div class="gate">
    <div class="brand">
      <div class="logo">宝</div>
      <h1>宝宝巴士</h1>
      <p>本地离线 · 加密文件库 · 不联网</p>
    </div>

    <div class="cards">
      <button class="card" @click="onCreate">
        <div class="ico">
          <svg viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" stroke-width="2" stroke-linecap="round" />
          </svg>
        </div>
        <div class="title">新建文件库</div>
        <div class="desc">选择一个文件夹作为加密文件库，并设置主密码</div>
      </button>

      <button class="card" @click="onOpen">
        <div class="ico">
          <svg viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
        </div>
        <div class="title">打开文件库</div>
        <div class="desc">选择已有的文件库文件夹，输入主密码解锁</div>
      </button>
    </div>

    <div class="foot">
      <span>软件不会自动创建文件库，位置始终由你指定</span>
      <span class="dot">·</span>
      <span>忘记主密码无法恢复</span>
    </div>
  </div>
</template>

<style scoped>
.gate {
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center; /* 上下居中 */
  padding: 24px;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 32px;
}

.logo {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #3b6ef5, #6a8cff);
  color: #fff;
  font-size: 22px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 20px rgba(59, 110, 245, 0.26);
}

.brand h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.brand p {
  font-size: 12.5px;
  color: var(--muted);
}

.cards {
  display: flex;
  gap: 16px;
  margin-bottom: 26px;
}

.card {
  width: 232px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  text-align: left;
  transition: 0.18s;
}

.card:hover {
  border-color: var(--accent);
  box-shadow: 0 6px 18px rgba(59, 110, 245, 0.12);
  transform: translateY(-2px);
}

.ico {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--accent-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 11px;
}

.ico svg {
  width: 18px;
  height: 18px;
  stroke: var(--accent);
  fill: none;
  stroke-width: 1.7;
  stroke-linejoin: round;
}

.title {
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 4px;
}

.desc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}

.recent {
  width: 480px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}

.recent-head {
  padding: 9px 13px;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel-3);
  border-bottom: 1px solid var(--line-soft);
}

.recent-item {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line-soft);
}

.recent-item:last-child {
  border-bottom: none;
}

.recent-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  min-width: 0;
  text-align: left;
}

.recent-main:hover {
  background: var(--hover);
}

.rname {
  font-weight: 500;
  flex: 0 0 auto;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpath {
  flex: 1;
  color: var(--faint);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rtime {
  color: var(--faint);
  font-size: 11.5px;
  flex: 0 0 auto;
}

.remove {
  width: 34px;
  color: var(--faint);
  font-size: 16px;
  line-height: 1;
}

.remove:hover {
  color: var(--danger);
}

.foot {
  margin-top: 26px;
  font-size: 12px;
  color: var(--faint);
  display: flex;
  gap: 8px;
}

.dot {
  opacity: 0.5;
}
</style>
