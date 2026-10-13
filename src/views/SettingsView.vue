<script setup lang="ts">
// AI 模型设置页：改的就是 config.json，保存后 AI 弹窗重开即生效。
// 功能对齐 gitreport 的同名页；这里不带「接口协议」单选（seatplan 只有 OpenAI 一条请求路径）。
import { computed, onMounted, ref } from "vue";
import { Eye, EyeOff, LoaderCircle, RefreshCw, Save, Plug } from "lucide-vue-next";
import {
  loadAiConfig,
  listModels,
  saveAiConfig,
  testAiConnection,
  type AiConfig,
} from "../lib/ai";
import { showToast } from "../components/toast";

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-title outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60";
const BTN_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-text hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50";

/** 推理强度：与 Rust 侧 reasoning_effort() 的语义一一对应 */
const EFFORTS = [
  { value: "none", label: "none —— 关掉思考，2~4 秒出结果（默认）" },
  { value: "low", label: "low —— 轻量思考" },
  { value: "medium", label: "medium —— 中等思考，约 1 分钟" },
  { value: "high", label: "high —— 重度思考，最慢但最稳" },
  { value: "off", label: "off —— 不发送该参数，跟随模型默认" },
];

// 表单持有完整配置：没上界面的字段（如 temperature）保存时原样带回，不会被抹掉
const form = ref<AiConfig>({ baseUrl: "", apiKey: "", model: "" });
const configPath = ref("");
const loading = ref(true);
const loadError = ref("");
const showKey = ref(false);
const models = ref<string[]>([]);
const fetching = ref(false);
const testing = ref(false);
const saving = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);

const canTest = computed(
  () => !!form.value.baseUrl.trim() && !!form.value.model.trim() && !!form.value.apiKey.trim(),
);

onMounted(async () => {
  try {
    const loaded = await loadAiConfig();
    // 配置文件里没写推理强度时，Rust 侧的默认是 "none"，下拉要显示出来而不是空着
    form.value = { ...loaded.config, reasoningEffort: loaded.config.reasoningEffort ?? "none" };
    configPath.value = loaded.path;
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
});

async function fetchModels() {
  if (!form.value.baseUrl.trim() || !form.value.apiKey.trim()) {
    showToast("请先填写 Base URL 和 API Key", "error");
    return;
  }
  fetching.value = true;
  try {
    models.value = await listModels({ ...form.value });
    showToast(`获取到 ${models.value.length} 个模型，点列表里的名字即可填入`, "success");
  } catch (e) {
    models.value = [];
    showToast(`获取模型失败：${e}`, "error");
  } finally {
    fetching.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  testResult.value = null;
  try {
    const elapsed = await testAiConnection({ ...form.value });
    testResult.value = { ok: true, text: `连接成功，耗时 ${elapsed}` };
  } catch (e) {
    testResult.value = { ok: false, text: String(e) };
  } finally {
    testing.value = false;
  }
}

async function save() {
  if (!form.value.baseUrl.trim() || !form.value.model.trim() || !form.value.apiKey.trim()) {
    showToast("Base URL / 模型名称 / API Key 都要填", "error");
    return;
  }
  saving.value = true;
  try {
    configPath.value = await saveAiConfig(configPath.value, { ...form.value });
    showToast("配置已保存", "success");
  } catch (e) {
    showToast(`保存失败：${e}`, "error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-surface p-6">
    <div class="mx-auto max-w-xl">
      <h2 class="mb-1 text-lg font-semibold text-title">AI 模型</h2>
      <p class="mb-5 text-xs text-muted">
        改完点「保存配置」写回 config.json，AI 排座弹窗下次打开就用新配置。
      </p>

      <div v-if="loadError" class="mb-4 rounded-lg bg-red-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-red-600">
        {{ loadError }}
      </div>
      <div v-else-if="loading" class="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle :size="14" class="animate-spin" />
        正在读取配置…
      </div>

      <template v-else>
        <div class="mb-4">
          <label class="mb-1.5 block text-sm text-text">Base URL</label>
          <input v-model="form.baseUrl" :class="INPUT_CLASS" placeholder="https://api.openai.com/v1" />
        </div>

        <div class="mb-4">
          <label class="mb-1.5 block text-sm text-text">模型名称</label>
          <div class="flex gap-2">
            <input
              v-model="form.model"
              :class="INPUT_CLASS"
              placeholder="deepseek-v4-pro / gpt-4o-mini …"
            />
            <button :class="BTN_CLASS" :disabled="fetching" @click="fetchModels">
              <RefreshCw :size="14" :class="fetching ? 'animate-spin' : ''" />
              获取模型
            </button>
          </div>
          <!-- 不用原生 datalist：它会按输入框当前内容过滤，框里已有值时只剩一条，等于没列表 -->
          <div v-if="models.length" class="mt-2 rounded-lg border border-border bg-panel">
            <div class="flex items-center justify-between border-b border-border px-2.5 py-1.5">
              <span class="text-xs text-muted">共 {{ models.length }} 个模型，点一下填入</span>
              <button class="text-xs text-muted hover:text-title" @click="models = []">收起</button>
            </div>
            <div class="max-h-44 overflow-y-auto">
              <button
                v-for="m in models"
                :key="m"
                class="block w-full px-2.5 py-1.5 text-left text-xs hover:bg-surface"
                :class="m === form.model ? 'text-primary' : 'text-text'"
                @click="form.model = m"
              >
                {{ m }}
              </button>
            </div>
          </div>
        </div>

        <div class="mb-4">
          <label class="mb-1.5 block text-sm text-text">API Key</label>
          <div class="relative">
            <input
              v-model="form.apiKey"
              :type="showKey ? 'text' : 'password'"
              :class="[INPUT_CLASS, 'pr-10']"
              placeholder="sk-…"
            />
            <button
              class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-title"
              :title="showKey ? '隐藏' : '显示'"
              @click="showKey = !showKey"
            >
              <component :is="showKey ? EyeOff : Eye" :size="15" />
            </button>
          </div>
        </div>

        <div class="mb-4">
          <label class="mb-1.5 block text-sm text-text">推理强度</label>
          <select v-model="form.reasoningEffort" :class="INPUT_CLASS">
            <option v-for="e in EFFORTS" :key="e.value" :value="e.value">{{ e.label }}</option>
          </select>
          <p class="mt-1.5 text-xs leading-relaxed text-muted">
            关掉思考最快（模型只输出交换/轮转这类操作，机械活儿由程序执行）；涉及「谁不能跟谁同桌」这类
            多约束要求时，开着思考更稳。
          </p>
        </div>

        <div
          v-if="testResult"
          class="mb-4 rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap"
          :class="testResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'"
        >
          {{ testResult.ok ? "✓ " : "✗ " }}{{ testResult.text }}
        </div>

        <div class="flex gap-3">
          <button :class="BTN_CLASS" :disabled="testing || !canTest" @click="testConnection">
            <LoaderCircle v-if="testing" :size="14" class="animate-spin" />
            <Plug v-else :size="14" />
            测试连接
          </button>
          <button
            class="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            <LoaderCircle v-if="saving" :size="14" class="animate-spin" />
            <Save v-else :size="14" />
            保存配置
          </button>
        </div>

        <p v-if="configPath" class="mt-4 text-xs break-all text-muted">配置来源：{{ configPath }}</p>
      </template>
    </div>
  </div>
</template>
