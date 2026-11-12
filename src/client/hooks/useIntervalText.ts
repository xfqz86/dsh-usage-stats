/**
 * 抓取间隔输入 hook（浏览器端）。
 *
 * 三额度同一写法：本地文本态随打随改，失焦/回车时夹取提交并回写规范值，
 * 避免每键回跳；input ref 收归内部，调用方只需展开 field。
 * 设置作用域异步落定：服务端取值到达时，未被用户改动过的输入框跟随
 * 服务端取值，避免首屏默认值在失焦时被误提交回写。
 */
import { useEffect, useRef, useState } from 'react';

/** 间隔输入手柄：field 直接展开到 <input> 上。 */
export function useIntervalText(
  initial: number,
  clamp: (v: number) => number,
  onCommit: (minutes: number) => void,
): {
    field: {
      ref: React.RefObject<HTMLInputElement>
      value: string
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
      onBlur: () => void
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
    }
  } {
  const [text, setText] = useState(String(clamp(initial)));
  const inputRef = useRef<HTMLInputElement>(null);
  /** 上一次同步进文本态的服务端取值：内容没变不重复写，避免打断输入。 */
  const synced = useRef(String(clamp(initial)));

  useEffect(() => {
    const next = String(clamp(initial));
    if (next === synced.current) return;
    const prevSynced = synced.current;
    synced.current = next;
    // 仅当文本还停在服务端旧值（用户没动过）时跟随；编辑中的草稿不打断
    setText((prev) => (prev === prevSynced ? next : prev));
  }, [clamp, initial]);

  const commit = () => {
    const minutes = clamp(Number(text));
    setText(String(minutes));
    synced.current = String(minutes);
    onCommit(minutes);
  };
  return {
    field: {
      ref: inputRef,
      value: text,
      onChange: (e) => setText(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      },
    },
  };
}
