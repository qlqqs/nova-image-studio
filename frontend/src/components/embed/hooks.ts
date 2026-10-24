'use client';

import { useSyncExternalStore } from 'react';
import { getEmbedSessionState, subscribeEmbedSession, type EmbedSessionState } from '@/lib/embed/session';
import { getBalanceState, subscribeBalance, type BalanceState } from '@/lib/embed/balance';
import { getEmbedNotice, subscribeEmbedNotice, type EmbedNotice } from '@/lib/embed/notices';
import { getStudioKeys, getStudioPrefs, subscribeStudioState } from '@/lib/embed/studio-state';

const SERVER_SESSION: EmbedSessionState = { status: 'waiting', session: null };
const SERVER_BALANCE: BalanceState = { balance: null, loading: false, error: null };

export function useEmbedSessionState(): EmbedSessionState {
  return useSyncExternalStore(subscribeEmbedSession, getEmbedSessionState, () => SERVER_SESSION);
}

export function useIsEmbedAdmin(): boolean {
  return useEmbedSessionState().session?.role === 'admin';
}

export function useBalanceState(): BalanceState {
  return useSyncExternalStore(subscribeBalance, getBalanceState, () => SERVER_BALANCE);
}

export function useEmbedNotice(): EmbedNotice | null {
  return useSyncExternalStore(subscribeEmbedNotice, getEmbedNotice, () => null);
}

export function useStudioKeys() {
  return useSyncExternalStore(subscribeStudioState, getStudioKeys, getStudioKeys);
}

export function useStudioPrefs() {
  return useSyncExternalStore(subscribeStudioState, getStudioPrefs, getStudioPrefs);
}
