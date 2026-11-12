/**
 * 详情卡小图表的纯几何计算：每次调用一根 ATPS 柱 + TTFT 折线，两套纵轴各自缩放。
 *
 * 只输出数字与 SVG 点串，不依赖 React，便于单测；组件只负责画。
 */

import type { SpeedSample } from './stats.ts';

/** 一根 ATPS 柱。 */
export interface ChartBar {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 一次调用的整列命中区（透明矩形，便于鼠标悬停到细柱）。 */
export interface ChartHit {
  x: number;
  width: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 一个 TTFT 折线点。 */
export interface ChartDot {
  cx: number;
  cy: number;
  /** 对应样本下标（从 0 开始）。 */
  sample: number;
}

/** 图表几何结果。 */
export interface ChartGeometry {
  bars: readonly ChartBar[];
  /** 连续有效 TTFT 点组成的折线段（点为 `x,y`）。 */
  segments: readonly string[];
  dots: readonly ChartDot[];
  /** 每个样本一列透明命中区。 */
  hits: readonly ChartHit[];
  /** 横轴基线 y。 */
  baseline: number;
  /** 中间参考线 y。 */
  midline: number;
}

/** 图表内边距：左右贴边，顶部留一点给圆点，底部留基线空间。 */
const PAD_X = 2;
const PAD_TOP = 7;
const PAD_BOTTOM = 5;

/**
 * 计算柱与折线的坐标。
 * @param samples - 全部调用样本，顺序即横轴。
 * @param width - SVG 视图宽度。
 * @param height - SVG 视图高度。
 * @returns 柱、折线段与圆点。
 */
export function buildChartGeometry(
  samples: readonly SpeedSample[],
  width: number,
  height: number,
): ChartGeometry {
  const plotHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
  if (samples.length === 0 || width <= 0 || height <= 0) {
    return { bars: [], segments: [], dots: [], hits: [], baseline: 0, midline: 0 };
  }
  const baseline = PAD_TOP + plotHeight;
  const slot = (width - PAD_X * 2) / samples.length;
  const barWidth = Math.min(14, Math.max(2, slot * 0.54));

  const hits: ChartHit[] = samples.map((_, index) => ({ x: PAD_X + slot * index, width: slot, sample: index }));
  const maxTtft = Math.max(1, ...samples.map((sample) => sample.ttftMs ?? 0)) * 1.08;
  const maxAtps = Math.max(0.1, ...samples.map((sample) => sample.atps ?? 0)) * 1.08;

  const bars: ChartBar[] = [];
  const dots: ChartDot[] = [];
  const segments: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length >= 2) segments.push(run.join(' '));
    run = [];
  };

  samples.forEach((sample, index) => {
    const center = PAD_X + slot * (index + 0.5);
    if (sample.atps !== null) {
      const barHeight = Math.max(1, (sample.atps / maxAtps) * plotHeight);
      bars.push({
        x: Math.round((center - barWidth / 2) * 10) / 10,
        y: Math.round((baseline - barHeight) * 10) / 10,
        width: Math.round(barWidth * 10) / 10,
        height: Math.round(barHeight * 10) / 10,
        sample: index,
      });
    }
    if (sample.ttftMs !== null) {
      const y = Math.round((baseline - (sample.ttftMs / maxTtft) * plotHeight) * 10) / 10;
      dots.push({ cx: Math.round(center * 10) / 10, cy: y, sample: index });
      run.push(`${Math.round(center * 10) / 10},${y}`);
    } else {
      flush();
    }
  });
  flush();

  return { bars, segments, dots, hits, baseline, midline: PAD_TOP + plotHeight / 2 };
}
