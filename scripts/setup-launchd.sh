#!/bin/bash
# Man.Ai.ger を macOS の launchd に常駐登録する (requirements.md §3)。
# 実行: bash scripts/setup-launchd.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.manaiger.daemon.plist"
NODE_PATH="$(command -v node || true)"
CODEX_PATH="$(command -v codex || true)"
LOG_DIR="${MANAIGER_HOME:-$HOME/.manaiger}"

if [ -z "$NODE_PATH" ]; then echo "❌ node が見つかりません"; exit 1; fi
if [ -z "$CODEX_PATH" ]; then echo "❌ codex CLI が見つかりません (Codex App Server を利用できる状態にしてください)"; exit 1; fi
NODE_MAJOR="$("$NODE_PATH" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "22" ]; then
  echo "❌ Node.js 22 が必要です。現在: $("$NODE_PATH" -v)"
  echo "   nvm use && pnpm install の後にもう一度実行してください"
  exit 1
fi
if [ ! -f "$REPO_DIR/dist/cli.js" ]; then
  echo "→ ビルドします (pnpm build)"
  (cd "$REPO_DIR" && pnpm build)
fi
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.manaiger.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${REPO_DIR}/dist/cli.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MANAIGER_CODEX_PATH</key><string>${CODEX_PATH}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/launchd.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/launchd.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 常駐登録しました: $PLIST"
echo "   状態確認: launchctl list | grep manaiger"
echo "   解除:     launchctl unload $PLIST"
