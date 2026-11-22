import { createRouter, createWebHistory } from "vue-router";
import PhotosView from "./views/PhotosView.vue";
import SettingsView from "./views/SettingsView.vue";
import FrameView from "./views/FrameView.vue";
import QueueView from "./views/QueueView.vue";
import LoginView from "./views/LoginView.vue";
import { fetchAuthMe } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "photos", component: PhotosView },
    { path: "/queue", name: "queue", component: QueueView },
    { path: "/settings", name: "settings", component: SettingsView },
    { path: "/frame", name: "frame", component: FrameView },
    { path: "/login", name: "login", component: LoginView },
  ],
});

/** 开启鉴权后所有页面要求登录（登录页除外） */
router.beforeEach(async (to) => {
  if (to.name === "login") return true;
  try {
    const me = await fetchAuthMe();
    if (me.authRequired && !me.authed) return { name: "login" };
  } catch {
    // 服务不可达时不拦截，由页面自身报错
  }
  return true;
});
