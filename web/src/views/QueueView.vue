<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  cancelQueue,
  fetchQueues,
  pauseQueue,
  regenerateMemory,
  resumeQueue,
  runQueue,
  saveSettings,
  type QueueName,
  type QueueOverview,
} from "../api";

const overview = ref<QueueOverview | null>(null);
const busy = ref("");
const msg = ref("");
const msgOk = ref(true);
let timer: number | undefined;

function flash(text: string, ok = true): void {
  msg.value = text;
  msgOk.value = ok;
  window.setTimeout(() => {
    if (msg.value === text) msg.value = "";
  }, 4000);
}

async function load(): Promise<void> {
  try {
    overview.value = await fetchQueues();
  } catch (e) {
    flash(e instanceof Error ? e.message : "加载队列失败", false);
  }
}

interface QueueMeta {
  title: string;
  verb: string;
  pendingLabel: string;
  runningLabel: string;
  allConfirm: string;
  desc: string;
}

const META: Record<QueueName, QueueMeta> = {
  audit: {
    title: "审核评分",
    verb: "审核",
    pendingLabel: "待审核",
    runningLabel: "审核中",
    allConfirm: "将重新审核全部未标记重复的照片（约 {n} 张），清空评分并重新消耗 AI 调用；重复照片保持标记、不参与。确定继续？",
    desc: "「缺省审核」只处理待审核和失败的照片；「全部审核」会清空评分重跑所有未标记重复的照片（重复照片始终不参与）。",
  },
  compose: {
    title: "构图装裱",
    verb: "构图",
    pendingLabel: "待构图",
    runningLabel: "构图中",
    allConfirm: "将重新构图全部已通过照片（约 {n} 张），清空装裱指令并重新消耗 AI 调用。确定继续？",
    desc: "「缺省构图」只处理已通过但尚未装裱的照片；「全部构图」会重跑所有已通过照片。",
  },
  dhash: {
    title: "相似分析",
    verb: "分析",
    pendingLabel: "待分析",
    runningLabel: "分析中",
    allConfirm: "将重新分析全部照片（约 {n} 张），只下载缩略图计算哈希，不消耗 AI 调用；本地相似分组会重建。确定继续？",
    desc: "对每张照片计算感知哈希，时间相近且画面相似的归为一组，每组只保留一张。「缺省分析」只处理未分析和失败的照片。",
  },
  cartoon: {
    title: "漫画化",
    verb: "漫画化",
    pendingLabel: "待漫画化",
    runningLabel: "生成中",
    allConfirm: "将重新生成全部 AI 判定要漫画化的照片（约 {n} 张），清掉旧漫画图并重新消耗图像生成调用。确定继续？",
    desc: "装裱时 AI 判定适合漫画化的照片会进入此队列，由漫画化模型生成漫画图，照片墙与轮播随后展示漫画图。「缺省漫画化」只处理还没有漫画图或此前失败的照片。",
  },
};

const cards = computed(() =>
  overview.value
    ? (["audit", "compose", "dhash", "cartoon"] as const).map((name) => ({
        name,
        meta: META[name],
        q: overview.value![name],
      }))
    : []
);

type MemoryKind = "audit" | "compose";

const MEMORY_META: Record<MemoryKind, { title: string }> = {
  audit: { title: "审核记忆" },
  compose: { title: "装裱记忆" },
};

const memoryItems = computed(() => {
  const m = overview.value?.memory;
  if (!m) return [];
  return (["audit", "compose"] as const).map((kind) => ({
    kind,
    meta: MEMORY_META[kind],
    s: m[kind],
  }));
});

/** 手动触发一次总结（不等阈值） */
async function learn(kind: MemoryKind): Promise<void> {
  busy.value = `memory-${kind}`;
  try {
    await regenerateMemory(kind);
    flash(`${MEMORY_META[kind].title}已更新`);
    await load();
  } catch (e) {
    flash(e instanceof Error ? e.message : "学习失败", false);
  } finally {
    busy.value = "";
  }
}

