import type { AccessMode, RootInfo } from '../../shared/types';
import { CheckIcon, CloseIcon, FolderIcon, LogoutIcon } from './Icons';

interface RootSheetProps {
  roots: RootInfo[];
  currentRootId?: string;
  mode: AccessMode;
  onSelect: (rootId: string) => void;
  onClose: () => void;
  onLogout: () => void;
}

const MODE_LABEL: Record<AccessMode, string> = {
  local: '本机访问',
  lan: '同一局域网',
  remote: '外网隧道',
};

export function RootSheet({
  roots,
  currentRootId,
  mode,
  onSelect,
  onClose,
  onLogout,
}: RootSheetProps) {
  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="切换根目录"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-header">
          <div>
            <h2>切换根目录</h2>
            <p className="sheet-subtitle">{MODE_LABEL[mode]}</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <ul className="root-list">
          {roots.map((root) => {
            const active = root.id === currentRootId;
            return (
              <li key={root.id}>
                <button
                  type="button"
                  className={active ? 'root-item is-active' : 'root-item'}
                  onClick={() => onSelect(root.id)}
                >
                  <span className="root-icon">
                    <FolderIcon size={20} />
                  </span>
                  <span className="root-name">{root.name}</span>
                  {active && <CheckIcon size={20} className="root-check" />}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="button button-ghost logout-button" onClick={onLogout}>
          <LogoutIcon size={18} />
          退出登录
        </button>
        <p className="sheet-footnote">只读浏览，不会修改电脑上的任何文件。</p>
      </div>
    </div>
  );
}
