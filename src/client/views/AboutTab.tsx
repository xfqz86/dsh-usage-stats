/**
 * 「关于」Tab：品牌区、数据与隐私、外链入口、统计口径条与构建信息。
 *
 * 版本号旁的检查更新控件按 idle/checking/latest/ahead/error/update 六态展示，更新态同时
 * 驱动本页 CTA 与面板 Tab 栏蓝点；本视图不接收用量快照，数据不可用时也能打开。
 * 更新态的 chip 与 CTA 都打开更新说明弹窗（二级 Modal），升级状态在弹窗内闭环。
 */

import {
  IconApiOutlineRegular,
  IconCheckCircleOutlineRegular,
  IconDatabaseOutlineRegular,
  IconDownloadOutlineRegular,
  IconInfoOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconShieldOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useState } from 'react';

import { useUpgrade } from '../useUpgrade.ts';
import { PLUGIN_VERSION } from '../version.ts';

import css from './AboutTab.module.css';
import { UpdateNotesModal } from './UpdateNotesModal.tsx';

import type { UsageStatsKey } from '../locales.ts';
import type { UpdateCheckState } from '../useUpdateCheck.ts';
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ComponentType } from 'react';

/** 仓库主页：非更新态的主 CTA 与链接入口的基址。 */
const REPOSITORY_URL = 'https://github.com/xfqz86/dsh-usage-stats';
/** 包名，与 package.json 的 name 一致。 */
const PACKAGE_NAME = '@xfqz86/dsh-usage-stats';
/** 统计口径详情：仓库内的权威文档。 */
const COUNTING_RULES_URL = `${REPOSITORY_URL}/blob/main/docs/ARCHITECTURE.md`;

/** 数据与隐私卡片中的一行：图标 + 本地化标题/说明。 */
interface InfoRow {
  Icon: ComponentType<IconProps>
  titleKey: UsageStatsKey
  descKey: UsageStatsKey
}

/** 数据与隐私四行，顺序与设计稿一致。 */
const PRIVACY_ROWS: InfoRow[] = [
  { Icon: IconDatabaseOutlineRegular, titleKey: 'about.privacyLocalTitle', descKey: 'about.privacyLocalDesc' },
  { Icon: IconCheckCircleOutlineRegular, titleKey: 'about.privacyUploadTitle', descKey: 'about.privacyUploadDesc' },
  { Icon: IconApiOutlineRegular, titleKey: 'about.privacyQuotaTitle', descKey: 'about.privacyQuotaDesc' },
  { Icon: IconRefreshOutlineRegular, titleKey: 'about.privacyRebuildTitle', descKey: 'about.privacyRebuildDesc' },
];

/** 外链入口：目标地址 + 本地化标题/说明。 */
interface LinkRow {
  href: string
  labelKey: UsageStatsKey
  descKey: UsageStatsKey
}

/** 链接卡片四行，顺序与设计稿一致。 */
const LINK_ROWS: LinkRow[] = [
  { href: `https://www.npmjs.com/package/${PACKAGE_NAME}`, labelKey: 'about.linkNpm', descKey: 'about.linkNpmDesc' },
  { href: `${REPOSITORY_URL}/releases`, labelKey: 'about.linkChangelog', descKey: 'about.linkChangelogDesc' },
  { href: `${REPOSITORY_URL}/issues`, labelKey: 'about.linkIssues', descKey: 'about.linkIssuesDesc' },
  { href: `${REPOSITORY_URL}#readme`, labelKey: 'about.linkDocs', descKey: 'about.linkDocsDesc' },
];

export interface AboutTabProps extends PropsLocale<'dsh-usage-stats'> {
  /** 检查更新状态，由面板里的 useUpdateCheck 维护。 */
  update: UpdateCheckState
  /** 手动检查更新，带 force 绕过服务端缓存。 */
  onCheck: () => void
}

/**
 * 「关于」页内容；外部链接一律新标签页打开并切断 opener。
 * @param props.update - 检查更新状态。
 * @param props.onCheck - 手动触发一次强制检查。
 * @param props.t - 命名空间文案函数。
 * @returns 关于页与更新说明弹窗；弹窗关闭后更新提示仍保留。
 */