/** 暂停 / 恢复自动学习（对应设置里的 memoryEnabled） */
async function toggleMemory(): Promise<void> {
  const m = overview.value?.memory;
  if (!m) return;
  busy.value = "memory-pause";
  try {
    await saveSettings({ memoryEnabled: !m.audit.enabled });
    flash(m.audit.enabled ? "自动学习已暂停" : "自动学习已恢复");
    await load();
  } catch (e) {
    flash(e instanceof Error ? e.message : "操作失败", false);
  } finally {
    busy.value = "";
  }
}

async function run(name: QueueName, mode: "all" | "missing"): Promise<void> {
  const q = overview.value?.[name];
  if (!q) return;
  const meta = META[name];
  if (mode === "all") {
    const count = q.counts.done + q.counts.pending + q.counts.failed;
    if (!confirm(meta.allConfirm.replace("{n}", String(count)))) return;
  }
  busy.value = `${name}-${mode}`;
  try {
    const r = await runQueue(name, mode);
    flash(`已加入${meta.verb}队列：${r.queued} 张${q.paused ? "（当前已暂停，恢复后开始）" : ""}`);
    await load();
  } catch (e) {
    flash(e instanceof Error ? e.message : "操作失败", false);
  } finally {
    busy.value = "";
  }
}

async function togglePause(name: QueueName): Promise<void> {
  const q = overview.value?.[name];
  if (!q) return;
  const meta = META[name];
  busy.value = `${name}-pause`;
  try {
    if (q.paused) {
      await resumeQueue(name);
      flash(`${meta.verb}队列已恢复`);
    } else {
      await pauseQueue(name);
      flash(`${meta.verb}队列已暂停`);
    }
    await load();
  } catch (e) {
    flash(e instanceof Error ? e.message : "操作失败", false);
  } finally {
    busy.value = "";
  }
}

async function cancel(name: QueueName): Promise<void> {
  const q = overview.value?.[name];
  if (!q) return;
  const meta = META[name];
  if (!confirm(`取消${meta.verb}队列中 ${q.pending} 个等待任务？运行中的任务无法中止。`)) return;
  busy.value = `${name}-cancel`;
  try {
    const r = await cancelQueue(name);
    flash(`已取消 ${r.cancelled} 个等待任务`);
    await load();
  } catch (e) {
    flash(e instanceof Error ? e.message : "操作失败", false);
  } finally {
    busy.value = "";
  }
}

function percent(q: { counts: { done: number; pending: number; running: number; failed: number } }): string {
  const total = q.counts.done + q.counts.pending + q.counts.running + q.counts.failed;
  return total > 0 ? `${Math.round((q.counts.done / total) * 100)}%` : "—";
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 2500);
});

onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="queue-view">
    <header class="head">
      <div>
        <h2>任务队列</h2>
        <p class="hint">参考 Immich 的任务队列形式：暂停后不再发起新的 AI 调用，取消只移除尚未开始的任务。</p>
      </div>
      <span v-if="msg" class="msg" :class="{ ok: msgOk }">{{ msg }}</span>
    </header>

    <div v-if="!overview" class="state">加载中…</div>

    <div v-else class="grid">
      <section
        v-for="item in cards"
        :key="item.name"
        class="card queue-card"
      >
        <header class="card-head">
          <h3>{{ item.meta.title }}</h3>
          <span class="status" :class="{ paused: item.q.paused }">
            <i />
            {{ item.q.paused ? "已暂停" : "运行中" }}
          </span>
        </header>

        <div class="counts">
          <div class="count">
            <b>{{ item.q.counts.pending }}</b>
            <span>{{ item.meta.pendingLabel }}</span>
          </div>
          <div class="count">
            <b>{{ item.q.counts.running }}</b>
            <span>{{ item.meta.runningLabel }}</span>
          </div>
          <div class="count">
            <b>{{ item.q.pending }}</b>
            <span>队列等待</span>
          </div>
          <div class="count">
            <b>{{ item.q.counts.failed }}</b>
            <span>失败</span>
          </div>
        </div>

        <div class="meta">
          <span>并发 {{ item.q.concurrency }}</span>
          <span>每批 {{ item.q.batchSize }} 张</span>
          <span>已完成 {{ item.q.counts.done }} · {{ percent(item.q) }}</span>
        </div>

        <div class="actions">
          <button
            class="primary"
            :disabled="busy !== ''"
            @click="run(item.name, 'all')"
          >
            全部{{ item.meta.verb }}
          </button>
          <button :disabled="busy !== ''" @click="run(item.name, 'missing')">
            缺省{{ item.meta.verb }}
          </button>
          <button :disabled="busy !== ''" @click="togglePause(item.name)">
            {{ item.q.paused ? "继续处理" : "全部暂停" }}
          </button>
          <button class="danger" :disabled="busy !== ''" @click="cancel(item.name)">
            全部取消
          </button>
        </div>
        <p class="hint small">{{ item.meta.desc }}</p>
      </section>

      <section v-if="overview.memory" class="card queue-card">
        <header class="card-head">
          <h3>赞/踩审美学习</h3>
          <span class="status" :class="{ paused: !overview.memory.audit.enabled }">
            <i />
            {{ overview.memory.audit.enabled ? "自动学习开启" : "自动学习暂停" }}
          </span>
        </header>

        <div class="mem-list">
          <div v-for="item in memoryItems" :key="item.kind" class="mem-row">
            <div class="mem-info">
              <b>{{ item.meta.title }}</b>
              <span>
                待学习 {{ item.s.pending }} / 阈值 {{ item.s.threshold }} ·
                {{ item.s.learned ? "已有记忆" : "暂无记忆" }}
                <template v-if="item.s.running">· 总结中…</template>
              </span>
            </div>
            <button
              :disabled="busy !== '' || item.s.running || item.s.pending === 0"
              @click="learn(item.kind)"
            >
              {{ item.s.running ? "总结中…" : "立即学习" }}
            </button>
          </div>
        </div>

        <div class="actions">
          <button :disabled="busy !== ''" @click="toggleMemory">
            {{ overview.memory.audit.enabled ? "暂停自动学习" : "恢复自动学习" }}
          </button>
        </div>
        <p class="hint small">
          赞/踩先攒起来，攒够阈值后自动总结成审美记忆并注入后续审核/装裱提示词（阈值与总结提示词在设置页配置）；「立即学习」不等阈值、手动触发一次总结，待学习为 0 时不可点。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.queue-view {
  padding: 16px 24px 40px;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.head h2 {
  margin: 4px 0 6px;
}
.hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
}
.hint.small {
  font-size: 12px;
  margin-top: 12px;
}
.msg {
  font-size: 13px;
  color: var(--danger);
}
.msg.ok {
  color: var(--ok);
}
.state {
  padding: 60px;
  text-align: center;
  color: var(--text-dim);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
}
.queue-card {
  padding: 18px 20px 20px;
  display: flex;
  flex-direction: column;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-head h3 {
  margin: 0;
  color: var(--accent);
  font-size: 16px;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--ok);
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(108, 201, 143, 0.35);
  background: rgba(108, 201, 143, 0.08);
}
.status i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.status.paused {
  color: var(--accent);
  border-color: rgba(201, 162, 39, 0.4);
  background: rgba(201, 162, 39, 0.08);
}
.counts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 18px 0 10px;
}
.count {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.count b {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.count span {
  font-size: 12px;
  color: var(--text-dim);
}
.meta {
  display: flex;
  gap: 18px;
  color: var(--text-dim);
  font-size: 12px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.mem-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
.mem-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.mem-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.mem-info b {
  font-size: 14px;
}
.mem-info span {
  font-size: 12px;
  color: var(--text-dim);
}
</style>
