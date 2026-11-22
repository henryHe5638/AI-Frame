<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  createUser,
  deleteUser,
  exportData,
  exportDb,
  fetchModels,
  fetchSettings,
  fetchUsers,
  importData,
  importDb,
  logout,
  regenerateMemory,
  saveSettings,
  type AiSettings,
  type AuthUser,
  type ModelInfo,
  type Settings,
} from "../api";
import { customFontList, loadCustomFonts } from "../customFonts";
import { resetHudLayouts } from "../hudLayout";

loadCustomFonts();

const settings = ref<Settings | null>(null);
const immichApiKeyInput = ref("");
const auditKeyInput = ref("");
const composeKeyInput = ref("");
const saving = ref(false);
const msg = ref("");
const msgOk = ref(true);
const memoryRegen = ref<"" | "compose" | "audit">("");
const overwriteSettings = ref(false);
const importFile = ref<File | null>(null);
const migrating = ref(false);
const dbImporting = ref(false);
const dbFileInput = ref<HTMLInputElement | null>(null);
/** 用户管理 */
const users = ref<AuthUser[]>([]);
const newUserName = ref("");
const newUserPass = ref("");
/** 模型下拉列表（点「获取列表」后从 AI 提供方拉取，带能力标注） */
const modelLists = ref<{ audit: ModelInfo[]; compose: ModelInfo[] }>({ audit: [], compose: [] });
const modelsLoading = ref<"" | "audit" | "compose">("");

/** 当前选中模型的能力标注；不在列表中（未拉取或手动输入）时返回 null（视为未知，配置项全部显示） */
function capsOf(group: "audit" | "compose", modelId: string): ModelInfo | null {
  return modelLists.value[group].find((m) => m.id === modelId) ?? null;
}

const auditCaps = computed(() => capsOf("audit", settings.value?.audit.model ?? ""));
const composeCaps = computed(() => capsOf("compose", settings.value?.compose.model ?? ""));
const cartoonCaps = computed(() => capsOf("compose", settings.value?.compose.cartoonModel ?? ""));

/** 是否显示思考模式开关：未知模型显示（交由用户决定），已知不支持的隐藏 */
const showAuditThinking = computed(() => !auditCaps.value || auditCaps.value.thinking);
const showComposeThinking = computed(() => !composeCaps.value || composeCaps.value.thinking);

/** 能力标签（datalist 选项后展示） */
function capLabel(m: ModelInfo): string {
  const tags: string[] = [];
  if (m.vision) tags.push("视觉");
  if (m.imageGen) tags.push("图像生成");
  if (m.thinking) tags.push("思考");
  return tags.length > 0 ? `（${tags.join(" · ")}）` : "";
}

async function onFetchModels(group: "audit" | "compose"): Promise<void> {
  modelsLoading.value = group;
  try {
    const r = await fetchModels(group);
    modelLists.value = { ...modelLists.value, [group]: r.models };
    flash(r.models.length > 0 ? `获取到 ${r.models.length} 个模型` : "提供方返回的模型列表为空");
  } catch (e) {
    flash(e instanceof Error ? e.message : "获取模型列表失败", false);
  } finally {
    modelsLoading.value = "";
  }
}

const webhookUrl = `${location.origin}/api/immich-webhook`;

function flash(text: string, ok = true): void {
  msg.value = text;
  msgOk.value = ok;
  window.setTimeout(() => {
    if (msg.value === text) msg.value = "";
  }, 4000);
}

onMounted(() => {
  fetchSettings()
    .then((s) => (settings.value = s))
    .catch((e: unknown) => flash(e instanceof Error ? e.message : "加载设置失败", false));
  fetchUsers()
    .then((r) => (users.value = r.users))
    .catch(() => undefined);
});

async function onCreateUser(): Promise<void> {
  try {
    const r = await createUser(newUserName.value, newUserPass.value);
    users.value = r.users;
    newUserName.value = "";
    newUserPass.value = "";
    flash("用户已创建");
  } catch (e) {
    flash(e instanceof Error ? e.message : "创建失败", false);
  }
}

async function onDeleteUser(u: AuthUser): Promise<void> {
  if (!confirm(`确定删除用户「${u.username}」？`)) return;
  try {
    const r = await deleteUser(u.id);
    users.value = r.users;
    flash("已删除");
  } catch (e) {
    flash(e instanceof Error ? e.message : "删除失败", false);
  }
}

