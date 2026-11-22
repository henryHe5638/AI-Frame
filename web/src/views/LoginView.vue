<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { login } from "../api";

const router = useRouter();
const username = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

async function onSubmit(): Promise<void> {
  error.value = "";
  loading.value = true;
  try {
    await login(username.value.trim(), password.value);
    router.replace("/");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "登录失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <form class="card login-card" @submit.prevent="onSubmit">
      <h2>AI 艺术相框</h2>
      <label class="row col">
        <span>用户名</span>
        <input v-model="username" autocomplete="username" autofocus />
      </label>
      <label class="row col">
        <span>密码</span>
        <input v-model="password" type="password" autocomplete="current-password" />
      </label>
      <button class="primary big" type="submit" :disabled="loading || !username || !password">
        {{ loading ? "登录中…" : "登录" }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.login-view {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
}
.login-card {
  width: 100%;
  max-width: 360px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h2 {
  margin: 0;
  text-align: center;
  color: var(--accent);
}
.row.col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row.col span {
  color: var(--text-dim);
  font-size: 13px;
}
.big {
  padding: 9px 0;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  text-align: center;
}
</style>
