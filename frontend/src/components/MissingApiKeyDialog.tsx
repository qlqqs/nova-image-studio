'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isEmbedMode } from '@/lib/embed/mode';

interface MissingApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigure: () => void;
}

export function MissingApiKeyDialog({ open, onOpenChange, onConfigure }: MissingApiKeyDialogProps) {
  const handleConfigure = () => {
    onOpenChange(false);
    onConfigure();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEmbedMode() ? '请先选择生图密钥' : '请先配置 API 密钥'}</DialogTitle>
          <DialogDescription>
            {isEmbedMode()
              ? '在设置「模型与密钥」中为生图选择一个 API 密钥和模型（没有可用密钥时可一键创建），选好后即可生成或转换图片。'
              : 'Nova 模式需要先配置 API 密钥，配置完成后即可生成或转换图片。'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfigure}>
            {isEmbedMode() ? '打开模型与密钥' : '配置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
