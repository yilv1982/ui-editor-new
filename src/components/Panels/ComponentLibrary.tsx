import { useState, useMemo, useEffect } from 'react';
import { componentDefs, categories } from '../../data/componentDefs';
import { startCustomDrag } from '../../utils/customDrag';
import { PrefabThumbnail } from './PrefabThumbnail';

export default function ComponentLibrary() {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('全部');
  const [projectComponents, setProjectComponents] = useState<typeof componentDefs>([]);

  useEffect(() => {
    fetch('/api/components/list')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.components) && data.components.length > 0) {
          setProjectComponents(data.components);
        }
      })
      .catch(() => {});
  }, []);

  const activeComponents = projectComponents.length > 0 ? projectComponents : componentDefs;

  const allCategories = useMemo(() => {
    const projectCategories = [...new Set(activeComponents.map((c) => c.category))];
    return ['全部', ...(projectCategories.length > 0 ? projectCategories : categories)];
  }, [activeComponents]);

  const filtered = useMemo(() => {
    return activeComponents.filter((c) => {
      const matchSearch = !search ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.displayName.includes(search);
      const matchCategory = activeCategory === '全部' || c.category === activeCategory;
      return matchSearch && matchCategory;
    });
  }, [activeComponents, search, activeCategory]);

  const handleDragStart = (e: React.MouseEvent, comp: typeof componentDefs[0]) => {
    startCustomDrag(e, 'application/component', comp,
      `<img src="${comp.thumbnail}" style="width:20px;height:20px;object-fit:contain" /><span>${comp.displayName}</span>`);
  };

  return (
    <div className="w-56 bg-[#1e1e2e] border-r border-[#313244] flex flex-col h-full">
      {/* 标题 */}
      <div className="px-3 py-2 border-b border-[#313244]">
        <h3 className="text-sm font-medium text-[#cdd6f4]">组件库</h3>
      </div>

      {/* 搜索 */}
      <div className="px-3 py-2">
        <input
          type="text"
          placeholder="搜索组件..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-sm px-2 py-1.5 bg-[#313244] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]"
        />
      </div>

      {/* 分类标签 */}
      <div className="px-3 py-1 flex flex-wrap gap-1">
        {allCategories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`text-[12px] px-2 py-0.5 rounded-full ${
              activeCategory === cat
                ? 'bg-[#89b4fa] text-[#1e1e2e]'
                : 'bg-[#313244] text-[#a6adc8] hover:bg-[#45475a]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* 组件网格 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((comp) => (
            <div
              key={comp.name}
              onMouseDown={(e) => handleDragStart(e, comp)}
              className="flex flex-col items-center p-2 rounded bg-[#313244] hover:bg-[#45475a] cursor-grab active:cursor-grabbing transition-colors"
              title={`${comp.displayName}\n拖拽到画布添加`}
            >
              <div className="w-full aspect-square bg-[#1e1e2e] rounded mb-1 flex items-center justify-center overflow-hidden">
                {comp.relPath ? (
                  <PrefabThumbnail
                    relPath={comp.relPath}
                    alt={comp.displayName}
                    size="fill"
                    variant="content"
                    hoverPreview={false}
                    className="w-full h-full rounded-none bg-[#1e1e2e]"
                  />
                ) : (
                  <img
                    src={comp.thumbnail}
                    alt={comp.displayName}
                    className="max-w-full max-h-full object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
              </div>
              <span className="text-[12px] text-[#a6adc8] text-center truncate w-full">
                {comp.displayName}
              </span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="text-center text-[#6c7086] text-sm mt-8">
            未找到组件
          </div>
        )}
      </div>
    </div>
  );
}
