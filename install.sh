#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="memory-viking-local"
HOME_DIR="${HOME:-$USERPROFILE}"
OPENCLAW_DIR="${HOME_DIR}/.openclaw"
PLUGIN_DEST="${OPENCLAW_DIR}/extensions/${PLUGIN_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[ERROR] openclaw not found. Install first: npm install -g openclaw"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found. Install Node.js >= 22"
  exit 1
fi

echo "[INFO] Installing ${PLUGIN_ID} to ${PLUGIN_DEST}"
mkdir -p "${PLUGIN_DEST}"

FILES=(
  "index.ts"
  "plugin.ts"
  "config.ts"
  "openclaw.plugin.json"
  "package.json"
  ".gitignore"
  "README.md"
  "README.en.md"
)

for f in "${FILES[@]}"; do
  if [[ -f "${SCRIPT_DIR}/${f}" ]]; then
    cp "${SCRIPT_DIR}/${f}" "${PLUGIN_DEST}/${f}"
  fi
done

if [[ -f "${SCRIPT_DIR}/package-lock.json" ]]; then
  cp "${SCRIPT_DIR}/package-lock.json" "${PLUGIN_DEST}/package-lock.json"
fi

DIRS=(
  "core"
  "services"
  "stores"
  "cli"
  "setup-helper"
  "deploy"
)

for d in "${DIRS[@]}"; do
  if [[ -d "${SCRIPT_DIR}/${d}" ]]; then
    rm -rf "${PLUGIN_DEST}/${d}"
    cp -R "${SCRIPT_DIR}/${d}" "${PLUGIN_DEST}/${d}"
  fi
done

(
  cd "${PLUGIN_DEST}"
  npm install --omit=dev
)

LOCAL_BIN_DIR="${HOME_DIR}/.local/bin"
VK_MEMORY_WRAPPER="${LOCAL_BIN_DIR}/vk-memory"
mkdir -p "${LOCAL_BIN_DIR}"
cat >"${VK_MEMORY_WRAPPER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
node "${PLUGIN_DEST}/cli/vk-memory.js" "\$@"
EOF
chmod +x "${VK_MEMORY_WRAPPER}"

echo "[INFO] Configuring OpenClaw memory slot"
openclaw config set plugins.enabled true
openclaw config set plugins.slots.memory "${PLUGIN_ID}"
openclaw config set "plugins.entries.${PLUGIN_ID}.config.envConfigPath" "~/.viking-memory/plugin.env.json"
openclaw config set "plugins.entries.${PLUGIN_ID}.config.rootDir" "~/.viking-memory"
openclaw config set "plugins.entries.${PLUGIN_ID}.config.recallLimit" 6
openclaw config set "plugins.entries.${PLUGIN_ID}.config.recallScoreThreshold" 0.12
openclaw config set "plugins.entries.${PLUGIN_ID}.config.timelineRecallLimit" 4
openclaw config set "plugins.entries.${PLUGIN_ID}.config.timelineScoreThreshold" 0.08

if [[ ":${PATH}:" != *":${LOCAL_BIN_DIR}:"* ]]; then
  echo "[WARN] ${LOCAL_BIN_DIR} is not in PATH."
  echo "[WARN] Add this line to your shell profile:"
  echo "       export PATH=\"${LOCAL_BIN_DIR}:\$PATH\""
fi

echo "[OK] Install completed."
echo "[INFO] Use vk-memory commands:"
echo "       vk-memory setup | config | start | stop | status"
echo "[INFO] First run: vk-memory setup && vk-memory start"
echo "[INFO] Then run: openclaw gateway"
