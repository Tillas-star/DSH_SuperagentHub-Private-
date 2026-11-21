import { useState } from 'react';
import type { Entry } from '../../shared/types';
import { ImageIcon } from './Icons';

interface ThumbnailProps {
  entry: Entry;
  onOpen: () => void;
}

export function Thumbnail({ entry, onOpen }: ThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const showImage = Boolean(entry.thumbUrl) && !failed;

  return (
    <button
      type="button"
      className="thumb"
      onClick={onOpen}
      aria-label={`查看图片 ${entry.name}`}
      title={entry.name}
    >
      <span className={showImage ? 'thumb-frame' : 'thumb-frame thumb-placeholder'}>
        {showImage ? (
          <>
            <img
              src={entry.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className={loaded ? 'thumb-image is-loaded' : 'thumb-image'}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
            {!loaded && <ImageIcon size={22} className="thumb-fallback-icon" />}
          </>
        ) : (
          <ImageIcon size={22} className="thumb-fallback-icon" />
        )}
      </span>
    </button>
  );
}
