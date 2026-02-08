#!/bin/bash
# ============================================
# Deploy worker to VPS — run from LOCAL machine
# Usage: bash worker/deploy-to-vps.sh root@YOUR_VPS_IP
# ============================================

set -e

VPS_HOST="$1"
if [ -z "$VPS_HOST" ]; then
  echo "Usage: bash worker/deploy-to-vps.sh root@YOUR_VPS_IP"
  exit 1
fi

echo "=== Deploying to $VPS_HOST ==="

# Create directory on VPS
ssh "$VPS_HOST" "mkdir -p /opt/brand-worker/lib /opt/brand-worker/worker"

# Copy files
echo "Copying lib/ files..."
scp lib/brand-discovery.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/types.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/meta-api.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/url-extractor.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/headless-scraper.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/shopify-detector.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/keyword-generator.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/presell-tracker.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/domain-classifier.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/checkout-detector.ts "$VPS_HOST":/opt/brand-worker/lib/
scp lib/constants.ts "$VPS_HOST":/opt/brand-worker/lib/

echo "Copying worker/ files..."
scp worker/server.ts "$VPS_HOST":/opt/brand-worker/worker/

echo "Copying setup script..."
scp worker/setup-vps.sh "$VPS_HOST":/opt/brand-worker/

echo "Running setup on VPS..."
ssh "$VPS_HOST" "chmod +x /opt/brand-worker/setup-vps.sh && cd /opt/brand-worker && bash setup-vps.sh"

echo ""
echo "=== Deploy complete! ==="
echo ""
echo "Now SSH into the VPS and configure .env:"
echo "  ssh $VPS_HOST"
echo "  nano /opt/brand-worker/.env"
echo ""
echo "Then start the worker:"
echo "  systemctl start brand-worker"
echo "  curl http://localhost:8787/api/health"
