#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

BACKEND_PORT=4747
FRONTEND_PORT=5173
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM

wait_for_port() {
  local port=$1
  local label=$2
  local max=30
  local i=0
  echo -ne "${YELLOW}Waiting for ${label}...${NC}"
  while ! nc -z localhost "$port" 2>/dev/null; do
    i=$((i + 1))
    if [ $i -ge $max ]; then
      echo ""
      echo -e "${RED}ERROR: ${label} did not start within ${max}s (port ${port})${NC}"
      cleanup
    fi
    echo -n "."
    sleep 1
  done
  echo -e " ${GREEN}ready${NC}"
}

echo -e "${CYAN}${BOLD}GitNexus Web${NC}"
echo ""

# Check gitnexus is available
if ! command -v gitnexus &>/dev/null; then
  echo -e "${RED}ERROR: 'gitnexus' not found in PATH.${NC}"
  echo "Run: npm install -g ${SCRIPT_DIR}/gitnexus"
  exit 1
fi

# Install frontend deps if missing
if [ ! -d "${SCRIPT_DIR}/gitnexus-web/node_modules" ]; then
  echo -e "${YELLOW}Installing frontend dependencies...${NC}"
  (cd "${SCRIPT_DIR}/gitnexus-web" && npm install)
fi

# Start backend
echo -e "Starting backend on port ${BACKEND_PORT}..."
gitnexus serve --port "$BACKEND_PORT" &
BACKEND_PID=$!

# Start frontend
echo -e "Starting frontend on port ${FRONTEND_PORT}..."
(cd "${SCRIPT_DIR}/gitnexus-web" && npm run dev) &
FRONTEND_PID=$!

echo ""

# Wait for both ports
wait_for_port "$BACKEND_PORT" "backend"
wait_for_port "$FRONTEND_PORT" "frontend"

echo ""
echo -e "${GREEN}${BOLD}GitNexus is running!${NC}"
echo -e "  Backend:   ${CYAN}http://localhost:${BACKEND_PORT}${NC}"
echo -e "  Frontend:  ${CYAN}http://localhost:${FRONTEND_PORT}${NC}"
echo ""
echo "Press Ctrl+C to stop."
echo ""

# Open browser
open "http://localhost:${FRONTEND_PORT}" 2>/dev/null \
  || xdg-open "http://localhost:${FRONTEND_PORT}" 2>/dev/null \
  || true

wait
