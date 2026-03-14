#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/gitnexus"

echo "Building gitnexus..."
npm run build

echo "Done. $(gitnexus --version 2>/dev/null || echo 'gitnexus built')"