function aiPatch(
  inputKey: string,
  group: AiSettings
): Partial<AiSettings> {
  const patch: Partial<AiSettings> = {
    baseUrl: group.baseUrl,
    model: group.model,
    prompt: group.prompt,
    thinking: group.thinking ?? "default",
    cartoonEnabled: group.cartoonEnabled ?? false,
    cartoonModel: group.cartoonModel ?? "",
    cartoonPrompt: group.cartoonPrompt ?? "",
  };
  if (inputKey.trim()) patch.apiKey = inputKey.trim();
  return patch;
}

async function onSave(): Promise<void> {
  if (!settings.value) return;
  saving.value = true;
  try {
    const s = settings.value;
    const patch: Partial<Settings> = {
      immichBaseUrl: s.immichBaseUrl,
      pollIntervalSec: Number(s.pollIntervalSec) || 300,
      frameFit: s.frameFit,
      frameShowClock: s.frameShowClock,
      frameShowCalendar: s.frameShowCalendar,
      publicBaseUrl: s.publicBaseUrl ?? "",
      framePreferAspect: s.framePreferAspect,
      frameIntervalSec: Number(s.frameIntervalSec) || 10,
      amapKey: s.amapKey ?? "",
      amapSecurityCode: s.amapSecurityCode ?? "",
      localDedupEnabled: s.localDedupEnabled,
      localDedupThreshold: Number(s.localDedupThreshold) || 8,
      localDedupWindowMin: Number(s.localDedupWindowMin) || 120,
      clarityThreshold: Number(s.clarityThreshold) || 7,
      beautyThreshold: Number(s.beautyThreshold) || 7,
      storyThreshold: Number(s.storyThreshold) || 6,
      auditConcurrency: Number(s.auditConcurrency),
      composeConcurrency: Number(s.composeConcurrency),
      dhashConcurrency: Number(s.dhashConcurrency) || 6,
      cartoonConcurrency: Number(s.cartoonConcurrency) || 2,
      cartoonRatio: Number(s.cartoonRatio) || 0.1,
      auditBatchSize: Number(s.auditBatchSize) || 1,
      composeBatchSize: Number(s.composeBatchSize) || 1,
      memoryEnabled: s.memoryEnabled ?? true,
      memoryThreshold: Number(s.memoryThreshold) || 5,
      memoryComposePrompt: s.memoryComposePrompt ?? "",
      memoryAuditPrompt: s.memoryAuditPrompt ?? "",
      audit: aiPatch(auditKeyInput.value, s.audit) as AiSettings,
      compose: aiPatch(composeKeyInput.value, s.compose) as AiSettings,
    };
    if (immichApiKeyInput.value.trim()) patch.immichApiKey = immichApiKeyInput.value.trim();
    settings.value = await saveSettings(patch);
    immichApiKeyInput.value = "";
    auditKeyInput.value = "";
    composeKeyInput.value = "";
    flash("保存成功");
  } catch (e) {
    flash(e instanceof Error ? e.message : "保存失败", false);
  } finally {
    saving.value = false;
  }
}

async function onRegenerateMemory(kind: "compose" | "audit"): Promise<void> {
  memoryRegen.value = kind;
  try {
    const r = await regenerateMemory(kind);
    if (settings.value) {
      if (kind === "compose") {
        settings.value.composeMemory = r.memory;
        settings.value.composeFeedbackPending = 0;
      } else {
        settings.value.auditMemory = r.memory;
        settings.value.auditFeedbackPending = 0;
      }
    }
    flash("审美记忆已更新");
  } catch (e) {
    flash(e instanceof Error ? e.message : "生成失败", false);
  } finally {
    memoryRegen.value = "";
  }
}

async function onResetHudLayout(): Promise<void> {
  resetHudLayouts();
  flash("已恢复本设备时钟 / 日历默认位置与大小（布局按设备保存，其他设备需在各自页面上重置）");
}

async function onExport(): Promise<void> {
  migrating.value = true;
  try {
    await exportData();
    flash("已导出");
  } catch (e) {
    flash(e instanceof Error ? e.message : "导出失败", false);
  } finally {
    migrating.value = false;
  }
}

