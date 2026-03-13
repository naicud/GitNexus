#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}GitNexus Analyze${NC}"
echo ""

# Check gitnexus is available
if ! command -v gitnexus &>/dev/null; then
  echo -e "${RED}ERROR: 'gitnexus' not found in PATH.${NC}"
  exit 1
fi

# 1. Folder
DEFAULT_FOLDER="$(pwd)"
echo -e "${DIM}Lascia vuoto per usare la directory corrente${NC}"
read -re -p "Cartella da analizzare [${DEFAULT_FOLDER}]: " FOLDER
FOLDER="${FOLDER:-$DEFAULT_FOLDER}"

if [ ! -d "$FOLDER" ]; then
  echo -e "${RED}ERROR: La cartella '${FOLDER}' non esiste.${NC}"
  exit 1
fi

FOLDER="$(cd "$FOLDER" && pwd)"
echo ""

# 2. Force
read -rp "Forza re-index completo? --force [y/N]: " FORCE_ANSWER
FORCE_FLAG=""
[[ "${FORCE_ANSWER:-}" =~ ^[Yy]$ ]] && FORCE_FLAG="--force"

# 3. Embeddings
read -rp "Abilita embeddings per semantic search? --embeddings [y/N]: " EMBED_ANSWER
EMBED_FLAG=""
[[ "${EMBED_ANSWER:-}" =~ ^[Yy]$ ]] && EMBED_FLAG="--embeddings"

# 4. COBOL dirs
echo ""
echo -e "${DIM}Directory con file COBOL senza estensione, separate da virgola (es. x,g,y,z)${NC}"
read -rp "GITNEXUS_COBOL_DIRS [lascia vuoto se non COBOL]: " COBOL_DIRS

# Setup env for COBOL
if [ -n "${COBOL_DIRS:-}" ]; then
  export GITNEXUS_COBOL_DIRS="$COBOL_DIRS"
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=8192"
fi

# 5. Debug mode
echo ""
read -rp "Abilita modalita' debug? [y/N]: " DEBUG_ANSWER
DEBUG_MODE=false
if [[ "${DEBUG_ANSWER:-}" =~ ^[Yy]$ ]]; then
  DEBUG_MODE=true
  export GITNEXUS_VERBOSE=1
fi

# Build args
ARGS=("$FOLDER")
[ -n "$FORCE_FLAG" ] && ARGS+=("$FORCE_FLAG")
[ -n "$EMBED_FLAG" ] && ARGS+=("$EMBED_FLAG")

# Show command
echo ""
echo -e "${YELLOW}Comando:${NC}"
if [ -n "${COBOL_DIRS:-}" ]; then
  echo -e "  ${CYAN}GITNEXUS_COBOL_DIRS=${COBOL_DIRS} NODE_OPTIONS='--max-old-space-size=8192' gitnexus analyze ${ARGS[*]}${NC}"
else
  echo -e "  ${CYAN}gitnexus analyze ${ARGS[*]}${NC}"
fi

# Print debug info
if [ "$DEBUG_MODE" = true ]; then
  echo ""
  echo -e "${YELLOW}Debug info:${NC}"
  echo -e "  Node:         $(node --version)"
  echo -e "  CPUs:         $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 'unknown')"
  echo -e "  Sub-batch:    ${GITNEXUS_WORKER_TIMEOUT_MS:-120000}ms timeout"
  echo -e "  Startup:      ${GITNEXUS_WORKER_STARTUP_TIMEOUT_MS:-60000}ms timeout"
  if [ -n "${COBOL_DIRS:-}" ]; then
    echo -e "  COBOL dirs:   ${COBOL_DIRS}"
    echo -e "  Sub-batch sz: 200 (COBOL mode)"
  else
    echo -e "  Sub-batch sz: 1500 (default)"
  fi
  echo -e "  VERBOSE:      ${GITNEXUS_VERBOSE:-0}"
fi

echo ""

# Run with timing
START_TIME=$(date +%s)
gitnexus analyze "${ARGS[@]}"
END_TIME=$(date +%s)

ELAPSED=$((END_TIME - START_TIME))
echo ""
echo -e "${GREEN}Completato in ${ELAPSED}s${NC}"
