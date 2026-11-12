/**
 * 会话阶段判定：状态行图标和详情卡状态文案共用这一套口径。
 *
 * 只看 durable 事件与 `binding.session` 的 running，不读 Chat 节点，历史会话回放时也能复现
 * 最后一次的阶段。compacted 只在压缩结束后还没有新请求或步骤时成立，所以除 compactionOpen
 * 之外还要记一个一次性标记。
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

/** 会话阶段。 */
export type SessionPhase = 'generating' | 'tools' | 'compacting' | 'compacted' | 'idle';

/** 增量阶段判定器：窗口回放与实时追加共用。 */
export class PhaseTracker {
  private readonly openTools = new Set<string>();
  private compactionOpen = false;
  private compactionJustEnded = false;

  /** 清空状态（窗口替换时整体重放）。 */
  reset(): void {
    this.openTools.clear();
    this.compactionOpen = false;
    this.compactionJustEnded = false;
  }

  /** 记录一条 durable 事件。 */
  apply(event: SessionEvent): void {
    // compaction/* 不在本插件依赖的事件类型表里，按字符串判断。
    const type: string = event.type;
    if (type === 'compaction/start') {
      this.compactionOpen = true;
      this.compactionJustEnded = false;
      return;
    }
    if (type === 'compaction/end') {
      this.compactionOpen = false;
      this.compactionJustEnded = true;
      return;
    }
    if (event.type === 'tool/call') {
      this.openTools.add(String(event.data.callId));
      this.compactionJustEnded = false;
      return;
    }
    if (event.type === 'tool/result') {
      this.openTools.delete(String(event.data.message.toolCallId));
      this.compactionJustEnded = false;
      return;
    }
    if (
      event.type === 'user/message'
      || event.type === 'step/start'
      || event.type === 'assistant/message'
      || event.type === 'turn/start'
    ) {
      this.compactionJustEnded = false;
    }
  }

  /**
   * 当前阶段。
   * @param running - 会话是否在运行（`binding.session` 的 running）。
   */
  phase(running: boolean): SessionPhase {
    if (this.compactionOpen) return running ? 'compacting' : 'idle';
    if (this.compactionJustEnded) return 'compacted';
    if (!running) return 'idle';
    if (this.openTools.size > 0) return 'tools';
    return 'generating';
  }
}
