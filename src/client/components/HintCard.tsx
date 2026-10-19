/**
 * 状态提示卡：图标徽标 + 状态标题 + 可选说明、凭据名与操作，概览磁贴、侧边栏 tooltip
 * 与各报错区共用，所有非正常态走同一版式，不再各处手写纯文本提示。
 *
 * 变体按状态语义选图标与色调：未配置凭据（盾牌、中性）、未开通订阅（星标、品牌色）、
 * 暂无数据（信息、中性）、查询失败（告警、错误色）、设置告警（感叹、警告色）。
 * `tone` 决定底色：磁贴内为浅底，深色 tooltip 内为半透明白。
 */

import {
  IconInfoOutlineRegular,
  IconShieldOutlineRegular,
  IconSparkleRegular,
  IconWarningOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

import css from './HintCard.module.css';

import type { ReactNode } from 'react';

/** 状态语义：决定默认图标与色调。 */
export type HintVariant = 'unset' | 'plan' | 'empty' | 'error' | 'warn';

/** 变体 → 图标组件；颜色由 CSS 按变体写进容器 currentColor。 */
const ICONS: Record<HintVariant, typeof IconInfoOutlineRegular> = {
  unset: IconShieldOutlineRegular,
  plan: IconSparkleRegular,
  empty: IconInfoOutlineRegular,
  error: IconWarningTriangleOutlineRegular,
  warn: IconWarningOutlineRegular,
};

/** 状态提示卡：图标 + 状态标题 + 可选说明、凭据名与操作，tile / tip 两种底色共用同一版式。 */
export function HintCard({
  variant,
  title,
  detail,
  keys,
  tone = 'tile',
  action,
  role,
}: {
  /** 状态语义，决定图标与色调。 */
  variant: HintVariant
  /** 一句话状态标题，窄磁贴内允许折行。 */
  title: string
  /** 可选第二行说明，如「在 DSH 凭据中心设置」。 */
  detail?: string
  /** 可选凭据名清单，逐个渲染成等宽 chip，供用户照着去 DSH 凭据中心配置。 */
  keys?: readonly string[]
  /** 容器底色：tile 为磁贴浅底，tip 为深色 tooltip 底。 */
  tone?: 'tile' | 'tip'
  /** 可选操作（如「重试」按钮），渲染在正文下方。 */
  action?: ReactNode
  /** 语义角色：错误用 alert，后台状态可用 status；普通展示省略。 */
  role?: 'alert' | 'status'
}) {
  const Icon = ICONS[variant];
  const cls = [css.root, tone === 'tip' ? css.tip : '', css[variant]].filter(Boolean).join(' ');
  return (
    <div className={cls} role={role}>
      <span className={css.icon} aria-hidden="true"><Icon size={14} /></span>
      <span className={css.head}>
        <span className={css.title}>{title}</span>
        {detail !== undefined && <span className={css.detail}>{detail}</span>}
      </span>
      {/* 凭据名与操作吃满卡片宽度（不缩在图标右侧的窄列里），窄磁贴下长键名也不会顶出卡片。 */}
      {keys !== undefined && keys.length > 0 && (
        <span className={css.keys}>
          {keys.map((key) => <code className={css.key} key={key}>{key}</code>)}
        </span>
      )}
      {action !== undefined && <span className={css.action}>{action}</span>}
    </div>
  );
}
