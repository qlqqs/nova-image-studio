'use client';

import { useRef, useState } from 'react';
import { Film, Image as ImageIcon, Link2, Loader2, Mic, Music, Plus, Upload, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { MediaLimitsPopover } from '@/components/plugin/MediaLimitsPopover';
import { useMediaDropZone } from '@/hooks/useMediaDropZone';
import { formatBytes, getAcceptAttribute } from '@/lib/plugin-media-config';
import type { MediaKind, PluginField } from '@/lib/plugin-schema';
import type { PendingMedia } from '@/lib/plugin-upload-runner';

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  images: ImageIcon,
  videos: Video,
  audios: Music,
};

const CHIP_ICON: Record<MediaKind, typeof ImageIcon> = {
  images: ImageIcon,
  videos: Film,
  audios: Mic,
};

/** schema 里的 accent 名 → 配色。认不出来的回落到主色。 */
const ACCENT_TEXT: Record<string, string> = {
  blue: 'text-blue-500',
  emerald: 'text-emerald-500',
  amber: 'text-amber-500',
  primary: 'text-primary',
};

interface SchemaMediaFieldProps {
  field: PluginField;
  maxCount: number;
  required: boolean;
  items: PendingMedia[];
  busy: boolean;
  onPick: (files: File[]) => void;
  onRemove: (index: number) => void;
  /** 素材槽允许公网链接（allowRemoteUrl）时提供 */
  onAddUrl?: (url: string) => void;
}

