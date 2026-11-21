import type { Breadcrumb as Crumb } from '../../shared/types';
import { ChevronRightIcon } from './Icons';

interface BreadcrumbProps {
  items: Crumb[];
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ items, onNavigate }: BreadcrumbProps) {
  if (items.length <= 1) return null;
  return (
    <nav className="breadcrumb" aria-label="当前位置">
      <ol>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.path}-${item.name}`}>
              {index > 0 && <ChevronRightIcon size={14} className="breadcrumb-sep" />}
              {last ? (
                <span className="breadcrumb-current" aria-current="page">
                  {item.name}
                </span>
              ) : (
                <button type="button" className="breadcrumb-link" onClick={() => onNavigate(item.path)}>
                  {item.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
