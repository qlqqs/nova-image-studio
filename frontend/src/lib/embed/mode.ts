/**
 * Sub2API 嵌入模式开关（docs/sub2api-embed.md §1）。
 *
 * 由构建期 `NEXT_PUBLIC_NOVA_EMBED=1` 决定，构建产物里是常量；独立（BYOK）模式下所有
 * `isEmbedMode()` 分支都是 false，行为与上游一致。测试可用 setEmbedModeForTests 覆盖。
 */

export const NOVA_EMBED_BUILD = process.env.NEXT_PUBLIC_NOVA_EMBED === '1';

let override: boolean | null = null;

export function isEmbedMode(): boolean {
  return override ?? NOVA_EMBED_BUILD;
}

/** 仅测试用：强制开启 / 关闭嵌入模式；传 null 恢复构建期取值。 */
export function setEmbedModeForTests(value: boolean | null): void {
  override = value;
}

/** AGPL-3.0 源码地址（设置页底部「源码」链接）。 */
export const NOVA_SOURCE_URL = 'https://github.com/qlqqs/nova-image-studio';
