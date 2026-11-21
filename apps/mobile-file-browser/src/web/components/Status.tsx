import type { ReactNode } from 'react';
import { RefreshIcon, WifiOffIcon } from './Icons';

export function Spinner({ label = '加载中' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function LoadingScreen({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading-screen">
      <Spinner label={label} />
      <p>{label}</p>
    </div>
  );
}

interface MessagePanelProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondary?: ReactNode;
}

export function MessagePanel({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  secondary,
}: MessagePanelProps) {
  return (
    <div className="message-panel">
      {icon && <div className="message-icon">{icon}</div>}
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {actionLabel && onAction && (
        <button type="button" className="button button-primary" onClick={onAction}>
          <RefreshIcon size={18} />
          {actionLabel}
        </button>
      )}
      {secondary}
    </div>
  );
}

interface ConnectionBannerProps {
  message?: string;
  onRetry: () => void;
}

export function ConnectionBanner({ message, onRetry }: ConnectionBannerProps) {
  return (
    <div className="connection-banner" role="alert">
      <WifiOffIcon size={18} />
      <span>{message ?? '与电脑的连接已断开'}</span>
      <button type="button" className="banner-button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
