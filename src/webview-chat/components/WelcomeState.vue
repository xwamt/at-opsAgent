<script setup lang="ts">
import { computed } from 'vue';
import { getLocale, t } from '../i18n';
import { useOpsStore } from '../store';
import { buildWelcomeSuggestions } from '../store-helpers';

const store = useOpsStore();

/** 未配置分支（P0-B）：!hasApiKey 或无模型清单 ⇒ 主 CTA 配置模型。 */
const needsSetup = computed(() => !store.configured);

/** Cline 式空态：标题 + 副标题 + 4–8 张 playbook 建议卡（点即 startPlaybook）。 */
const suggestions = computed(() => buildWelcomeSuggestions(store.playbooks, 6));

/** 最近会话回流入口（P1-8）：最多 3 条，排除当前会话。 */
const recentSessions = computed(() =>
  store.historySessions.filter((s) => s.id !== store.sessionId).slice(0, 3)
);

function riskLabel(risk: 'read' | 'write' | 'exec'): string {
  return t(risk === 'write' ? 'riskWrite' : risk === 'exec' ? 'riskExec' : 'riskRead');
}

function formatTime(createdAt: number): string {
  if (!createdAt) {
    return '';
  }
  return new Date(createdAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
</script>

<template>
  <div class="welcome">
    <div class="welcome__inner">
      <span class="codicon codicon-comment-discussion welcome__anchor" aria-hidden="true"></span>
      <h2 class="welcome__title">{{ t('welcomeTitle') }}</h2>
      <p class="welcome__subtitle ops-muted">{{ t('welcomeSubtitle') }}</p>

      <!-- 未配置主 CTA：settings/open 直达 Models（host 也接受 command:atOpsAgent.openModels 深链） -->
      <section v-if="needsSetup" class="welcome__setup" role="note">
        <div class="welcome__setup-head">
          <span class="codicon codicon-warning" aria-hidden="true"></span>
          <span class="welcome__setup-title">{{ t('welcomeSetupTitle') }}</span>
        </div>
        <p class="welcome__setup-body ops-muted">{{ t('welcomeSetupBody') }}</p>
        <button type="button" class="ops-btn welcome__setup-cta" @click="store.openSettings('models')">
          {{ t('welcomeSetupCta') }}
        </button>
      </section>

      <p class="welcome__section ops-muted">{{ t('welcomeSuggestions') }}</p>
      <div
        class="welcome__grid"
        :class="{ 'welcome__grid--secondary': needsSetup }"
        role="list"
        :aria-label="t('welcomeSuggestions')"
      >
        <button
          v-for="pb in suggestions"
          :key="pb.id"
          type="button"
          role="listitem"
          class="welcome__card"
          :title="pb.title + ' · ' + riskLabel(pb.maxRisk)"
          @click="store.startPlaybook(pb.id)"
        >
          <span class="welcome__card-title">{{ pb.title }}</span>
          <span v-if="pb.description" class="welcome__card-desc ops-muted">{{ pb.description }}</span>
        </button>
      </div>

      <!-- 最近会话（store.historySessions）：点击切换 -->
      <template v-if="recentSessions.length > 0">
        <p class="welcome__section ops-muted">{{ t('welcomeRecent') }}</p>
        <div class="welcome__recent" role="list" :aria-label="t('welcomeRecent')">
          <button
            v-for="session in recentSessions"
            :key="session.id"
            type="button"
            role="listitem"
            class="welcome__recent-item"
            :aria-label="t('historySwitchAria') + ' ' + session.title"
            @click="store.switchSession(session.id)"
          >
            <span class="codicon codicon-history" aria-hidden="true"></span>
            <span class="welcome__recent-title">{{ session.title }}</span>
            <span v-if="session.createdAt" class="welcome__recent-time ops-muted">{{ formatTime(session.createdAt) }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  padding: var(--ops-space-4) var(--ops-space-3);
}

.welcome__inner {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-1);
}

.welcome__anchor {
  font-size: 28px;
  color: var(--ops-accent);
  margin-bottom: var(--ops-space-1);
}

.welcome__title {
  margin: 0;
  font-size: calc(var(--ops-font-md) + 3px);
  font-weight: 600;
}

.welcome__subtitle {
  margin: 0 0 var(--ops-space-1);
  line-height: 1.5;
}

/* 未配置主 CTA 卡 */
.welcome__setup {
  border: 1px solid var(--ops-border);
  border-left: 3px solid var(--ops-warn);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
  margin-bottom: var(--ops-space-2);
}

.welcome__setup-head {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-2);
}

.welcome__setup-head .codicon {
  color: var(--ops-warn);
}

.welcome__setup-title {
  font-weight: 600;
}

.welcome__setup-body {
  margin: 0;
  line-height: 1.5;
  font-size: var(--ops-font-sm);
}

.welcome__setup-cta {
  align-self: flex-start;
}

.welcome__section {
  margin: var(--ops-space-2) 0 0;
  font-size: var(--ops-font-xs);
}

.welcome__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ops-space-1);
}

/* 未配置时 playbook 卡降级为次要（降饱和） */
.welcome__grid--secondary {
  opacity: 0.65;
}

.welcome__card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  text-align: left;
  background: transparent;
  border: 1px solid var(--ops-border);
  border-radius: var(--ops-radius);
  padding: var(--ops-space-2) var(--ops-space-3);
  color: var(--ops-fg);
  cursor: pointer;
  min-width: 0;
}

.welcome__card:hover,
.welcome__card:focus-visible {
  background: var(--ops-hover-bg);
  border-color: var(--ops-accent);
  outline: none;
}

.welcome__card:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.welcome__card-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome__card-desc {
  font-size: var(--ops-font-xs);
  line-height: 1.45;
}

.welcome__recent {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.welcome__recent-item {
  display: flex;
  align-items: baseline;
  gap: var(--ops-space-2);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--ops-radius);
  padding: var(--ops-space-1) var(--ops-space-2);
  color: var(--ops-fg);
  cursor: pointer;
  min-width: 0;
}

.welcome__recent-item:hover,
.welcome__recent-item:focus-visible {
  background: var(--ops-hover-bg);
  outline: none;
}

.welcome__recent-item:focus-visible {
  outline: 1px solid var(--ops-accent);
  outline-offset: -1px;
}

.welcome__recent-item .codicon {
  color: var(--ops-muted);
  font-size: var(--ops-font-sm);
  flex: 0 0 auto;
}

.welcome__recent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome__recent-time {
  flex: 0 0 auto;
  font-size: var(--ops-font-xs);
}
</style>
