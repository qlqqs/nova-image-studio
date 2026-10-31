/**
 * 嵌入模式下替换上游文案里的「Nova API 密钥」：密钥来自用户在本站的 API 密钥，在设置页选择。
 */
import { NOVA_EMBED_BUILD } from '@/lib/embed/mode';

/** 「请先在设置中{KEY_SETUP_ACTION}，…」 */
export const KEY_SETUP_ACTION = NOVA_EMBED_BUILD ? '选择要使用的 API 密钥' : '配置 Nova API 密钥';

/** 嵌入模式视频结果的保留期提示（与 NOVA_VIDEO_RETENTION_DAYS 默认值一致） */
export const VIDEO_RETENTION_NOTICE = '视频保留 3 天，请及时下载';
