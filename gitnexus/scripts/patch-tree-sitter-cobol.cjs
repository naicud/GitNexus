#!/usr/bin/env node
/**
 * WORKAROUND: tree-sitter-cobol@0.0.1 NAN → NAPI binding conversion
 *
 * Background:
 *   tree-sitter-cobol@0.0.1 ships with NAN-based Node.js bindings (depends on
 *   nan@^2.17.0), but GitNexus uses tree-sitter@^0.21.0 which expects NAPI
 *   bindings. The C parser code (parser.c, scanner.c) is ABI-compatible — only
 *   the Node.js binding layer needs updating.
 *
 * How this workaround works:
 *   1. tree-sitter-cobol's own install may fail or produce an incompatible binding
 *   2. This script runs as part of gitnexus's postinstall
 *   3. It detects the NAN binding by reading binding.cc
 *   4. It replaces binding.cc with NAPI-compatible source
 *   5. It rewrites binding.gyp to use node-addon-api
 *   6. It rebuilds the native binding with node-gyp
 *
 * TODO: Remove this script when tree-sitter-cobol upgrades to NAPI natively.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cobolDir = path.join(__dirname, '..', 'node_modules', 'tree-sitter-cobol');
const bindingCcPath = path.join(cobolDir, 'bindings', 'node', 'binding.cc');
const bindingGypPath = path.join(cobolDir, 'binding.gyp');

try {
  if (!fs.existsSync(cobolDir)) {
    // tree-sitter-cobol not installed (optional dependency) — nothing to do
    process.exit(0);
  }

  let needsRebuild = false;

  // ── Step 1: Check if binding.cc uses NAN ──────────────────────────────
  if (fs.existsSync(bindingCcPath)) {
    const bindingSrc = fs.readFileSync(bindingCcPath, 'utf8');
    if (bindingSrc.includes('nan.h') || bindingSrc.includes('NAN_')) {
      // Replace with NAPI-compatible binding (matches tree-sitter@0.21.0+ format)
      const napiBinding = `#include <napi.h>

typedef struct TSLanguage TSLanguage;

extern "C" TSLanguage *tree_sitter_COBOL();

// "tree-sitter", "language" hashed with BLAKE2
const napi_type_tag LANGUAGE_TYPE_TAG = {
  0x8AF2E5212AD58ABF, 0xD5006CAD83ABBA16
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports["name"] = Napi::String::New(env, "cobol");
  auto language = Napi::External<TSLanguage>::New(env, tree_sitter_COBOL());
  language.TypeTag(&LANGUAGE_TYPE_TAG);
  exports["language"] = language;
  return exports;
}

NODE_API_MODULE(tree_sitter_cobol_binding, Init)
`;
      fs.writeFileSync(bindingCcPath, napiBinding);
      console.log('[tree-sitter-cobol] Patched binding.cc (NAN → NAPI)');
      needsRebuild = true;
    }
  }

  // ── Step 2: Update binding.gyp to use node-addon-api ──────────────────
  if (fs.existsSync(bindingGypPath)) {
    const gypContent = fs.readFileSync(bindingGypPath, 'utf8');
    // Patch if: contains NAN references, OR contains gyp expressions, OR
    // the native binding doesn't exist (previous build may have failed with
    // a bad include path), OR needsRebuild is already set
    const bindingNode = path.join(cobolDir, 'build', 'Release', 'tree_sitter_cobol_binding.node');
    const gypNeedsUpdate = gypContent.includes('nan') ||
      gypContent.includes('<!(node') ||
      !fs.existsSync(bindingNode) ||
      needsRebuild;
    if (gypNeedsUpdate) {
      // Strip Python-style comments before JSON parsing
      const cleaned = gypContent.replace(/#[^\n]*/g, '');
      let gyp;
      try {
        gyp = JSON.parse(cleaned);
      } catch {
        // If JSON parse fails, write a fresh binding.gyp
        gyp = null;
      }

      // Resolve node-addon-api include dir as absolute path to avoid
      // issues with node-gyp running in a different working directory.
      const projectRoot = path.join(__dirname, '..');
      let napiIncludeDir;
      try {
        napiIncludeDir = require('node-addon-api').include_dir;
        if (!path.isAbsolute(napiIncludeDir)) {
          // Resolve relative to project root (where require() found it), not cobolDir
          napiIncludeDir = path.resolve(projectRoot, napiIncludeDir);
        }
      } catch {
        // node-addon-api not found — try resolving from parent node_modules
        const fallback = path.join(projectRoot, 'node_modules', 'node-addon-api');
        if (fs.existsSync(fallback)) {
          napiIncludeDir = fallback;
        } else {
          throw new Error('node-addon-api not found — cannot patch tree-sitter-cobol');
        }
      }

      // Discover source files — always include parser.c, scanner.c if present
      const srcDir = path.join(cobolDir, 'src');
      const sources = ['bindings/node/binding.cc', 'src/parser.c'];
      if (fs.existsSync(path.join(srcDir, 'scanner.c'))) {
        sources.push('src/scanner.c');
      }

      const newGyp = {
        targets: [{
          target_name: 'tree_sitter_cobol_binding',
          include_dirs: [
            'src',
            napiIncludeDir,
          ],
          sources,
          cflags_c: ['-std=c11'],
          defines: ['NAPI_DISABLE_CPP_EXCEPTIONS'],
        }],
      };

      // Preserve any actions-free config from old gyp
      if (gyp?.targets?.[0]) {
        const oldTarget = gyp.targets[0];
        if (oldTarget.cflags) newGyp.targets[0].cflags = oldTarget.cflags;
        if (oldTarget.cflags_cc) newGyp.targets[0].cflags_cc = oldTarget.cflags_cc;
      }

      fs.writeFileSync(bindingGypPath, JSON.stringify(newGyp, null, 2) + '\n');
      console.log('[tree-sitter-cobol] Patched binding.gyp (NAN → node-addon-api)');
      needsRebuild = true;
    }
  }

  // ── Step 3: Ensure index.js uses the right loading pattern ────────────
  const indexJsPath = path.join(cobolDir, 'bindings', 'node', 'index.js');
  if (fs.existsSync(indexJsPath) && needsRebuild) {
    const indexContent = fs.readFileSync(indexJsPath, 'utf8');
    // Some old grammars hardcode the path; ensure fallback via node-gyp-build
    if (!indexContent.includes('node-gyp-build')) {
      const newIndex = `try {
  module.exports = require("../../build/Release/tree_sitter_cobol_binding.node");
} catch (_) {
  try {
    module.exports = require("../../build/Debug/tree_sitter_cobol_binding.node");
  } catch (_) {
    // Fallback to node-gyp-build if prebuilds exist
    try {
      module.exports = require("node-gyp-build")(__dirname);
    } catch (_) {
      module.exports = require("../../build/Release/tree_sitter_cobol_binding.node");
    }
  }
}
`;
      fs.writeFileSync(indexJsPath, newIndex);
      console.log('[tree-sitter-cobol] Patched index.js (added build path fallbacks)');
    }
  }

  // ── Step 4: Rebuild native binding ────────────────────────────────────
  if (!fs.existsSync(path.join(cobolDir, 'build', 'Release', 'tree_sitter_cobol_binding.node'))) {
    needsRebuild = true;
  }

  if (needsRebuild) {
    console.log('[tree-sitter-cobol] Rebuilding native binding...');
    execSync('npx node-gyp rebuild', {
      cwd: cobolDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('[tree-sitter-cobol] Native binding built successfully');
  }
} catch (err) {
  console.warn('[tree-sitter-cobol] Could not build native binding:', err.message);
  console.warn('[tree-sitter-cobol] COBOL language support will be unavailable.');
  console.warn('[tree-sitter-cobol] To retry: cd node_modules/tree-sitter-cobol && npx node-gyp rebuild');
}
