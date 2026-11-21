import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryResponse, Entry } from '../../shared/types';
import { ApiError, getDirectory } from '../api';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  RefreshIcon,
} from '../components/Icons';
import { LoadingScreen, MessagePanel } from '../components/Status';
import { basenameOf, dirnameOf, joinPath, type Route } from '../router';

interface ViewerPageProps {
  route: Route;
  onNavigate: (route: Route, options?: { replace?: boolean }) => void;
}

type ZoomLevel = 1 | 2 | 3;

export function ViewerPage({ route, onNavigate }: ViewerPageProps) {
  const rootId = route.rootId;
  const imagePath = route.path;
  const directoryPath = dirnameOf(imagePath);
  const imageName = basenameOf(imagePath);

  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageRetryKey, setImageRetryKey] = useState(0);
  const pinchRef = useRef<{ start: number; last: number } | null>(null);
  const swipeRef = useRef<{ x: number; y: number; at: number; multi: boolean } | null>(null);

  useEffect(() => {
    if (!rootId) {
      setLoading(false);
      setError(new ApiError('没有选择根目录', 'not-found', 404));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDirectory(rootId, directoryPath)
      .then((result) => {
        if (!cancelled) {
          setDirectory(result);
          setLoading(false);
        }
      })
      .catch((directoryError) => {
        if (!cancelled) {
          setError(directoryError);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, directoryPath, reloadKey]);

  useEffect(() => {
    setZoom(1);
    setImageLoaded(false);
    setImageFailed(false);
  }, [imagePath]);

  const images = useMemo(
    () => (directory ? directory.entries.filter((entry) => entry.kind === 'image') : []),
    [directory],
  );
  const index = images.findIndex((entry) => entry.name === imageName);
  const current = index >= 0 ? images[index] : undefined;
  const total = images.length;

  useEffect(() => {
    if (!current) return;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;
    const neighbors = [images[index - 1], images[index + 1]].filter(Boolean) as Entry[];
    for (const neighbor of neighbors) {
      const source = neighbor.previewUrl ?? neighbor.imageUrl;
      if (source) {
        const preload = new Image();
        preload.src = source;
      }
    }
  }, [current, images, index]);

  const goTo = (targetIndex: number) => {
    if (!rootId || !images[targetIndex]) return;
    onNavigate(
      {
        view: 'viewer',
        rootId,
        path: joinPath(directoryPath, images[targetIndex].name),
      },
      { replace: true },
    );
  };

  const goBack = () => {
    onNavigate({ view: 'browse', rootId, path: directoryPath }, { replace: true });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        if (index > 0) goTo(index - 1);
      } else if (event.key === 'ArrowRight') {
        if (index >= 0 && index < total - 1) goTo(index + 1);
      } else if (event.key === 'Escape') {
        goBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const toggleZoom = () => {
    setZoom((value) => (value === 1 ? 2 : 1));
  };

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      swipeRef.current = { x: touch.clientX, y: touch.clientY, at: Date.now(), multi: false };
      pinchRef.current = null;
    } else if (event.touches.length === 2) {
      const distance = touchDistance(event.touches[0], event.touches[1]);
      pinchRef.current = { start: distance, last: distance };
      if (swipeRef.current) swipeRef.current.multi = true;
    }
  };

  const onTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2 && pinchRef.current) {
      pinchRef.current.last = touchDistance(event.touches[0], event.touches[1]);
    }
  };

  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      const { start, last } = pinchRef.current;
      if (start > 0 && event.touches.length < 2) {
        const ratio = last / start;
        if (ratio > 1.25 || ratio < 0.8) {
          setZoom((value) => clampZoom(Math.round(value * ratio)));
        }
      }
      pinchRef.current = null;
      return;
    }
    const swipe = swipeRef.current;
    if (!swipe || swipe.multi || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - swipe.x;
    const deltaY = touch.clientY - swipe.y;
    swipeRef.current = null;

    if (zoom > 1) return;

    if (Math.abs(deltaX) > 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      if (deltaX > 0) {
        if (index > 0) goTo(index - 1);
      } else if (index < total - 1) {
        goTo(index + 1);
      }
      return;
    }

  };

  if (loading) {
    return (
      <div className="viewer-page">
        <ViewerTopbar name={imageName} onBack={goBack} />
        <LoadingScreen label="正在打开图片…" />
      </div>
    );
  }

  if (error) {
    const apiError = error instanceof ApiError ? error : null;
    return (
      <div className="viewer-page">
        <ViewerTopbar name={imageName} onBack={goBack} />
        <MessagePanel
          icon={<ImageIcon size={34} />}
          title={apiError?.status === 0 ? '与电脑的连接已断开' : '无法打开这张图片'}
          description={
            apiError?.status === 0
              ? '请检查电脑是否开机、服务与隧道是否仍在运行。'
              : (apiError?.message ?? '请稍后重试。')
          }
          actionLabel="重试"
          onAction={() => setReloadKey((value) => value + 1)}
          secondary={
            <button type="button" className="button button-ghost" onClick={goBack}>
              返回文件夹
            </button>
          }
        />
      </div>
    );
  }

  if (!current) {
    return (
      <div className="viewer-page">
        <ViewerTopbar name={imageName} onBack={goBack} />
        <MessagePanel
          icon={<ImageIcon size={34} />}
          title="这张图片不在这里"
          description="文件可能已被移动或删除，返回文件夹重新选择。"
          actionLabel="返回文件夹"
          onAction={goBack}
        />
      </div>
    );
  }

  const source = current.previewUrl ?? current.imageUrl ?? '';

  return (
    <div className="viewer-page">
      <ViewerTopbar name={current.name} onBack={goBack} />
      <div
        className={zoom === 1 ? 'viewer-stage' : 'viewer-stage is-zoomed'}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {!imageLoaded && !imageFailed && (
          <div className="viewer-loading">
            <span className="spinner spinner-large" aria-label="图片加载中" />
          </div>
        )}
        {imageFailed ? (
          <div className="viewer-image-error" role="alert">
            <p>这张图片无法显示</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setImageFailed(false);
                setImageLoaded(false);
                setImageRetryKey((value) => value + 1);
              }}
            >
              <RefreshIcon size={18} />
              重试
            </button>
            <p className="viewer-image-hint">如果是 HEIC/HEIF 照片，可能暂不支持在当前浏览器或服务端转码。</p>
          </div>
        ) : (
          <img
            key={`${source}-${imageRetryKey}`}
            src={source}
            alt={current.name}
            className={`viewer-image${zoom === 1 ? '' : zoom === 2 ? ' zoom-2' : ' zoom-3'}`}
            draggable={false}
            onClick={toggleZoom}
            onLoad={() => setImageLoaded(true)}
            onError={() => {
              setImageLoaded(false);
              setImageFailed(true);
            }}
          />
        )}
      </div>
      <footer className="viewer-footer">
        <button
          type="button"
          className="icon-button viewer-nav"
          aria-label="上一张"
          disabled={index <= 0}
          onClick={() => goTo(index - 1)}
        >
          <ChevronLeftIcon size={24} />
        </button>
        <span className="viewer-counter">
          {index + 1} / {total}
        </span>
        <button
          type="button"
          className="icon-button viewer-nav"
          aria-label="下一张"
          disabled={index >= total - 1}
          onClick={() => goTo(index + 1)}
        >
          <ChevronRightIcon size={24} />
        </button>
      </footer>
    </div>
  );
}

function ViewerTopbar({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <header className="viewer-topbar">
      <button type="button" className="icon-button viewer-back" aria-label="返回文件夹" onClick={onBack}>
        <ArrowLeftIcon size={24} />
      </button>
      <p className="viewer-filename" title={name}>
        {name}
      </p>
      <span className="viewer-topbar-spacer" aria-hidden="true" />
    </header>
  );
}

function touchDistance(a: React.Touch, b: React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function clampZoom(value: number): ZoomLevel {
  if (value <= 1) return 1;
  if (value >= 3) return 3;
  return value as ZoomLevel;
}
