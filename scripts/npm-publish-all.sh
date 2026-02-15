#!/bin/bash
# Batch publish all remaining @agenium packages to npm
# Usage: ./npm-publish-all.sh [--dry-run]
# Respects npm 429 rate limits by adding delays between publishes

set -euo pipefail

DRY_RUN="${1:-}"
DELAY=15  # seconds between publishes
LOG="/tmp/npm-publish-$(date +%Y%m%d_%H%M%S).log"
SUCCESS=0
FAILED=0
SKIPPED=0

echo "=== npm batch publish $(date -u) ===" | tee "$LOG"

# Local packages in the monorepo
LOCAL_PACKAGES=(
  "/home/ubuntu/agenium|agenium"
  "/home/ubuntu/agenium/packages/create-agenium-agent|create-agenium-agent"
  "/home/ubuntu/agenium/packages/mcp-bridge|@agenium/mcp-server"
)

# GitHub-only packages (clone + publish)
GITHUB_PACKAGES=(
  "discord-agenium-bot"
  "slack-agenium-app"
  "openapi-agent-bridge"
  "shopify-agenium-app"
  "webflow-agenium"
  "whatsapp-agenium-bridge"
  "cloudflare-agent-proxy"
  "n8n-nodes-agenium"
  "zapier-agenium"
  "telegram-agenium-sdk"
  "langchain-agenium"
  "crewai-agenium"
  "openai-agenium-bridge"
  "mcp-agenium-bridge"
  "docker-agent-template"
  "vercel-agent-template"
)

publish_package() {
  local dir="$1"
  local name="$2"
  
  # Check if already published
  local npm_ver
  npm_ver=$(npm view "$name" version 2>/dev/null || echo "NOT_FOUND")
  local local_ver
  local_ver=$(jq -r '.version' "$dir/package.json" 2>/dev/null || echo "0.0.0")
  
  if [ "$npm_ver" = "$local_ver" ]; then
    echo "⏭️  $name@$local_ver — already published" | tee -a "$LOG"
    ((SKIPPED++))
    return 0
  fi
  
  echo "📦 Publishing $name@$local_ver (npm has: $npm_ver)..." | tee -a "$LOG"
  
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "   [DRY RUN] would publish $name" | tee -a "$LOG"
    return 0
  fi
  
  cd "$dir"
  
  # Build if build script exists
  if jq -e '.scripts.build' package.json >/dev/null 2>&1; then
    npm run build 2>&1 | tail -3 | tee -a "$LOG"
  fi
  
  if timeout 30 npm publish --access public 2>&1 | tee -a "$LOG"; then
    echo "✅ $name@$local_ver published!" | tee -a "$LOG"
    ((SUCCESS++))
    sleep "$DELAY"
    return 0
  else
    echo "❌ $name — FAILED (probably 429)" | tee -a "$LOG"
    ((FAILED++))
    return 1
  fi
}

# 1. Publish local packages
echo "" | tee -a "$LOG"
echo "--- Local packages ---" | tee -a "$LOG"
for entry in "${LOCAL_PACKAGES[@]}"; do
  IFS='|' read -r dir name <<< "$entry"
  publish_package "$dir" "$name" || true
done

# 2. Clone and publish GitHub packages
echo "" | tee -a "$LOG"
echo "--- GitHub packages ---" | tee -a "$LOG"
TMPDIR="/tmp/agenium-publish"
mkdir -p "$TMPDIR"

for repo in "${GITHUB_PACKAGES[@]}"; do
  clone_dir="$TMPDIR/$repo"
  if [ ! -d "$clone_dir" ]; then
    git clone --depth 1 "https://github.com/Aganium/$repo.git" "$clone_dir" 2>/dev/null || {
      echo "❌ Failed to clone $repo" | tee -a "$LOG"
      ((FAILED++))
      continue
    }
  fi
  
  if [ -f "$clone_dir/package.json" ]; then
    name=$(jq -r '.name' "$clone_dir/package.json")
    publish_package "$clone_dir" "$name" || true
  else
    echo "⚠️  $repo — no package.json" | tee -a "$LOG"
    ((SKIPPED++))
  fi
done

echo "" | tee -a "$LOG"
echo "=== Results: ✅$SUCCESS published, ❌$FAILED failed, ⏭️$SKIPPED skipped ===" | tee -a "$LOG"
echo "Log: $LOG"
