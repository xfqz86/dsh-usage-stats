/**
 * 更新说明弹窗（UpdateNotesModal）：叠在用量统计面板上的二级模态窗，
 * 头部标题 + 版本元信息 + Release 说明（Markdown）+ 底部操作栏。
 *
 * 用 headless Modal 自建 chrome：基座 Modal 自带层级栈，叠在面板之上时 Esc 与焦点
 * 只归这一层；升级进行中关闭入口全部失效（关闭按钮隐藏、遮罩与 Esc 走 no-op），
 * 成功展示「重启 DSH 后生效」，失败按 UpgradeFailureReason 本地化原因，只有再点一次
 * 可能成功的原因才给「重试」（不支持/本地安装只给关闭）。升级说明始终保留，进行中/
 * 完成/失败的状态条追加在说明下方、底栏之上，不替换正文。
 * 说明正文用基座 MarkdownText 渲染，取不到正文时给兜底文案与 GitHub 发布页链接。
 */

import {
  IconCheckCircleOutlineRegular,
  IconCloseOutlineRegular,
  IconDownloadOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconWarningTriangleOutlineRegular,
  MarkdownText,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useMemo } from 'react';

import { dateKeyOf } from '../../utils.ts';
import { PLUGIN_VERSION } from '../version.ts';

import css from './UpdateNotesModal.module.css';

import type { UpgradeFailureReason } from '../../types.ts';
import type { UsageStatsKey } from '../locales.ts';
import type { UpdateInfo } from '../useUpdateCheck.ts';
import type { UpgradeState } from '../useUpgrade.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 升级失败原因 → 文案键；协议新增原因时在这里补一条。 */
const REASON_KEYS: Record<UpgradeFailureReason, UsageStatsKey> = {
  busy: 'update.reason.busy',
  'link-install': 'update.reason.linkInstall',
  unsupported: 'update.reason.unsupported',
  timeout: 'update.reason.timeout',
  network: 'update.reason.network',
  failed: 'update.reason.failed',
};

/** 再点一次也不会成功的原因：不给「重试」，只留关闭。 */
const FATAL_REASONS: ReadonlySet<UpgradeFailureReason> = new Set(['unsupported', 'link-install']);

export interface UpdateNotesModalProps extends PropsLocale<'dsh-usage-stats'> {
  /** 是否显示。 */
  open: boolean
  /** 检查更新成功结果：版本号、更新说明页、Release 正文与发布时间、安装方式。 */
  info: UpdateInfo
  /** 当前升级状态。 */
  upgrade: UpgradeState
  /** 发起升级，安装 info.latest。 */
  onUpgrade: () => void
  /** 关闭弹窗；升级进行中调用会被忽略。 */
  onClose: () => void
}

/**
 * 更新说明弹窗：说明正文与升级四态共用同一壳层，底栏随状态切换。
 * @param props.open - 是否显示。
 * @param props.info - 检查更新结果。
 * @param props.upgrade - 升级状态。
 * @param props.onUpgrade - 立即升级/重试入口。
 * @param props.onClose - 稍后/完成/关闭入口。
 * @param props.t - 命名空间文案函数。
 */