async function onImport(): Promise<void> {
  if (!importFile.value) {
    flash("请先选择导出 JSON 文件", false);
    return;
  }
  migrating.value = true;
  try {
    const data: unknown = JSON.parse(await importFile.value.text());
    const r = await importData(data, overwriteSettings.value);
    flash(`导入完成：${r.imported ?? "?"} 张照片`);
    settings.value = await fetchSettings();
  } catch (e) {
    flash(e instanceof Error ? e.message : "导入失败", false);
  } finally {
    migrating.value = false;
  }
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  importFile.value = input.files?.[0] ?? null;
}

function onExportDb(): void {
  exportDb();
  flash("已开始下载数据库文件");
}

function onDbFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = "";
  if (!file) return;
  if (!confirm(`将导入数据库「${file.name}」覆盖当前数据，导入后服务会自动重启，约 5 秒后刷新页面。确定继续？`)) return;
  dbImporting.value = true;
  importDb(file)
    .then(() => {
      flash("导入成功，服务正在重启，约 5 秒后自动刷新…");
      window.setTimeout(() => location.reload(), 5000);
    })
    .catch((e: unknown) => {
      flash(e instanceof Error ? e.message : "导入失败", false);
      dbImporting.value = false;
    });
}

async function copyWebhook(): Promise<void> {
  try {
    await navigator.clipboard.writeText(webhookUrl);
    flash("已复制 webhook 地址");
  } catch {
    flash("复制失败，请手动复制", false);
  }
}

async function onLogout(): Promise<void> {
  await logout().catch(() => undefined);
  location.href = "/login";
}
</script>

