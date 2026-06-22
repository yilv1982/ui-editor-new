import { useState, useEffect, useCallback, useRef } from 'react';
import { startCustomDrag } from '../../utils/customDrag';
import { useEditorStore } from '../../stores/editorStore';

interface AtlasImage {
  name: string;
  category?: string;
  path: string;
  sliceBorder?: { left: number; right: number; top: number; bottom: number };
}

function parseCategoryFromPath(imgPath: string): string {
  if (imgPath.startsWith('/texture-file/')) return '_Texture';
  const stripped = imgPath
    .replace(/^\/atlas-file\//, '')
    .replace(/^Assets\/HotRes\/UI\/Atlas\//, '');
  const firstSlash = stripped.indexOf('/');
  return firstSlash > 0 ? stripped.substring(0, firstSlash) : '';
}

export default function AtlasLibrary() {
  const [categories, setCategories] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<AtlasImage[]>([]);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const pendingLocate = useRef<string | null>(null);

  const locateImagePath = useEditorStore((s) => s.locateImagePath);
  const setLocateImagePath = useEditorStore((s) => s.setLocateImagePath);

  useEffect(() => {
    fetch('/api/atlas/categories')
      .then((r) => r.json())
      .then((dirs: string[]) => setCategories(dirs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeCategory) { setImages([]); return; }
    setLoading(true);
    fetch(`/api/atlas/images?category=${encodeURIComponent(activeCategory)}`)
      .then((r) => r.json())
      .then((imgs: AtlasImage[]) => {
        setImages(imgs);
        // 图片加载完成后，执行待定的定位滚动
        if (pendingLocate.current) {
          const target = pendingLocate.current;
          pendingLocate.current = null;
          requestAnimationFrame(() => {
            const el = document.querySelector(`[data-img-path="${CSS.escape(target)}"]`);
            if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          });
        }
      })
      .catch(() => setImages([]))
      .finally(() => setLoading(false));
  }, [activeCategory]);

  // 定位图片
  useEffect(() => {
    if (!locateImagePath) return;
    const target = locateImagePath;
    setLocateImagePath(null);
    setSearch('');

    const category = parseCategoryFromPath(target);
    if (!category) return;

    setExpandedDirs((prev) => new Set(prev).add(category));
    setHighlightPath(target);

    if (category === activeCategory) {
      // 同分类：图片已加载，直接滚动
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-img-path="${CSS.escape(target)}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    } else {
      // 不同分类：切换分类，由 images fetch 回调滚动
      setActiveCategory(category);
      pendingLocate.current = target;
    }

    setTimeout(() => setHighlightPath((cur) => cur === target ? null : cur), 3000);
  }, [locateImagePath, setLocateImagePath, activeCategory]);

  const handleSearch = useCallback((q: string) => {
    setSearch(q);
    clearTimeout(searchTimer.current);
    if (q.length < 2) { if (!activeCategory) setImages([]); return; }
    searchTimer.current = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/atlas/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((results: AtlasImage[]) => setImages(results))
        .catch(() => setImages([]))
        .finally(() => setLoading(false));
    }, 300);
  }, [activeCategory]);

  const handleDragStart = (e: React.MouseEvent, img: AtlasImage) => {
    startCustomDrag(e, 'application/atlas-image', img,
      `<img src="${img.path}" style="width:20px;height:20px;object-fit:contain" /><span>${img.name}</span>`);
  };

  const toggleDir = (dir: string) => {
    const next = new Set(expandedDirs);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    setExpandedDirs(next);
    if (!expandedDirs.has(dir)) setActiveCategory(dir);
  };

  // 搜索模式：平铺显示结果
  if (search.length >= 2) {
    return (
      <div className="flex flex-col h-full bg-[#1e1e2e]">
        <div className="px-3 py-2">
          <input type="text" placeholder="搜索图片..." value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full text-sm px-2 py-1.5 bg-[#313244] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]" />
        </div>
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          {loading && <div className="text-center text-[#6c7086] text-sm mt-4">搜索中...</div>}
          {images.map((img) => (
            <ImageRow key={img.path} img={img} onDragStart={handleDragStart} highlight={img.path === highlightPath} />
          ))}
          {!loading && images.length === 0 && <div className="text-center text-[#6c7086] text-sm mt-4">未找到</div>}
        </div>
      </div>
    );
  }

  // 文件夹树模式
  return (
    <div className="flex flex-col h-full bg-[#1e1e2e]">
      <div className="px-3 py-2">
        <input type="text" placeholder="搜索图片..." value={search}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full text-sm px-2 py-1.5 bg-[#313244] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]" />
      </div>
      <div className="flex-1 overflow-y-auto pb-2">
        {categories.map((dir) => {
          const isExpanded = expandedDirs.has(dir);
          const isActive = activeCategory === dir;
          return (
            <div key={dir}>
              <button
                onClick={() => toggleDir(dir)}
                className={`w-full flex items-center gap-1.5 py-1 text-left hover:bg-[#313244] transition-colors ${isActive ? 'bg-[#313244]' : ''}`}
                style={{ paddingLeft: 8 }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0" style={{ color: '#6c7086' }}>
                  {isExpanded ? <path d="M1 3.5L5 7.5L9 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> : <path d="M3.5 1L7.5 5L3.5 9" stroke="currentColor" strokeWidth="1.5" fill="none" />}
                </svg>
                <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" style={{ color: '#89b4fa' }}>
                  <path fill="currentColor" d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V5a1.5 1.5 0 00-1.5-1.5H7.71l-1-1A1 1 0 006 2H1.5z" />
                </svg>
                <span className="text-sm text-[#cdd6f4] truncate flex-1">{dir}</span>
              </button>
              {isExpanded && (
                <div style={{ paddingLeft: 12 }} className="border-l border-[#45475a] ml-[14px]">
                  {loading && isActive && <div className="text-[12px] text-[#6c7086] px-4 py-1">加载中...</div>}
                  {isActive && images.map((img) => (
                    <ImageRow key={img.path} img={img} onDragStart={handleDragStart} indent highlight={img.path === highlightPath} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImageRow({ img, onDragStart, indent, highlight }: {
  img: AtlasImage;
  onDragStart: (e: React.MouseEvent, img: AtlasImage) => void;
  indent?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      data-img-path={img.path}
      onMouseDown={(e) => onDragStart(e, img)}
      className={`flex items-center gap-2 py-0.5 hover:bg-[#45475a] cursor-grab active:cursor-grabbing transition-colors rounded ${highlight ? 'bg-[#89b4fa]/20 ring-1 ring-[#89b4fa]' : ''}`}
      style={{ paddingLeft: indent ? 8 : 12 }}
      title={`${img.name}${img.sliceBorder ? `\n九宫格: L${img.sliceBorder.left} R${img.sliceBorder.right} T${img.sliceBorder.top} B${img.sliceBorder.bottom}` : ''}\n拖拽到画布`}
    >
      <div className="w-6 h-6 shrink-0 bg-[#181825] rounded flex items-center justify-center overflow-hidden relative">
        <img src={img.path} alt="" className="max-w-full max-h-full object-contain" loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        {img.sliceBorder && (
          <span className="absolute -top-0.5 -right-0.5 text-[6px] bg-[#f5c2e7] text-[#1e1e2e] w-2.5 h-2.5 rounded-full flex items-center justify-center font-bold leading-none">9</span>
        )}
      </div>
      <span className="text-[13px] text-[#a6adc8] truncate flex-1">{img.name}</span>
    </div>
  );
}