export function AboutTab({ update, onCheck, t }: AboutTabProps) {
  // 更新说明弹窗与升级状态：关闭弹窗后更新提示保留，重新点开仍从说明正文开始。
  const [notesOpen, setNotesOpen] = useState(false);
  const { state: upgradeState, upgrade, reset: resetUpgrade } = useUpgrade();
  // 只有 update 态才有可展示的新版本与安装方式；latest 态不提供「查看更新」。
  const updateInfo = update.status === 'update' ? update : null;

  /** 打开更新说明弹窗。 */
  function openNotes(): void {
    if (updateInfo === null) return;
    setNotesOpen(true);
  }

  /** 关闭弹窗并清空升级状态；升级进行中不响应（弹窗自身也会屏蔽关闭入口）。 */
  function closeNotes(): void {
    if (upgradeState.status === 'upgrading') return;
    setNotesOpen(false);
    resetUpgrade();
  }

  /** 立即升级当前提示的新版本。 */
  function startUpgrade(): void {
    if (updateInfo === null) return;
    upgrade(updateInfo.latest);
  }

  /** 检查更新控件的六态渲染：更新态是可点按钮，其余状态是按钮或进行中提示。 */
  function renderUpdateControl() {
    if (update.status === 'checking') {
      return (
        <span className={`${css.check} ${css.checkBusy}`} aria-live="polite">
          <IconRefreshOutlineRegular size={12} className={css.spin} />
          <span>{t('about.checking')}</span>
        </span>
      );
    }
    if (update.status === 'update') {
      return (
        <button
          type="button"
          className={css.updateChip}
          onClick={openNotes}
          title={t('about.updateHint')}
        >
          <IconDownloadOutlineRegular size={11} />
          <span>{t('about.updateAvailable', { version: update.latest })}</span>
        </button>
      );
    }
    if (update.status === 'latest') {
      return (
        <button type="button" className={`${css.check} ${css.checkDone}`} onClick={onCheck}>
          <IconCheckCircleOutlineRegular size={12} className={css.checkDoneIcon} />
          <span>{t('about.latest')}</span>
        </button>
      );
    }
    if (update.status === 'ahead') {
      return (
        <button
          type="button"
          className={css.check}
          onClick={onCheck}
          title={t('about.aheadHint', { latest: update.latest, current: PLUGIN_VERSION })}
        >
          <IconInfoOutlineRegular size={12} />
          <span>{t('about.ahead')}</span>
        </button>
      );
    }
    if (update.status === 'error') {
      return (
        <button type="button" className={`${css.check} ${css.checkFailed}`} onClick={onCheck}>
          <IconWarningTriangleOutlineRegular size={12} className={css.checkFailedIcon} />
          <span>{t('about.checkFailed')}</span>
        </button>
      );
    }
    return (
      <button type="button" className={css.check} onClick={onCheck}>
        <IconRefreshOutlineRegular size={12} />
        <span>{t('about.check')}</span>
      </button>
    );
  }

  return (
    <div className={css.root}>
      <section className={css.hero}>
        <div className={css.logo} aria-hidden="true">
          <svg viewBox="0 0 28 28" width="28" height="28" fill="none">
            <rect x="4" y="15" width="5" height="9" rx="1.8" fill="currentColor" opacity=".55" />
            <rect x="11.5" y="10" width="5" height="14" rx="1.8" fill="currentColor" opacity=".8" />
            <rect x="19" y="5" width="5" height="19" rx="1.8" fill="currentColor" />
          </svg>
        </div>
        <div className={css.heroMain}>
          <div className={css.nameRow}>
            <h1 className={css.name}>{t('panel.title')}</h1>
            <span className={css.version}>v{PLUGIN_VERSION}</span>
            {renderUpdateControl()}
          </div>
          <div className={css.pkg}>{PACKAGE_NAME}</div>
          <p className={css.tagline}>{t('about.tagline')}</p>
        </div>
        <div className={css.heroActions}>
          {updateInfo !== null ? (
            <button
              type="button"
              className={`${css.heroBtn} ${css.heroBtnUpdate}`}
              onClick={openNotes}
              title={t('about.updateHint')}
            >
              <span>{t('about.ctaUpdate')}</span>
              <IconRightUpOutlineRegular size={12} />
            </button>
          ) : (
            <a
              className={css.heroBtn}
              href={REPOSITORY_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{t('about.ctaGithub')}</span>
              <IconRightUpOutlineRegular size={12} />
            </a>
          )}
        </div>
      </section>

      <div className={css.grid}>
        <section className={css.card}>
          <div className={css.cardHead}>
            <span className={css.cardIcon}>
              <IconShieldOutlineRegular size={13} />
            </span>
            <span className={css.cardTitle}>{t('about.privacyTitle')}</span>
            <span className={css.cardExtra}>
              <span className={css.privacyDot} aria-hidden="true" />
              {t('about.privacyBadge')}
            </span>
          </div>
          <div className={css.rows}>
            {PRIVACY_ROWS.map(({ Icon, titleKey, descKey }) => (
              <div className={css.infoRow} key={titleKey}>
                <span className={css.rowIcon}>
                  <Icon size={15} />
                </span>
                <div className={css.rowBody}>
                  <div className={css.rowTitle}>{t(titleKey)}</div>
                  <div className={css.rowDesc}>{t(descKey)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className={css.card}>
          <div className={css.cardHead}>
            <span className={css.cardIcon}>
              <IconLinkOutlineRegular size={13} />
            </span>
            <span className={css.cardTitle}>{t('about.linksTitle')}</span>
            <span className={css.cardExtra}>{t('about.linksCount', { n: LINK_ROWS.length })}</span>
          </div>
          <div className={css.links}>
            {LINK_ROWS.map(({ href, labelKey, descKey }) => (
              <a
                className={css.linkRow}
                key={labelKey}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={css.linkMain}>
                  <span className={css.linkLabel}>{t(labelKey)}</span>
                  <span className={css.linkDesc}>{t(descKey)}</span>
                </span>
                <span className={css.linkArrow}>
                  <IconRightUpOutlineRegular size={12} />
                </span>
              </a>
            ))}
          </div>
        </section>
      </div>

      <div className={css.note}>
        <IconInfoOutlineRegular size={14} className={css.noteIcon} />
        <div className={css.noteText}>
          <b className={css.noteTitle}>{t('about.noteTitle')}</b>
          <span>{t('about.noteDesc')}</span>
        </div>
        <a
          className={css.noteLink}
          href={COUNTING_RULES_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>{t('about.noteDetail')}</span>
          <IconRightUpOutlineRegular size={10} />
        </a>
      </div>

      <footer className={css.footer}>
        <span>{t('about.footerLicense')}</span>
        <span className={css.sep} aria-hidden="true">·</span>
        <span>{t('about.footerCopyright', { year: new Date().getFullYear() })}</span>
        <span className={css.sep} aria-hidden="true">·</span>
        <span>{t('about.footerBuiltWith')}</span>
      </footer>

      {updateInfo !== null && (
        <UpdateNotesModal
          open={notesOpen}
          info={updateInfo}
          upgrade={upgradeState}
          onUpgrade={startUpgrade}
          onClose={closeNotes}
          t={t}
        />
      )}
    </div>
  );
}
