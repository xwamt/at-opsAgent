<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { t } from '../i18n';

const props = defineProps<{
  title?: string;
  from?: string;
  to?: string;
  points?: number[];
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const hasData = computed(() => Array.isArray(props.points) && props.points.length >= 2);

function draw(): void {
  const canvas = canvasEl.value;
  if (!canvas) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(canvas.clientWidth || 120, 60);
  const cssHeight = Math.max(canvas.clientHeight || 24, 20);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) {
    return;
  }
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const stroke = getComputedStyle(canvas).color || '#888';

  if (!hasData.value) {
    // 无数据占位：中线虚线
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(2, cssHeight / 2);
    ctx.lineTo(cssWidth - 2, cssHeight / 2);
    ctx.stroke();
    return;
  }

  const points = props.points as number[];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const padY = 3;
  const stepX = (cssWidth - 4) / (points.length - 1);
  const toX = (i: number) => 2 + i * stepX;
  const toY = (v: number) => cssHeight - padY - ((v - min) / span) * (cssHeight - padY * 2);

  ctx.setLineDash([]);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = stroke;
  ctx.beginPath();
  ctx.moveTo(toX(0), cssHeight - 1);
  points.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(points.length - 1), cssHeight - 1);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  points.forEach((v, i) => {
    if (i === 0) {
      ctx.moveTo(toX(i), toY(v));
    } else {
      ctx.lineTo(toX(i), toY(v));
    }
  });
  ctx.stroke();
}

onMounted(draw);
watch(() => props.points, draw, { deep: true });
</script>

<template>
  <figure class="metric">
    <figcaption class="metric__caption">
      <span v-if="props.title" class="metric__title ops-mono">{{ props.title }}</span>
      <span v-if="props.from || props.to" class="ops-muted metric__window">
        {{ props.from ?? '?' }} → {{ props.to ?? '?' }}
      </span>
    </figcaption>
    <div class="metric__spark">
      <canvas ref="canvasEl" class="metric__canvas" role="img" :aria-label="t('metricAria')"></canvas>
      <span v-if="!hasData" class="metric__nodata ops-muted">{{ t('metricNoData') }}</span>
    </div>
  </figure>
</template>

<style scoped>
.metric {
  margin: 0;
  min-width: 0;
}

.metric__caption {
  display: flex;
  gap: calc(var(--ops-density) * 2);
  align-items: baseline;
  font-size: calc(var(--ops-font-size) - 2px);
  min-width: 0;
}

.metric__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.metric__window {
  white-space: nowrap;
}

.metric__spark {
  position: relative;
  margin-top: 2px;
}

.metric__canvas {
  display: block;
  width: 100%;
  height: 26px;
  color: var(--ops-accent);
}

.metric__nodata {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--ops-font-size) - 2px);
}
</style>