/** 公网链接只接受 https:// */
export function parseRemoteMediaUrl(raw: string): string | null {
  const text = raw.trim();
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** 链接的简短展示：主机名 + 末段路径 */
function shortUrl(href: string): string {
  try {
    const url = new URL(href);
    const tail = url.pathname.split('/').filter(Boolean).pop();
    return tail ? `${url.hostname}/…/${tail}` : url.hostname;
  } catch {
    return href;
  }
}

function itemName(item: PendingMedia): string {
  return item.file?.name || item.remoteUrl || '';
}

/**
 * 一个素材槽。三种呈现由 schema 的 `style` 决定：
 *   frame     首尾帧这类「一格一张」的宽画幅缩略图
 *   thumbnail 参考图这类方形缩略图网格
 *   chip      视频/音频这类只展示文件名 + 体积的胶囊
 *
 * 之所以不做成通用的「一种呈现打天下」：视频文件没有可显示的缩略图，
 * 而首帧和参考图的画幅期望本来就不同，硬统一反而更难看。
 */
export function SchemaMediaField({
  field,
  maxCount,
  required,
  items,
  busy,
  onPick,
  onRemove,
  onAddUrl,
}: SchemaMediaFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkError, setLinkError] = useState('');
  const kind = (field.kind || 'images') as MediaKind;
  const drop = useMediaDropZone(onPick, busy);
  const accent = ACCENT_TEXT[field.accent || 'primary'] || 'text-primary';
  const Icon = KIND_ICON[kind];
  const ChipIcon = CHIP_ICON[kind];
  const label = field.label || field.key;
  const hint = required && field.requiredHint ? field.requiredHint : field.hint;
  const style = field.style || 'thumbnail';

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={getAcceptAttribute(kind)}
      multiple={maxCount > 1}
      className="hidden"
      onChange={event => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) onPick(files);
        event.target.value = '';
      }}
    />
  );

  const header = (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Icon className={cn('size-3.5', accent)} />
        {label} ({items.length}/{maxCount})
        {required && <span className="text-destructive">*必填</span>}
        {field.hint && style === 'frame' && (
          <span className="text-[11px] font-normal text-muted-foreground">{field.hint}</span>
        )}
        <MediaLimitsPopover kind={kind} />
      </span>
      <div className="flex items-center">
        {items.length < maxCount && onAddUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLinkOpen(open => !open)}
            className={cn('h-6 px-2 text-[11px]', accent)}
          >
            <Link2 className="mr-1 size-3" />
            链接
          </Button>
        )}
        {items.length < maxCount && style !== 'frame' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className={cn('h-6 px-2 text-[11px]', accent)}
          >
            {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Plus className="mr-1 size-3" />}
            添加
          </Button>
        )}
      </div>
    </div>
  );

  const submitLink = () => {
    const url = parseRemoteMediaUrl(linkText);
    if (!url) {
      setLinkError('请填写 https:// 开头的公网链接');
      return;
    }
    onAddUrl?.(url);
    setLinkText('');
    setLinkError('');
    setLinkOpen(false);
  };

  const linkInput = linkOpen && items.length < maxCount && (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Input
          value={linkText}
          onChange={event => { setLinkText(event.target.value); setLinkError(''); }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitLink(); } }}
          placeholder="https://"
          className="h-7 rounded-lg text-xs"
          aria-label={`${label}链接`}
        />
        <Button type="button" size="sm" variant="outline" className="h-7 rounded-lg px-2 text-[11px]" onClick={submitLink}>
          确定
        </Button>
      </div>
      {linkError && <p className="text-[11px] text-destructive">{linkError}</p>}
    </div>
  );

  return (
    <div
      className={cn(
        'space-y-1.5 rounded-xl border border-dashed p-2 transition-colors',
        drop.isDragOver ? 'border-primary bg-primary/10' : 'border-transparent',
      )}
      {...drop.dropProps}
    >
      {header}
      {fileInput}
      {linkInput}

      {style === 'chip' ? (
        <div className="flex flex-wrap gap-2">
          {/* 显示真实文件名与体积，提交前用户能核对选的是不是那一份 */}
          {items.map((item, index) => (
            <div
              key={item.id}
              className="group relative flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-muted px-2.5 py-1 text-xs"
              title={itemName(item)}
            >
              {item.file ? <ChipIcon className={cn('size-3', accent)} /> : <Link2 className={cn('size-3', accent)} />}
              <span className="max-w-[9rem] truncate font-mono text-[11px]">{item.file ? item.file.name : shortUrl(item.remoteUrl || '')}</span>
              {item.file && <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(item.file.size)}</span>}
              {item.durationSec !== undefined && (
                <span className="shrink-0 text-[10px] text-muted-foreground">{Math.round(item.durationSec * 10) / 10}秒</span>
              )}
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="ml-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
                aria-label={`移除 ${itemName(item)}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {items.length === 0 && (
            <div className="text-[11px] text-muted-foreground">未添加{label}（可选，可拖入）</div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                'group relative overflow-hidden rounded-xl border border-border bg-black',
                style === 'frame' ? 'aspect-video w-24' : 'size-16',
              )}
            >
              {/* 本地 objectURL 预览，不走图片优化；公网链接不在浏览器里加载，只显示主机名 */}
              {item.file ? (
                <img
                  src={item.previewUrl}
                  alt={`${label}${index + 1}`}
                  className={cn('h-full w-full', style === 'frame' ? 'object-contain' : 'object-cover')}
                />
              ) : (
                <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-muted p-1 text-muted-foreground" title={item.remoteUrl}>
                  <Link2 className="size-3.5" />
                  <span className="w-full truncate text-center text-[9px]">{shortUrl(item.remoteUrl || '')}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-md bg-black/70 text-white opacity-80 hover:opacity-100"
                aria-label={`移除${label}${index + 1}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {items.length < maxCount && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed transition-colors',
                style === 'frame' ? 'aspect-video w-24' : 'size-16',
                required && items.length === 0
                  ? 'border-destructive/50 bg-destructive/5 hover:border-destructive'
                  : 'border-border bg-card/60 hover:border-primary/60',
              )}
            >
              {busy
                ? <Loader2 className="size-4 animate-spin text-primary" />
                : <Upload className="size-4 text-muted-foreground" />}
              <span className="text-[10px] text-muted-foreground">
                {items.length === 0 ? '选择' : '再加一个'}
              </span>
            </button>
          )}
        </div>
      )}

      {hint && style !== 'frame' && (
        <p className={cn('text-[11px] leading-relaxed', required ? 'text-destructive/90' : 'text-muted-foreground')}>
          {hint}
        </p>
      )}
    </div>
  );
}
