<script setup lang="ts">
import { t } from '../i18n';
import { useSettingsStore } from '../store';

const store = useSettingsStore();
</script>

<template>
  <section>
    <h2 class="set-title">{{ t('skillsTitle') }}</h2>
    <p class="set-hint">{{ t('skillsHint') }}</p>

    <div v-if="store.skills.length === 0" class="set-empty">{{ t('skillsEmpty') }}</div>

    <ul v-else class="skills">
      <li v-for="skill in store.skills" :key="skill.name">
        <button type="button" class="skills__item" @click="store.openSkill(skill)">
          <span class="skills__name">{{ skill.name }}</span>
          <span v-if="skill.description" class="skills__desc">{{ skill.description }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.skills {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skills__item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  color: inherit;
  border: 1px solid var(--vscode-widget-border, var(--ops-border));
  border-radius: 6px;
  padding: 8px 10px;
}

.skills__item:hover {
  background: var(--ops-hover-bg);
}

.skills__item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, var(--ops-accent));
  outline-offset: -1px;
}

.skills__name {
  font-weight: 600;
}

.skills__desc {
  font-size: 12px;
  color: var(--ops-muted);
}
</style>