export function UpdateNotesModal({ open, info, upgrade, onUpgrade, onClose, t }: UpdateNotesModalProps) {
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('markdown.copy'),
      copiedLabel: t('markdown.copied'),
      toolbarLabels: {
        codeLabel: t('markdown.code'),
        wrapLabel: t('markdown.wrap'),
        unwrapLabel: t('markdown.unwrap'),
      },
    },
    footnotes: t('markdown.footnotes'),
  }), [t]);

  const upgrading = upgrade.status === 'upgrading';
  // 成功时标题切成「升级完成」，其余状态保持「发现新版本」；升级失败由正文标题承担。
  const headline = t(upgrade.status === 'success' ? 'update.successHeader' : 'update.title');
  // 正文可能只是一串空白，按没有说明处理，落到兜底文案。
  const notes = info.notes !== null && info.notes.trim() !== '' ? info.notes : null;

  /** 升级进行中屏蔽所有关闭入口（关闭按钮此时不渲染，遮罩与 Esc 也走这里）。 */
  function requestClose(): void {
    if (upgrading) return;
    onClose();
  }

  /**
   * 升级状态条：进行中 / 完成 / 失败共用一条，贴在说明下方、底栏之上；
   * 说明正文始终保留，升级不会把它替换掉。
   */
  function renderStatus() {
    if (upgrade.status === 'upgrading') {
      return (
        <>
          <div className={css.stateRow}>
            <IconLoadingOutlineRegular size={15} className={css.spin} />
            <span className={css.lead}>{t('update.upgradingDesc', { version: upgrade.version })}</span>
          </div>
          <div className={css.progress} role="progressbar" aria-label={t('update.upgradingProgress')}>
            <span className={css.bar} />
          </div>
          <p className={css.stateDesc}>{t('update.upgradingHint')}</p>
        </>
      );
    }
    if (upgrade.status === 'success') {
      return (
        <>
          <div className={css.stateRow}>
            <span className={`${css.stateIcon} ${css.stateIconOk}`} aria-hidden="true">
              <IconCheckCircleOutlineRegular size={16} />
            </span>
            <span className={css.stateTitle}>{t('update.successTitle', { version: upgrade.version })}</span>
          </div>
          <p className={css.stateDesc}>{t('update.successDesc')}</p>
        </>
      );
    }
    if (upgrade.status === 'error') {
      return (
        <>
          <div className={css.stateRow}>
            <span className={`${css.stateIcon} ${css.stateIconBad}`} aria-hidden="true">
              <IconWarningTriangleOutlineRegular size={15} />
            </span>
            <span className={css.stateTitle}>{t('update.errorTitle')}</span>
          </div>
          <p className={css.stateDesc}>{t(REASON_KEYS[upgrade.reason])}</p>
        </>
      );
    }
    return null;
  }

  /** 正文：说明区常驻，升级状态条只在升级中/完成/失败时追加在下方。 */
  function renderBody() {
    return (
      <>
        <div className={css.notesScroll}>
          {notes !== null ? (
            <div className={css.notes}>
              <MarkdownText text={notes} labels={labels} variant="compact" />
            </div>
          ) : (
            <div className={css.fallback}>
              <p className={css.fallbackText}>{t('update.notesFallback')}</p>
            </div>
          )}
        </div>
        {upgrade.status !== 'idle' && <div className={css.status}>{renderStatus()}</div>}
      </>
    );
  }

  /** 底栏：升级中置灰、成功只留「完成」、非 npm 安装以提示替代升级按钮、失败按原因给「重试」或「关闭」。 */
  function renderFooter() {
    const fullNotes = (
      <a className={css.full} href={info.url} target="_blank" rel="noopener noreferrer">
        <span>{t('update.viewFull')}</span>
        <IconRightUpOutlineRegular size={10} />
      </a>
    );
    if (upgrade.status === 'upgrading') {
      return (
        <footer className={css.foot}>
          {fullNotes}
          <button type="button" className={css.ghost} disabled>{t('update.later')}</button>
          <button type="button" className={css.primary} disabled>
            <IconLoadingOutlineRegular size={14} className={css.spin} />
            <span>{t('update.upgrading')}</span>
          </button>
        </footer>
      );
    }
    if (upgrade.status === 'success') {
      return (
        <footer className={css.foot}>
          {fullNotes}
          <button type="button" className={css.primary} onClick={onClose}>{t('update.done')}</button>
        </footer>
      );
    }
    // 非 npm 安装（本地链接 / 桌面端 / 拿不到 profile）不能从 registry 升级：
    // 弹窗只提示手动更新，绝不把链接或不可写来源依赖替换成 npm 包。
    if (info.install !== 'npm') {
      return (
        <footer className={css.foot}>
          {fullNotes}
          <span className={css.localHint}>
            {t(info.install === 'local' ? 'update.localHint' : 'update.unknownHint')}
          </span>
          <button type="button" className={css.ghost} onClick={requestClose}>{t('update.later')}</button>
        </footer>
      );
    }
    if (upgrade.status === 'error') {
      // 不支持/本地安装再点一次结果不会变，只给关闭，不给必败的重试。
      return (
        <footer className={css.foot}>
          {fullNotes}
          {FATAL_REASONS.has(upgrade.reason) ? (
            <button type="button" className={css.primary} onClick={onClose}>{t('update.dismiss')}</button>
          ) : (
            <button type="button" className={css.primary} onClick={onUpgrade}>
              <IconRefreshOutlineRegular size={14} />
              <span>{t('update.retry')}</span>
            </button>
          )}
        </footer>
      );
    }
    return (
      <footer className={css.foot}>
        {fullNotes}
        <button type="button" className={css.ghost} onClick={requestClose}>{t('update.later')}</button>
        <button type="button" className={css.primary} onClick={onUpgrade}>
          <IconDownloadOutlineRegular size={14} />
          <span>{t('update.upgradeNow')}</span>
        </button>
      </footer>
    );
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={headline}
      headless
      className={css.modal}
    >
      <header className={css.head}>
        <span className={css.title}>
          {headline}
          <span className={css.tag}>v{info.latest}</span>
        </span>
        {!upgrading && (
          <button
            type="button"
            className={css.close}
            onClick={onClose}
            aria-label={t('update.close')}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        )}
      </header>

      <div className={css.meta}>
        <span className={css.v}>v{PLUGIN_VERSION}</span>
        <svg className={css.metaArrow} viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
        <span className={css.vNew}>v{info.latest}</span>
        {info.publishedAt !== null && (
          <span className={css.date}>{t('update.publishedAt', { date: dateKeyOf(info.publishedAt) })}</span>
        )}
      </div>

      <div className={css.body}>{renderBody()}</div>

      {renderFooter()}
    </Modal>
  );
}
