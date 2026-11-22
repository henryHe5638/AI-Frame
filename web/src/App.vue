<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const isFrame = computed(() => route.path === "/frame");
const isLogin = computed(() => route.path === "/login");

/* ---------------- 亮 / 暗主题 ---------------- */

const THEME_KEY = "app.theme";

function initialTheme(): "dark" | "light" {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const theme = ref<"dark" | "light">(initialTheme());
document.documentElement.dataset.theme = theme.value;

function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem(THEME_KEY, theme.value);
}
</script>

<template>
  <div class="layout">
    <nav v-if="!isFrame && !isLogin" class="topnav">
      <span class="brand">AI 艺术相框</span>
      <div class="links">
        <router-link to="/" :class="{ active: route.path === '/' }">照片墙</router-link>
        <router-link to="/queue" :class="{ active: route.path === '/queue' }">队列</router-link>
        <router-link to="/frame" :class="{ active: route.path === '/frame' }">轮播</router-link>
        <router-link to="/settings" :class="{ active: route.path === '/settings' }">设置</router-link>
      </div>
      <button
        class="theme-toggle"
        :title="theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.4 14.2A8.5 8.5 0 0 1 9.8 3.6a8.5 8.5 0 1 0 10.6 10.6Z" />
        </svg>
      </button>
    </nav>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.layout {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.topnav {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 24px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: var(--nav-bg);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand {
  font-weight: 700;
  color: var(--accent);
  margin-right: 8px;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.links {
  display: flex;
  align-items: center;
  gap: 20px;
  overflow-x: auto;
  scrollbar-width: none;
}
.links::-webkit-scrollbar {
  display: none;
}
.topnav a {
  color: var(--text-dim);
  padding: 4px 2px;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.topnav a.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.theme-toggle {
  margin-left: auto;
  padding: 6px 8px;
  line-height: 0;
  border-radius: 999px;
  flex: none;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
}
@media (max-width: 800px) {
  .topnav {
    padding: 0 12px;
    gap: 12px;
    height: 46px;
  }
  .brand {
    margin-right: 0;
    font-size: 13px;
  }
  .links {
    gap: 14px;
  }
}
</style>
