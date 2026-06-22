import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, ASSET_PATHS } from '../config/unityPaths';

interface SimplifiedRefNode {
  name: string;
  type: string;
  componentRef?: string;
  children?: SimplifiedRefNode[];
}

const _refCache = new Map<string, SimplifiedRefNode | null>();

function inferType(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('btn_')) return 'button';
  if (n.startsWith('txt_') || n.startsWith('text_') || n.startsWith('i#')) return 'text';
  if (n.startsWith('img_')) return 'image';
  if (n.startsWith('part_') || n.startsWith('@')) return 'component';
  if (n.startsWith('scroll') || n.startsWith('looplist')) return 'scrollview';
  return 'frame';
}

function inferComponentRef(name: string): string | undefined {
  const m = name.match(/^@?(Part_\w+)/i);
  return m ? m[1] : undefined;
}

interface TransformInfo {
  goId: string;
  children: string[];
  fatherId: string;
}

function parsePrefabMinimal(content: string): {
  gameObjects: Map<string, string>;
  transforms: Map<string, TransformInfo>;
} {
  const gameObjects = new Map<string, string>();
  const transforms = new Map<string, TransformInfo>();

  const docs = content.split(/^---\s/m);
  for (const doc of docs) {
    const goMatch = doc.match(/!u!1\s+&(\d+)\n[\s\S]*?m_Name:\s*(.+)/);
    if (goMatch) {
      gameObjects.set(goMatch[1], goMatch[2].trim());
    }

    const rtMatch = doc.match(/!u!224\s+&(\d+)\n[\s\S]*?m_GameObject:\s*\{fileID:\s*(\d+)\}[\s\S]*?m_Children:\s*([\s\S]*?)m_Father:\s*\{fileID:\s*(\d+)\}/);
    if (rtMatch) {
      const children: string[] = [];
      for (const cm of rtMatch[3].matchAll(/fileID:\s*(\d+)/g)) {
        children.push(cm[1]);
      }
      transforms.set(rtMatch[1], { goId: rtMatch[2], children, fatherId: rtMatch[4] });
    }
  }

  return { gameObjects, transforms };
}

function buildSimplifiedTree(
  gameObjects: Map<string, string>,
  transforms: Map<string, TransformInfo>,
  prefabRelPath: string,
): SimplifiedRefNode | null {
  let nodeCount = 0;
  const MAX_NODES = 200;
  const MAX_DEPTH = 8;

  function walk(tId: string, depth: number): SimplifiedRefNode | null {
    if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
    nodeCount++;

    const t = transforms.get(tId);
    if (!t) return null;
    const name = gameObjects.get(t.goId);
    if (!name) return null;

    const result: SimplifiedRefNode = { name, type: inferType(name) };
    const compRef = inferComponentRef(name);
    if (compRef) result.componentRef = compRef;

    if (t.children.length > 0) {
      const children: SimplifiedRefNode[] = [];
      for (const cId of t.children) {
        const child = walk(cId, depth + 1);
        if (child) children.push(child);
      }
      if (children.length > 0) result.children = children;
    }

    return result;
  }

  for (const [tId, t] of transforms) {
    if (t.fatherId === '0') {
      const result = walk(tId, 0);
      if (nodeCount >= MAX_NODES) {
        console.warn(`[prefabRefLoader] Prefab tree truncated at ${MAX_NODES} nodes: ${prefabRelPath}`);
      }
      return result;
    }
  }

  return null;
}

export function loadPrefabAsRefStructure(prefabRelPath: string): SimplifiedRefNode | null {
  if (_refCache.has(prefabRelPath)) {
    return _refCache.get(prefabRelPath)!;
  }

  try {
    const prefabPath = path.join(PROJECT_ROOT, ASSET_PATHS.prefab, prefabRelPath);
    if (!fs.existsSync(prefabPath)) {
      console.warn(`[prefabRefLoader] Prefab not found: ${prefabPath}`);
      _refCache.set(prefabRelPath, null);
      return null;
    }

    const content = fs.readFileSync(prefabPath, 'utf-8');
    const { gameObjects, transforms } = parsePrefabMinimal(content);
    const tree = buildSimplifiedTree(gameObjects, transforms, prefabRelPath);

    _refCache.set(prefabRelPath, tree);
    return tree;
  } catch (e) {
    console.error(`[prefabRefLoader] Failed to load ${prefabRelPath}:`, e);
    _refCache.set(prefabRelPath, null);
    return null;
  }
}
