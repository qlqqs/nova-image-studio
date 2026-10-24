/**
 * 嵌入模式下替换上游文案里的「Nova API 密钥」：密钥来自用户在本站的 API 密钥，在设置页选择。
 */
import { NOVA_EMBED_BUILD } from '@/lib/embed/mode';

/** 「请先在设置中{KEY_SETUP_ACTION}，…」 */
export const KEY_SETUP_ACTION = NOVA_EMBED_BUILD ? '选择要使用的 API 密钥' : '配置 Nova API 密钥';
