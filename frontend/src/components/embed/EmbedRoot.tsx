'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { installEmbedRuntime, applyEmbedTheme } from '@/lib/embed/runtime';
import {
  getEmbedSession,
  getEmbedSessionState,
  handleParentMessageEvent,
  postToParent,
  subscribeEmbedSession,
} from '@/lib/embed/session';
import { setStoragePartition } from '@/lib/embed/storage-partition';
import { bootstrapStudio, resetStudioState } from '@/lib/embed/studio-state';
import { clearAuthedImageCache } from '@/lib/embed/authed-image';
import { dismissEmbedNotice } from '@/lib/embed/notices';
import { getEmbedRegistry } from '@/lib/embed/registry-store';
import { EmbedNoticeHost } from '@/components/embed/EmbedNoticeHost';
import { subscribeShellRefresh } from '@/lib/embed/shell-refresh';

type Phase = 'waiting' | 'loading' | 'ready' | 'revoked' | 'not-embedded' | 'error';

const NOT_EMBEDDED_HINT_DELAY_MS = 1500;

function dismissBootLoader(): void {
  document.getElementById('app-boot-loader')?.remove();
}

/** 工作区「可用性」：Nova 的部分组件只在挂载时读取一次（如 Agent 的 hasApiKey），变化后需要重新挂载。 */
function availabilitySignature(): string {
  const registry = getEmbedRegistry();
  return `${registry.imageModels.length > 0 ? 1 : 0}${registry.textModels.length > 0 ? 1 : 0}`;
}

/**
 * 嵌入模式根组件（替代 page.tsx 里的 WorkspaceShell）：
 *   1. 安装存储分区 / 会话令牌 shim，向父页发 nova:ready；
 *   2. 收到会话前显示加载态；收到后按 userId 切换存储分区、读取 Key 并生成内存注册表；
 *   3. 之后才动态加载 Nova 工作区（保证 Nova 模块在分区确定后才读写本地存储）；
 *   4. userId 变化或撤销后再登录：整页重载，内存里不留上一个用户的任何状态；
 *   5. revoke：立即清空内存中的令牌与 Key，卸载工作区，显示空白状态。
 */
export function EmbedRoot() {
  const [phase, setPhase] = useState<Phase>('waiting');
  const [error, setError] = useState<string | null>(null);
  const [Shell, setShell] = useState<ComponentType | null>(null);
  const [shellKey, setShellKey] = useState(0);
  const loadedUserIdRef = useRef<number | null>(null);
  const revokedRef = useRef(false);
  const shellLoadedRef = useRef(false);
  const startingRef = useRef(false);
  const availabilityRef = useRef('');

  const start = useCallback(async (userId: number) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setPhase('loading');
    setError(null);
    try {
      setStoragePartition(userId);
      loadedUserIdRef.current = userId;
      await bootstrapStudio(userId);
      const mod = await import('@/components/workspace/WorkspaceShell');
      shellLoadedRef.current = true;
      if (getEmbedSession()?.userId !== userId) return;
      availabilityRef.current = availabilitySignature();
      setShell(() => mod.WorkspaceShell);
      setPhase('ready');
    } catch (err) {
      dismissBootLoader();
      setError(err instanceof Error ? err.message : '加载失败');
      setPhase('error');
    } finally {
      startingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const uninstall = installEmbedRuntime();
    const onMessage = (event: MessageEvent) => {
      handleParentMessageEvent(event);
    };
    window.addEventListener('message', onMessage);

    const onSessionChange = () => {
      const { status, session } = getEmbedSessionState();
      if (status === 'revoked') {
        revokedRef.current = true;
        // 停掉任务 WebSocket / HTTP 兜底轮询（已绑定上一个会话）；之后再收到会话会整页重载
        if (shellLoadedRef.current) void import('@/lib/ccode-task-socket').then((mod) => mod.novaTaskSocket.disable());
        resetStudioState();
        clearAuthedImageCache();
        dismissEmbedNotice();
        setShell(null);
        dismissBootLoader();
        setPhase('revoked');
        return;
      }
      if (!session) return;
      applyEmbedTheme(session.theme);
      const loaded = loadedUserIdRef.current;
      if (loaded === null) {
        void start(session.userId);
        return;
      }
      // 换账号，或撤销后重新登录：整页重载，确保内存（任务订阅、Agent 会话、图片缓存等）不残留上一个会话
      if (loaded !== session.userId || revokedRef.current) {
        window.location.reload();
      }
      // 同一用户的令牌刷新 / 主题 / 角色变化：令牌与角色按需读取，无需额外处理
    };
    const unsubscribe = subscribeEmbedSession(onSessionChange);

    const inFrame = window.parent && window.parent !== window;
    postToParent({ type: 'nova:ready' });
    const timer = inFrame ? null : window.setTimeout(() => {
      dismissBootLoader();
      setPhase((prev) => (prev === 'waiting' ? 'not-embedded' : prev));
    }, NOT_EMBEDDED_HINT_DELAY_MS);

    return () => {
      if (timer) window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('message', onMessage);
      uninstall();
    };
  }, [start]);

  // 设置页关闭后，若生图 / 对话的可用性发生变化，重新挂载工作区，让只在挂载时读取配置的组件拿到新值
  useEffect(() => subscribeShellRefresh(() => {
    const next = availabilitySignature();
    if (next !== availabilityRef.current) {
      availabilityRef.current = next;
      setShellKey((key) => key + 1);
    }
  }), []);

  if (phase === 'ready' && Shell) {
    return (
      <>
        <Shell key={shellKey} />
        <EmbedNoticeHost />
      </>
    );
  }

  if (phase === 'revoked') {
    return <div className="min-h-dvh" aria-label="已退出登录" />;
  }

  if (phase === 'not-embedded') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-center text-sm text-muted-foreground">
        请登录控制台后，从「创作工作台」进入。
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-destructive">加载失败：{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const session = getEmbedSession();
            loadedUserIdRef.current = null;
            if (session) void start(session.userId);
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  // waiting / loading：layout 的启动加载层仍在；这里给一个同样的占位，避免加载层被移除后出现空白
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <span className="sr-only">正在加载</span>
    </div>
  );
}