<template>
  <div class="settings-view">
    <h2>设置</h2>
    <div v-if="!settings" class="state">加载中…</div>
    <template v-else>
      <section class="card group">
        <h3>Immich</h3>
        <label class="row">
          <span>地址</span>
          <input v-model="settings.immichBaseUrl" placeholder="http://immich:2283" />
        </label>
        <label class="row">
          <span>API Key</span>
          <input
            v-model="immichApiKeyInput"
            type="password"
            :placeholder="`当前：${settings.immichApiKey || '未设置'}，留空则不修改`"
            autocomplete="new-password"
          />
        </label>
        <label class="row">
          <span>轮询间隔（秒）</span>
          <input v-model.number="settings.pollIntervalSec" type="number" min="30" />
        </label>
        <div class="row webhook">
          <span>Webhook 地址</span>
          <code>{{ webhookUrl }}</code>
          <button @click="copyWebhook">复制</button>
        </div>
        <p class="hint">在 Immich 中创建 Workflow（v3），触发事件指向以上地址即可实时同步。</p>
      </section>

      <section class="card group">
        <h3>轮播显示</h3>
        <div class="row two">
          <label>
            <span>切换间隔（秒）</span>
            <input v-model.number="settings.frameIntervalSec" type="number" min="2" max="3600" />
          </label>
          <label>
            <span>画面适配</span>
            <select v-model="settings.frameFit">
              <option value="contain">适应（完整显示，留白）</option>
              <option value="cover">填充（铺满，裁切边缘）</option>
              <option value="stretch">拉伸（铺满，可能变形）</option>
            </select>
          </label>
        </div>
        <div class="row two">
          <label class="inline-check">
            <input v-model="settings.frameShowClock" type="checkbox" />
            显示时钟
          </label>
          <label class="inline-check">
            <input v-model="settings.frameShowCalendar" type="checkbox" />
            显示日历
          </label>
        </div>
        <label class="row inline-check">
          <input v-model="settings.framePreferAspect" type="checkbox" />
          优先播放与屏幕比例接近的照片（横屏电视优先横构图）
        </label>
        <p class="hint">轮播页也可用 URL 参数临时覆盖，例如 ?fit=cover&amp;interval=20。</p>
        <div class="row two">
          <label>
            <span>高德地图 Key（JS API）</span>
            <input v-model="settings.amapKey" type="text" placeholder="留空则用免 key 静态地图" />
          </label>
          <label>
            <span>高德安全密钥</span>
            <input v-model="settings.amapSecurityCode" type="text" placeholder="与 Key 配对的安全密钥" />
          </label>
        </div>
        <p class="hint">
          在<a href="https://lbs.amap.com/" target="_blank" rel="noopener">高德开放平台</a>创建「Web端（JS API）」应用获取；
          配置后轮播页信息卡显示可拖动缩放的地图，否则退回免 key 的静态小地图。
        </p>
        <div class="row hud-reset">
          <span>浮层布局</span>
          <button @click="onResetHudLayout">恢复时钟 / 日历默认位置与大小</button>
        </div>
        <p class="hint">在轮播页点击底部「布局」按钮后，可直接拖动时钟、日历调整位置，拖动右下角圆点或滚轮缩放；位置与大小会保存到服务端。</p>
      </section>

      <section class="card group">
        <h3>相似照片去重</h3>
        <div class="row two">
          <label>
            <span>相似阈值（0-32）</span>
            <input v-model.number="settings.localDedupThreshold" type="number" min="0" max="32" />
          </label>
          <label>
            <span>时间窗口（分钟）</span>
            <input v-model.number="settings.localDedupWindowMin" type="number" min="1" max="10080" />
          </label>
          <label>
            <span>分析并发数</span>
            <input v-model.number="settings.dhashConcurrency" type="number" min="1" max="32" />
          </label>
        </div>
        <label class="row inline-check">
          <input v-model="settings.localDedupEnabled" type="checkbox" />
          启用本地相似分析（连拍/同场景照片自动去重）
        </label>
        <p class="hint">
          对每张照片计算感知哈希，拍摄时间在窗口内且哈希距离 ≤
          阈值的视为同场景连拍，每组只保留一张参与审核与轮播。阈值越大越宽松（容易误并），默认
          8；窗口默认 120 分钟，防止把不同场合的相似构图误并。修改后需重新同步生效。
        </p>
      </section>

      <section class="card group">
        <h3>第一组 AI · 审核评分</h3>
        <label class="row">
          <span>Base URL</span>
          <input v-model="settings.audit.baseUrl" placeholder="https://api.openai.com/v1" />
        </label>
        <label class="row">
          <span>API Key</span>
          <input
            v-model="auditKeyInput"
            type="password"
            :placeholder="`当前：${settings.audit.apiKey || '未设置'}，留空则不修改`"
            autocomplete="new-password"
          />
        </label>
        <div class="row">
          <span>模型</span>
          <input v-model="settings.audit.model" placeholder="gpt-4o-mini" list="audit-model-list" />
          <datalist id="audit-model-list">
            <option v-for="m in modelLists.audit" :key="m.id" :value="m.id" :label="capLabel(m)" />
          </datalist>
          <button :disabled="modelsLoading !== ''" @click="onFetchModels('audit')">
            {{ modelsLoading === "audit" ? "获取中…" : "获取模型列表" }}
          </button>
        </div>
        <p v-if="auditCaps && !auditCaps.vision" class="hint warn">
          该模型似乎不支持图片输入，审核评分需要视觉模型。
        </p>
        <label v-if="showAuditThinking" class="row">
          <span>思考模式</span>
          <select v-model="settings.audit.thinking">
            <option value="default">默认（由模型决定）</option>
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </select>
        </label>
        <label class="row col">
          <span>提示词</span>
          <textarea v-model="settings.audit.prompt" rows="7" />
        </label>
        <div class="row two">
          <label>
            <span>清晰度阈值</span>
            <input v-model.number="settings.clarityThreshold" type="number" min="1" max="10" />
          </label>
          <label>
            <span>美观度阈值</span>
            <input v-model.number="settings.beautyThreshold" type="number" min="1" max="10" />
          </label>
          <label>
            <span>故事性阈值</span>
            <input v-model.number="settings.storyThreshold" type="number" min="1" max="10" />
          </label>
        </div>
        <div class="row two">
          <label>
            <span>并发数</span>
            <input v-model.number="settings.auditConcurrency" type="number" min="1" max="16" />
          </label>
          <label>
            <span>批量大小</span>
            <input v-model.number="settings.auditBatchSize" type="number" min="1" max="30" />
          </label>
        </div>
        <p class="hint">三个维度都不低于各自阈值才通过并进入装裱；批量大小 1-30，&gt; 1 时一次请求评审多张照片（吞吐更高）。批量输出格式与 dupOf（同批重复标注）规则已写入上面的提示词，可直接编辑。模型偶发报错（重载/超时）只会拆分重试、不会降低批量；确属图片过多时自动收缩，成功后逐步恢复到设置值。</p>
        <div class="row memory-row">
          <span>AI 审美记忆</span>
          <div class="memory-box">
            <p class="memory-text" :class="{ dim: !settings.auditMemory }">
              {{ settings.auditMemory || "暂无记忆。在照片墙对审核结果点几个赞/踩后会自动总结生成。" }}
            </p>
            <button :disabled="memoryRegen !== ''" @click="onRegenerateMemory('audit')">
              {{ memoryRegen === "audit" ? "生成中…" : "重新生成记忆" }}
            </button>
            <span class="hint-inline">待学习 {{ settings.auditFeedbackPending ?? 0 }} 条</span>
          </div>
        </div>
        <p class="hint">审核赞 = 直接通过并进入装裱（不受阈值限制），审核踩 = 淘汰不再展示；赞/踩会连同原始分数与当时的阈值一起交给 AI 总结成记忆，注入后续每次审核的提示词。</p>
      </section>

      <section class="card group">
        <h3>第二组 AI · 构图装裱</h3>
        <label class="row">
          <span>Base URL</span>
          <input v-model="settings.compose.baseUrl" placeholder="https://api.openai.com/v1" />
        </label>
        <label class="row">
          <span>API Key</span>
          <input
            v-model="composeKeyInput"
            type="password"
            :placeholder="`当前：${settings.compose.apiKey || '未设置'}，留空则不修改`"
            autocomplete="new-password"
          />
        </label>
        <div class="row">
          <span>模型</span>
          <input v-model="settings.compose.model" placeholder="gpt-4o-mini" list="compose-model-list" />
          <datalist id="compose-model-list">
            <option v-for="m in modelLists.compose" :key="m.id" :value="m.id" :label="capLabel(m)" />
          </datalist>
          <button :disabled="modelsLoading !== ''" @click="onFetchModels('compose')">
            {{ modelsLoading === "compose" ? "获取中…" : "获取模型列表" }}
          </button>
        </div>
        <p v-if="composeCaps && !composeCaps.vision" class="hint warn">
          该模型似乎不支持图片输入，装裱需要视觉模型。
        </p>
        <label v-if="showComposeThinking" class="row">
          <span>思考模式</span>
          <select v-model="settings.compose.thinking">
            <option value="default">默认（由模型决定）</option>
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </select>
        </label>
        <label class="row inline-check">
          <input v-model="settings.compose.cartoonEnabled" type="checkbox" />
          允许 AI 在装裱时自行决定是否把照片漫画化（生成一张漫画风格的图像展示）
        </label>
        <template v-if="settings.compose.cartoonEnabled">
          <div class="row">
            <span>漫画化模型</span>
            <input
              v-model="settings.compose.cartoonModel"
              placeholder="gpt-image-1（OpenAI 兼容 /images/edits）"
              list="compose-model-list"
            />
            <button :disabled="modelsLoading !== ''" @click="onFetchModels('compose')">
              {{ modelsLoading === "compose" ? "获取中…" : "获取模型列表" }}
            </button>
          </div>
          <p v-if="cartoonCaps && !cartoonCaps.imageGen" class="hint warn">
            该模型似乎不支持图像生成，请选择标注「图像生成」的模型。
          </p>
          <div class="row">
            <span>漫画化并发数</span>
            <input v-model.number="settings.cartoonConcurrency" type="number" min="1" max="8" />
          </div>
          <label class="row">
            <span>漫画化频率上限</span>
            <input v-model.number="settings.cartoonRatio" type="number" min="0.01" max="1" step="0.01" />
          </label>
          <p class="hint">
            已装裱的照片中最多按此比例漫画化（0.1 = 每装裱 10 张最多 1 张）；
            超出后 AI 会被提示配额已用完，服务端也会硬性拦截，装裱量上来后配额自动恢复。
          </p>
          <label class="row col">
            <span>漫画化提示词</span>
            <textarea v-model="settings.compose.cartoonPrompt" rows="5" />
          </label>
          <label class="row">
            <span>公网访问地址</span>
            <input
              v-model="settings.publicBaseUrl"
              placeholder="https://frame.example.com（仅网关拉图通道需要）"
            />
          </label>
          <p class="hint">
            漫画化复用本组的 Base URL 与 API Key，优先调用 OpenAI 兼容的图像编辑接口（/images/edits，如
            gpt-image-1）。若提供方不支持上传图片（如阿里云 MaaS 网关只接受公网图片 URL），会自动改用
            /images/generations + 临时签名 URL 拉图——此时需要在上面填本服务的公网访问地址，
            签名 URL 30 分钟后失效。以上漫画化提示词是每次生成的基础要求（建议保留「保留构图与主体」类约束），
            装裱 AI 决定漫画化时给出的画风描述会追加在其后。装裱时由 AI 自行判断照片是否适合漫画化；
            漫画图生成后照片墙与轮播都会展示漫画图，重新装裱会清除并重新决定；漫画化失败不影响装裱，仍展示原图。
          </p>
        </template>
        <label class="row col">
          <span>提示词</span>
          <textarea v-model="settings.compose.prompt" rows="7" />
        </label>
        <p class="hint prompt-hint">
          题字字体（font）为 brush 毛笔 / kai 文楷 / cute 可爱 / round 粗圆 / hand 手写 /
          gentle 清秀。字体、展示比例、题字排版与 overlay（SVG 叠加层）等要求都已写入上面的提示词，可直接编辑；生成题字时会自动附上照片的拍摄时间与地点（有 GPS 时），供 AI 呼应。
        </p>
        <p class="hint prompt-hint">
          自定义字体：把 .ttf / .otf / .woff / .woff2 字体文件（如汉仪、方正、Aa 字库的字体）放入
          server/data/fonts/ 目录即可使用，text.font 填字体 id（文件名转小写、非字母数字转为 -）。
          <template v-if="customFontList.length">
            当前已加载：{{ customFontList.map((f) => `${f.id}（${f.family}）`).join("、") }}
          </template>
          <template v-else>当前未检测到自定义字体文件。</template>
        </p>
        <p class="hint prompt-hint">
          默认提示词为极简装裱：只做裁剪构图 + 一句题字，不加相框与 SVG 装饰。装裱指令仍支持 overlay 字段
          （AI 写的 SVG 叠加层，viewBox 固定 0 0 100 100，坐标 0-100 相对值），想恢复装饰效果可在提示词里
          重新要求输出 overlay；服务端会过滤脚本与外部资源，旧的带装饰装裱结果也会正常展示。
        </p>
        <div class="row two">
          <label>
            <span>并发数</span>
            <input v-model.number="settings.composeConcurrency" type="number" min="1" max="16" />
          </label>
          <label>
            <span>批量大小</span>
            <input v-model.number="settings.composeBatchSize" type="number" min="1" max="10" />
          </label>
        </div>
        <p class="hint">批量装裱建议不超过 3，避免整批照片风格趋同；1 表示逐张处理。</p>
        <div class="row memory-row">
          <span>AI 审美记忆</span>
          <div class="memory-box">
            <p class="memory-text" :class="{ dim: !settings.composeMemory }">
              {{ settings.composeMemory || "暂无记忆。在照片墙对装裱点几个赞/踩后会自动总结生成。" }}
            </p>
            <button :disabled="memoryRegen !== ''" @click="onRegenerateMemory('compose')">
              {{ memoryRegen === "compose" ? "生成中…" : "重新生成记忆" }}
            </button>
            <span class="hint-inline">待学习 {{ settings.composeFeedbackPending ?? 0 }} 条</span>
          </div>
        </div>
        <p class="hint">装裱的赞/踩会先攒起来，积累到学习阈值后批量交给 AI 总结成这段记忆；踩会另外立即触发一次重新装裱（带着旧指令快照避开旧风格）。记忆会注入后续每次装裱的提示词。</p>
      </section>

      <section class="card group">
        <h3>赞/踩批量学习</h3>
        <label class="row inline-check">
          <input v-model="settings.memoryEnabled" type="checkbox" />
          自动学习：赞/踩积累到阈值后自动总结进审美记忆
        </label>
        <label class="row">
          <span>学习阈值（条）</span>
          <input v-model.number="settings.memoryThreshold" type="number" min="1" max="50" />
        </label>
        <label class="row col">
          <span>审核记忆提示词</span>
          <textarea v-model="settings.memoryAuditPrompt" rows="4" />
        </label>
        <label class="row col">
          <span>装裱记忆提示词</span>
          <textarea v-model="settings.memoryComposePrompt" rows="4" />
        </label>
        <p class="hint">赞/踩先攒在反馈表里，攒够「学习阈值」条后才一次性交给 AI 总结（一次 AI 调用）；总结成功后装裱的踩记录会被清理（教训留在记忆里），赞记录保留为长期偏好样本。关闭自动学习后，可在上方各组里点「重新生成记忆」手动学习，记忆提示词在上方可编辑。</p>
      </section>

      <section class="card group">
        <h3>用户管理</h3>
        <div class="row user-head">
          <span>用户</span>
          <div class="user-list">
            <div v-for="u in users" :key="u.id" class="user-item">
              <span class="user-name">{{ u.username }}</span>
              <button class="danger-link" :disabled="users.length <= 1" @click="onDeleteUser(u)">
                删除
              </button>
            </div>
            <p v-if="users.length === 0" class="hint-inline">
              暂无用户。创建第一个用户后，全站（网页与 API）将强制登录。
            </p>
          </div>
        </div>
        <div class="row">
          <span>新建用户</span>
          <input v-model="newUserName" placeholder="用户名" autocomplete="off" />
          <input
            v-model="newUserPass"
            type="password"
            placeholder="密码"
            autocomplete="new-password"
          />
          <button :disabled="!newUserName || !newUserPass" @click="onCreateUser">创建</button>
        </div>
        <div class="row">
          <span></span>
          <button v-if="users.length > 0" @click="onLogout">退出登录</button>
        </div>
        <p class="hint">
          存在任一用户即强制全站登录（会话 7 天有效）；不允许删除最后一个用户。Immich webhook
          与漫画化用的公网签名图片地址不受影响。
        </p>
      </section>

      <section class="card group">
        <h3>数据迁移</h3>
        <div class="row two">
          <button :disabled="migrating" @click="onExport">导出 JSON</button>
          <div class="import">
            <input type="file" accept="application/json,.json" @change="onFileChange" />
            <label class="ow">
              <input v-model="overwriteSettings" type="checkbox" />
              同时覆盖设置（不含 API Key）
            </label>
            <button class="primary" :disabled="migrating" @click="onImport">导入</button>
          </div>
        </div>
        <div class="row two">
          <button :disabled="dbImporting" @click="onExportDb">导出数据库 (.db)</button>
          <div class="import">
            <input
              ref="dbFileInput"
              type="file"
              accept=".db,application/octet-stream"
              class="hidden-input"
              @change="onDbFileChange"
            />
            <button class="primary" :disabled="dbImporting" @click="dbFileInput?.click()">
              {{ dbImporting ? "导入中…" : "导入数据库 (.db)" }}
            </button>
            <span class="hint-inline">导入会覆盖现有数据，服务将自动重启，约 5 秒后刷新页面</span>
          </div>
        </div>
      </section>

      <div class="footer">
        <button class="primary big" :disabled="saving" @click="onSave">
          {{ saving ? "保存中…" : "保存设置" }}
        </button>
        <span v-if="msg" class="msg" :class="{ ok: msgOk }">{{ msg }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 16px 24px 60px;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h2 {
  margin: 4px 0;
}
.state {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
.group {
  padding: 16px 20px 20px;
}
.group h3 {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 15px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.row > span:first-child {
  width: 120px;
  flex-shrink: 0;
  color: var(--text-dim);
}
.row input:not([type="checkbox"]):not([type="file"]),
.row textarea {
  flex: 1;
  min-width: 0;
}
.inline-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.row.col {
  align-items: flex-start;
}
.row.col textarea {
  width: 100%;
}
.row.two {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.row.two label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row.two input[type="number"] {
  width: 90px;
}
.webhook code {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  overflow-x: auto;
  white-space: nowrap;
  font-size: 13px;
}
.hint {
  color: var(--text-dim);
  font-size: 12px;
  margin: 4px 0 0 132px;
}
.hint.warn {
  color: var(--danger);
}
.import {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.ow {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 13px;
}
.hidden-input {
  display: none;
}
.user-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.user-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
.user-name {
  font-weight: 500;
}
.danger-link {
  color: var(--danger);
  background: none;
  border: none;
  padding: 0;
  font-size: 13px;
  cursor: pointer;
}
.danger-link:disabled {
  color: var(--text-dim);
  cursor: not-allowed;
}
.user-head {
  align-items: flex-start;
}
.hint-inline {
  color: var(--text-dim);
  font-size: 12px;
}
.memory-row {
  align-items: flex-start;
}
.memory-box {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.memory-box button {
  align-self: flex-start;
}
.memory-text {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.memory-text.dim {
  color: var(--text-dim);
}
.footer {
  display: flex;
  align-items: center;
  gap: 14px;
}
.big {
  padding: 8px 28px;
}
.msg.ok {
  color: var(--ok);
}
.msg:not(.ok) {
  color: var(--danger);
}
</style>
