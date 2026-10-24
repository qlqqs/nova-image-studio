'use client';

import type { ComponentType } from 'react';

// 嵌入构建（NEXT_PUBLIC_NOVA_EMBED=1）走 EmbedRoot：收到 sub2api 会话、确定存储分区后才动态加载工作区。
// 条件在构建期被常量折叠，独立构建不包含嵌入入口，行为与上游一致。
/* eslint-disable @typescript-eslint/no-require-imports */
const Home: ComponentType = process.env.NEXT_PUBLIC_NOVA_EMBED === '1'
  ? require('@/components/embed/EmbedRoot').EmbedRoot
  : require('@/components/workspace/WorkspaceShell').WorkspaceShell;
/* eslint-enable @typescript-eslint/no-require-imports */

export default Home;
