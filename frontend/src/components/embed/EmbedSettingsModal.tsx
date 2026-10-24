'use client';

import { useRef, useState } from 'react';
import { CheckCircle2, Database, Download, ExternalLink, KeyRound, Package, Settings, Upload, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { BackupProgress } from '@/components/BackupProgress';
import { PluginsSettings } from '@/components/settings/PluginsSettings';
import { ModelKeySettings } from '@/components/embed/ModelKeySettings';
import { useIsEmbedAdmin } from '@/components/embed/hooks';
import { exportAllData, importAllData, downloadBlob, generateBackupFilename, type BackupProgress as BackupProgressType } from '@/lib/backup-utils';
import { hasAnyApiKey } from '@/lib/settings-storage';
import { requestShellRefresh } from '@/lib/embed/shell-refresh';
import { NOVA_SOURCE_URL } from '@/lib/embed/mode';

export type EmbedSettingsTab = 'models' | 'plugins' | 'backup';

export interface EmbedSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApiKeyChange?: (hasKey: boolean) => void;
  initialTab?: string;
}

// 只用底部一条线标出当前分区：去掉上游的焦点外框、深色下的方框与底色
const TRIGGER_CLASS = 'gap-2 rounded-none border-0 border-b-2 border-transparent px-4 py-3 data-active:border-primary data-active:bg-transparent data-active:shadow-none dark:data-active:border-primary dark:data-active:bg-transparent focus-visible:ring-0 focus-visible:outline-none';

/** 「插件」分区只对 sub2api 管理员显示（PRD R5A.2）。纯函数，便于测试。 */
export function visibleEmbedSettingsTabs(isAdmin: boolean): EmbedSettingsTab[] {
  return isAdmin ? ['models', 'plugins', 'backup'] : ['models', 'backup'];
}

function normalizeTab(tab: string | undefined, tabs: EmbedSettingsTab[]): EmbedSettingsTab {
  return tabs.includes(tab as EmbedSettingsTab) ? tab as EmbedSettingsTab : 'models';
}

/**
 * 嵌入模式的设置页（PRD R5 / R5A）：「模型与密钥」（替代 BYOK 模型配置）|「插件」（仅管理员）|「备份」（导出不含任何 Key）。
 * 没有「关于」；底部保留 AGPL 源码链接。
 */
export function EmbedSettingsModal({ isOpen, onClose, onApiKeyChange, initialTab }: EmbedSettingsModalProps) {
  const isAdmin = useIsEmbedAdmin();
  const tabs = visibleEmbedSettingsTabs(isAdmin);
  const [tab, setTab] = useState<EmbedSettingsTab>(normalizeTab(initialTab, tabs));
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setTab(normalizeTab(initialTab, tabs));
  }
  const activeTab = tabs.includes(tab) ? tab : 'models';

  const [backupProgress, setBackupProgress] = useState<BackupProgressType>({ percent: 0, message: '' });
  const [isBackupActive, setIsBackupActive] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    onApiKeyChange?.(hasAnyApiKey());
    onClose();
    requestShellRefresh();
  };

  const handleExport = async (configOnly = false) => {
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const blob = await exportAllData((progress) => setBackupProgress(progress), { includeImages: !configOnly });
      const filename = generateBackupFilename(configOnly);
      downloadBlob(blob, filename);
      setBackupSuccess(`数据已导出为 ${filename}（不含任何 API 密钥）`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setBackupError('请选择有效的备份文件（.zip 格式）');
      return;
    }
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const warnings = await importAllData(file, (progress) => setBackupProgress(progress));
      setBackupSuccess(warnings.length > 0
        ? `数据已导入，但有 ${warnings.length} 项提示：${warnings.join('；')}。页面将在 2 秒后刷新。`
        : '数据已成功导入，页面将在 2 秒后刷新。');
      setIsBackupActive(false);
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导入失败');
      setIsBackupActive(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open, eventDetails) => {
      if (open) return;
      if (isBackupActive) {
        eventDetails.cancel();
        return;
      }
      close();
    }}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 pt-0 gap-0 sm:max-w-3xl">
        <DialogHeader className="p-4 pb-3">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>设置</DialogTitle>
          </div>
          <DialogDescription>选择生图与对话使用的 API 密钥和模型。密钥明文只在本页面内存中使用，不会保存在浏览器里。</DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(value) => setTab(value as EmbedSettingsTab)} className="min-h-0 flex-1 gap-0">
          <TabsList className="w-full rounded-none border-b bg-transparent h-auto p-0">
            <TabsTrigger value="models" className={TRIGGER_CLASS}>
              <KeyRound className="w-4 h-4" />
              模型与密钥
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="plugins" className={TRIGGER_CLASS}>
                <Package className="w-4 h-4" />
                插件
              </TabsTrigger>
            )}
            <TabsTrigger value="backup" className={TRIGGER_CLASS}>
              <Database className="w-4 h-4" />
              备份
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0">
            {isOpen && <ModelKeySettings />}
          </TabsContent>

          {isAdmin && (
            <TabsContent value="plugins" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
              <PluginsSettings />
            </TabsContent>
          )}

          <TabsContent value="backup" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 mt-0">
            <div className="space-y-2">
              <h3 className="text-base font-medium">数据备份与恢复</h3>
              <p className="text-sm text-muted-foreground">导出本账号在此浏览器中的数据（任务历史、设置、素材与图片）为 ZIP 压缩包，或从备份文件恢复。导出内容不包含任何 API 密钥。</p>
            </div>

            <BackupProgress percent={backupProgress.percent} message={backupProgress.message} isActive={isBackupActive} />

            {backupSuccess && !isBackupActive && (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                <p className="text-sm text-emerald-900 dark:text-emerald-100">{backupSuccess}</p>
              </div>
            )}
            {backupError && !isBackupActive && (
              <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                <p className="text-sm text-destructive break-all">{backupError}</p>
              </div>
            )}

            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div className="flex-1 space-y-2">
                  <h4 className="font-medium">导出数据</h4>
                  <p className="text-sm text-muted-foreground">全量备份包含本地记录和画布图片 / 媒体文件；仅配置导出不含图片、媒体、素材与生成结果。</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void handleExport(false)} disabled={isBackupActive} className="gap-2">
                      <Download className="w-4 h-4" />
                      全量备份
                    </Button>
                    <Button onClick={() => void handleExport(true)} disabled={isBackupActive} variant="outline" className="gap-2">
                      <Download className="w-4 h-4" />
                      仅配置导出（不含图片）
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <Upload className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div className="flex-1 space-y-2">
                  <h4 className="font-medium">导入数据</h4>
                  <p className="text-sm text-muted-foreground">从备份文件恢复本账号的数据。<span className="font-medium text-destructive">警告：这会覆盖现有数据。</span></p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleImport(file);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                  />
                  <Button onClick={() => fileInputRef.current?.click()} disabled={isBackupActive} variant="outline" className="gap-2">
                    <Upload className="w-4 h-4" />
                    选择备份文件
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="border-t px-4 py-2 text-right text-[11px] text-muted-foreground">
          <a href={NOVA_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
            源码（AGPL-3.0）<ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
