import { useCallback, useEffect, useState } from 'react';
import type { SessionResponse } from '../shared/types';
import { ApiError, getSession, logout, pair } from './api';
import { RefreshIcon } from './components/Icons';
import { LoadingScreen, MessagePanel } from './components/Status';
import { BrowsePage } from './pages/BrowsePage';
import { LoginPage } from './pages/LoginPage';
import { ViewerPage } from './pages/ViewerPage';
import { navigate, parseRoute, type Route } from './router';

type PairingState = 'idle' | 'working' | 'failed';

function pairingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return '配对链接已失效或已被使用，请在电脑上重新启动服务获取新链接。';
    if (error.code === 'rate-limited') return '尝试次数过多，请稍后再试。';
  }
  return '配对失败，请检查电脑和网络后重试。';
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [pairingState, setPairingState] = useState<PairingState>('idle');
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute());

  const refreshSession = useCallback(async (): Promise<SessionResponse | null> => {
    try {
      const result = await getSession();
      setSession(result);
      setSessionError(null);
      return result;
    } catch (error) {
      setSessionError(error);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = hash.get('pair');
    if (!token) return;
    setPairingState('working');
    void (async () => {
      try {
        await pair(token);
        const result = await getSession();
        setSession(result);
        setPairingState('idle');
        setPairingError(null);
      } catch (error) {
        setPairingState('failed');
        setPairingError(pairingErrorMessage(error));
      } finally {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      }
    })();
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      void refreshSession();
    };
    window.addEventListener('mfb:unauthorized', onUnauthorized);
    return () => window.removeEventListener('mfb:unauthorized', onUnauthorized);
  }, [refreshSession]);

  const go = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    navigate(next, options);
    setRoute(next);
  }, []);

  const handleLogout = useCallback(() => {
    void (async () => {
      try {
        await logout();
      } catch {
        // The cookie may already be invalid; refreshing the session is enough.
      }
      await refreshSession();
    })();
  }, [refreshSession]);

  if (pairingState === 'working') {
    return <LoadingScreen label="正在配对…" />;
  }

  if (!session) {
    if (sessionError) {
      return (
        <div className="app-message">
          <MessagePanel
            icon={<RefreshIcon size={34} />}
            title="无法连接到电脑上的服务"
            description={
              sessionError instanceof ApiError && sessionError.status === 0
                ? '请确认电脑上的服务正在运行，外网访问时再检查隧道是否已启动。'
                : '请稍后重试。'
            }
            actionLabel="重新连接"
            onAction={() => void refreshSession()}
          />
        </div>
      );
    }
    return <LoadingScreen label="正在连接电脑…" />;
  }

  if (!session.authenticated) {
    return (
      <LoginPage
        session={session}
        pairingError={pairingError}
        onAuthenticated={() => {
          void refreshSession();
        }}
      />
    );
  }

  if (route.view === 'viewer') {
    return <ViewerPage route={route} onNavigate={go} />;
  }

  return <BrowsePage session={session} route={route} onNavigate={go} onLogout={handleLogout} />;
}
