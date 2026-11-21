import { useEffect, useState } from 'react';
import type { DirectoryResponse, Entry, RootInfo, SessionResponse } from '../../shared/types';
import { ApiError, getDirectory, getRoots } from '../api';
import { Breadcrumb } from '../components/Breadcrumb';
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  RefreshIcon,
} from '../components/Icons';
import { ConnectionBanner, MessagePanel } from '../components/Status';
import { RootSheet } from '../components/RootSheet';
import { Thumbnail } from '../components/Thumbnail';
import { joinPath, type Route } from '../router';

interface BrowsePageProps {
  session: SessionResponse;
  route: Route;
  onNavigate: (route: Route, options?: { replace?: boolean }) => void;
  onLogout: () => void;
}

export function BrowsePage({ session, route, onNavigate, onLogout }: BrowsePageProps) {
  const [roots, setRoots] = useState<RootInfo[] | null>(null);
  const [rootsError, setRootsError] = useState<unknown>(null);
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRootsError(null);
    getRoots()
      .then((response) => {
        if (!cancelled) setRoots(response.roots);
      })
      .catch((rootsFailure) => {
        if (!cancelled) setRootsError(rootsFailure);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!route.rootId && roots && roots.length > 0) {
      onNavigate({ view: 'browse', rootId: roots[0].id, path: '' }, { replace: true });
    }
  }, [roots, route.rootId, onNavigate]);

  useEffect(() => {
    if (!route.rootId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDirectory(route.rootId, route.path)
      .then((result) => {
        if (!cancelled) {
          setDirectory(result);
          setLoading(false);
        }
      })
      .catch((directoryFailure) => {
        if (!cancelled) {
          setError(directoryFailure);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [route.rootId, route.path, reloadKey]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [route.rootId, route.path]);

  const rootName =
    directory?.root.name ?? roots?.find((root) => root.id === route.rootId)?.name ?? '手机文件';
  const retry = () => setReloadKey((value) => value + 1);
  const showConnectionBanner =
    (error instanceof ApiError && error.status === 0) ||
    (rootsError instanceof ApiError && rootsError.status === 0);

  const goToPath = (path: string) => {
    if (!route.rootId) return;
    onNavigate({ view: 'browse', rootId: route.rootId, path });
  };

  const openImage = (entry: Entry) => {
    if (!route.rootId || !directory) return;
    onNavigate({
      view: 'viewer',
      rootId: route.rootId,
      path: joinPath(directory.path, entry.name),
    });
  };

  return (
    <div className="browse-page">
      <header className="topbar">
        <div className="topbar-titles">
          <p className="topbar-eyebrow">只读浏览</p>
          <h1 className="topbar-title" title={rootName}>
            {rootName}
          </h1>
        </div>
        <button
          type="button"
          className="button button-secondary switch-button"
          onClick={() => setSheetOpen(true)}
        >
          <FolderIcon size={18} />
          切换
        </button>
      </header>

      {showConnectionBanner && <ConnectionBanner onRetry={retry} />}

      {directory && !error && (
        <Breadcrumb items={directory.breadcrumb} onNavigate={goToPath} />
      )}

      <main className="browse-content">
        {Boolean(rootsError) && !showConnectionBanner && (
          <MessagePanel
            title="无法读取根目录"
            description={rootsError instanceof ApiError ? rootsError.message : '请稍后重试。'}
            actionLabel="重试"
            onAction={retry}
          />
        )}

        {loading && !directory && <BrowseSkeleton />}

        {loading && directory && (
          <div className="loading-overlay">
            <span className="spinner" role="status" aria-label="正在读取文件夹" />
          </div>
        )}

        {!loading && Boolean(error) && (
          <DirectoryError error={error} onRetry={retry} onRoot={() => goToPath('')} />
        )}

        {!loading && !error && directory && directory.entries.length === 0 && (
          <MessagePanel
            icon={<FolderIcon size={34} />}
            title="这个文件夹是空的"
            description="里面没有文件夹或图片。"
          />
        )}

        {!loading && !error && directory && directory.entries.length > 0 && (
          <DirectoryContent directory={directory} onOpenDirectory={goToPath} onOpenImage={openImage} />
        )}
      </main>

      {directory && !loading && !error && (
        <footer className="browse-footer">
          共 {directory.entries.length} 项 · 只读浏览，不会修改电脑文件
        </footer>
      )}

      {sheetOpen && (
        <RootSheet
          roots={roots ?? []}
          currentRootId={route.rootId}
          mode={session.mode}
          onSelect={(rootId) => {
            setSheetOpen(false);
            setDirectory(null);
            onNavigate({ view: 'browse', rootId, path: '' });
          }}
          onClose={() => setSheetOpen(false)}
          onLogout={() => {
            setSheetOpen(false);
            onLogout();
          }}
        />
      )}
    </div>
  );
}

function DirectoryContent({
  directory,
  onOpenDirectory,
  onOpenImage,
}: {
  directory: DirectoryResponse;
  onOpenDirectory: (path: string) => void;
  onOpenImage: (entry: Entry) => void;
}) {
  const directories = directory.entries.filter((entry) => entry.kind === 'directory');
  const images = directory.entries.filter((entry) => entry.kind === 'image');
  const others = directory.entries.filter((entry) => entry.kind === 'other');

  return (
    <div className="directory-content">
      {directories.length > 0 && (
        <ul className="directory-list">
          {directories.map((entry) => (
            <li key={`dir-${entry.name}`}>
              <button
                type="button"
                className="entry-row directory-row"
                onClick={() => onOpenDirectory(joinPath(directory.path, entry.name))}
              >
                <span className="entry-icon entry-icon-folder">
                  <FolderIcon size={22} />
                </span>
                <span className="entry-text">
                  <span className="entry-name">{entry.name}</span>
                  <span className="entry-meta">{formatModified(entry.mtime)}</span>
                </span>
                <ChevronRightIcon size={20} className="entry-chevron" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {images.length > 0 && (
        <section className="image-section" aria-label="图片">
          <div className="section-heading">
            <span className="section-title">图片</span>
            <span className="section-count">{images.length}</span>
          </div>
          <div className="image-grid">
            {images.map((entry) => (
              <Thumbnail key={`image-${entry.name}`} entry={entry} onOpen={() => onOpenImage(entry)} />
            ))}
          </div>
        </section>
      )}

      {others.length > 0 && (
        <ul className="file-list" aria-label="其他文件">
          {others.map((entry) => (
            <li key={`other-${entry.name}`}>
              <div className="entry-row other-row" aria-disabled="true">
                <span className="entry-icon">
                  <FileIcon size={20} />
                </span>
                <span className="entry-text">
                  <span className="entry-name">{entry.name}</span>
                  <span className="entry-meta">{entry.note ?? '仅支持图片预览'}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {directory.truncated && (
        <div className="notice notice-warning truncation-notice">
          <p className="notice-title">条目较多</p>
          <p>仅显示前 {directory.entries.length} 项，请进入更具体的文件夹查看其余内容。</p>
        </div>
      )}
    </div>
  );
}

function DirectoryError({
  error,
  onRetry,
  onRoot,
}: {
  error: unknown;
  onRetry: () => void;
  onRoot: () => void;
}) {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.status === 0) {
    return (
      <MessagePanel
        icon={<ImageIcon size={34} />}
        title="与电脑的连接已断开"
        description="请检查电脑是否开机、服务与隧道是否仍在运行，然后重试。"
        actionLabel="重新连接"
        onAction={onRetry}
      />
    );
  }
  if (apiError?.code === 'not-found') {
    return (
      <MessagePanel
        icon={<FolderIcon size={34} />}
        title="文件夹可能已被移动或删除"
        description="返回根目录，或检查电脑上的文件夹是否仍然存在。"
        actionLabel="回到根目录"
        onAction={onRoot}
        secondary={
          <button type="button" className="button button-ghost" onClick={onRetry}>
            <RefreshIcon size={18} />
            重试
          </button>
        }
      />
    );
  }
  return (
    <MessagePanel
      icon={<FolderIcon size={34} />}
      title={apiError?.code === 'not-directory' ? '该位置不是文件夹' : '无法读取这个文件夹'}
      description={apiError?.message ?? '请稍后重试。'}
      actionLabel="重试"
      onAction={onRetry}
      secondary={
        <button type="button" className="button button-ghost" onClick={onRoot}>
          回到根目录
        </button>
      }
    />
  );
}

function BrowseSkeleton() {
  return (
    <div className="browse-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-block skeleton-icon" />
          <span className="skeleton-lines">
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line short" />
          </span>
        </div>
      ))}
      <div className="skeleton-grid">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span className="skeleton-block skeleton-thumb" key={index} />
        ))}
      </div>
    </div>
  );
}

function formatModified(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
}
