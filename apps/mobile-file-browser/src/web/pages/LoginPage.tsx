import { useState, type FormEvent } from 'react';
import type { SessionResponse } from '../../shared/types';
import { ApiError, login } from '../api';
import { CheckIcon, EyeIcon, EyeOffIcon, LockIcon, WifiOffIcon } from '../components/Icons';

interface LoginPageProps {
  session: SessionResponse;
  pairingError: string | null;
  onAuthenticated: () => void;
}

export function LoginPage({ session, pairingError, onAuthenticated }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!password) {
      setError('请输入访问密码');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      onAuthenticated();
    } catch (loginError) {
      setError(loginError instanceof ApiError ? loginError.message : '登录失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  if (!session.passwordConfigured) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand-mark">
            <LockIcon size={26} />
          </div>
          <h1 className="brand-title">手机文件</h1>
          <p className="brand-subtitle">只读浏览电脑上的文件夹和图片</p>
          {pairingError ? (
            <div className="notice notice-error" role="alert">
              <p className="notice-title">配对没有完成</p>
              <p>{pairingError}</p>
            </div>
          ) : session.pairingAvailable ? (
            <div className="notice">
              <p className="notice-title">等待配对</p>
              <p>
                请用手机相机扫描电脑终端上的二维码；配对链接 10 分钟内有效，只能使用一次。
              </p>
            </div>
          ) : (
            <div className="notice notice-warning">
              <p className="notice-title">配对链接已失效</p>
              <p>请在电脑上重新启动服务，获取新的二维码；或先设置访问密码再重新打开页面。</p>
            </div>
          )}
          <p className="login-footnote">
            忘记密码或二维码过期？在电脑上运行
            <code>npm start -- --set-password</code>
            重设访问密码。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-mark">
          <LockIcon size={26} />
        </div>
        <h1 className="brand-title">手机文件</h1>
        <p className="brand-subtitle">
          {session.mode === 'remote' ? '外网访问，请输入访问密码' : '请输入访问密码'}
        </p>

        {pairingError && (
          <div className="notice notice-warning" role="status">
            <p className="notice-title">配对链接已失效</p>
            <p>{pairingError} 你仍然可以使用访问密码登录。</p>
          </div>
        )}

        <label className="field-label" htmlFor="password">
          访问密码
        </label>
        <div className="password-field">
          <input
            id="password"
            name="password"
            type={visible ? 'text' : 'password'}
            className="text-input"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入电脑上设置的访问密码"
            disabled={submitting}
            autoFocus
          />
          <button
            type="button"
            className="icon-button password-toggle"
            aria-label={visible ? '隐藏密码' : '显示密码'}
            onClick={() => setVisible((current) => !current)}
            tabIndex={0}
          >
            {visible ? <EyeOffIcon size={20} /> : <EyeIcon size={20} />}
          </button>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button button-primary button-block" disabled={submitting}>
          {submitting ? <span className="spinner spinner-small" aria-label="正在登录" /> : null}
          {submitting ? '正在进入…' : '进入'}
        </button>

        <p className="login-hint">
          <WifiOffIcon size={16} />
          连续输错会被暂时锁定；忘记密码需要在电脑上重设。
        </p>
        {session.mode !== 'remote' && (
          <p className="login-secondary">
            <CheckIcon size={16} />
            在家也可以扫描终端二维码配对，无需输入密码。
          </p>
        )}
      </form>
    </div>
  );
}
