<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { useOpsStore } from '../store';
import { buildWelcomeSuggestions } from '../store-helpers';

const store = useOpsStore();

const RISK_LABEL: Record<'read' | 'write' | 'exec', string> = {
  read: '只读',
  write: '写',
  exec: '执行'
};

/** Cline 式空态：标题 + 副标题 + 4–8 张 playbook 建议卡（点即 startPlaybook）。 */
const suggestions = computed(() => buildWelcomeSuggestions(store.playbooks, 6));
</script>

<template>
  <div class="welcome">
    <div class="welcome__inner">
      <h2 class="welcome__title">{{ t('welcomeTitle') }}</h2>
      <p class="welcome__subtitle ops-muted">{{ t('welcomeSubtitle') }}</p>
      <div class="welcome__grid" role="list" :aria-label="t('welcomeSuggestions')">
        <button
          v-for="pb in suggestions"
          :key="pb.id"
          type="button"
          role="listitem"
          class="welcome__card"
          @click="store.startPlaybook(pb.id)"
        >
          <span class="welcome__card-head">
            <span class="welcome__card-title">{{ pb.title }}</span>
            <span class="ops-badge welcome__card-risk" :class="'ops-risk-' + pb.maxRisk">
              {{ RISK_LABEL[pb.maxRisk] }}
            </span>
          </span>
          <span v-if="pb.description" class="welcome__card-desc ops-muted">{{ pb.description }}</span>
        </button>
      </div>
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
  padding: calc(var(--ops-density) * 4) calc(var(--ops-density) * 2);
}

.welcome__inner {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: var(--ops-density);
}

.welcome__title {
  margin: 0;
  font-size: calc(var(--ops-font-size) + 3px);
  font-weight: 600;
}

.welcome__subtitle {
  margin: 0 0 var(--ops-density);
  line-height: 1.5;
}

.welcome__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ops-density);
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
  padding: calc(var(--ops-density) + 2px) calc(var(--ops-density) * 2);
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

.welcome__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ops-density);
  min-width: 0;
}

.welcome__card-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome__card-risk {
  flex: 0 0 auto;
}

.welcome__card-desc {
  font-size: calc(var(--ops-font-size) - 2px);
  line-height: 1.45;
}
</style>
