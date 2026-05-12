import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODES_DIR = path.resolve(__dirname, 'public/nodes');
const VIRTUAL_ID = 'virtual:nodes-index';
const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;

function isImageFile(name) {
  return /\.(jpe?g|png|gif|webp)$/i.test(name);
}

function isTextFile(name) {
  return /\.txt$/i.test(name);
}

/** Audio and other assets live beside nodes; only index images + .txt as graph nodes. */
function shouldSkipListing(name) {
  if (name.startsWith('.')) return true;
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name)) return true;
  return false;
}

function readNodesIndex() {
  if (!fs.existsSync(NODES_DIR)) {
    return { nodeImageFilenames: [], nodeTextFilenames: [] };
  }
  const files = fs.readdirSync(NODES_DIR);
  const nodeImageFilenames = [];
  const nodeTextFilenames = [];
  for (const name of files) {
    if (shouldSkipListing(name)) continue;
    if (isImageFile(name)) nodeImageFilenames.push(name);
    else if (isTextFile(name)) nodeTextFilenames.push(name);
  }
  nodeImageFilenames.sort();
  nodeTextFilenames.sort();
  return { nodeImageFilenames, nodeTextFilenames };
}

function nodesIndexPlugin() {
  return {
    name: 'nodes-index',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      const { nodeImageFilenames, nodeTextFilenames } = readNodesIndex();
      return `export const nodeImageFilenames = ${JSON.stringify(nodeImageFilenames)};\nexport const nodeTextFilenames = ${JSON.stringify(nodeTextFilenames)};\n`;
    },
    configureServer(server) {
      const nodesNorm = normalizePath(NODES_DIR);
      const touch = () => {
        const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
      };
      try {
        server.watcher.add(NODES_DIR);
      } catch {
        /* ignore */
      }
      const nodesPrefix = nodesNorm.endsWith('/') ? nodesNorm : `${nodesNorm}/`;
      server.watcher.on('all', (event, rawPath) => {
        if (!rawPath) return;
        const p = normalizePath(rawPath);
        if (p === nodesNorm || p.startsWith(nodesPrefix)) touch();
      });
    },
  };
}

export default defineConfig({
  plugins: [nodesIndexPlugin()],
});
