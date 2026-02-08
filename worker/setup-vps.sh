#!/bin/bash
# ============================================
# Brand Discovery Worker — VPS Setup Script
# Run this on a fresh Ubuntu 24.04 server
# ============================================

set -e

echo "=== Installing Deno ==="
curl -fsSL https://deno.land/install.sh | sh
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc

echo "=== Deno version ==="
deno --version

echo "=== Creating worker directory ==="
mkdir -p /opt/brand-worker

echo "=== Creating environment file ==="
cat > /opt/brand-worker/.env << 'ENVEOF'
# Fill in your values:
META_ACCESS_TOKEN=YOUR_META_TOKEN
SCRAPINGBEE_API_KEY=YOUR_SCRAPINGBEE_KEY
OPENAI_API_KEY=YOUR_OPENAI_KEY
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_KEY
WORKER_API_SECRET=YOUR_SECRET_HERE
PORT=8787
ENVEOF

echo "=== Creating systemd service ==="
cat > /etc/systemd/system/brand-worker.service << 'SVCEOF'
[Unit]
Description=Brand Discovery Worker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/brand-worker
EnvironmentFile=/opt/brand-worker/.env
ExecStart=/root/.deno/bin/deno run --allow-net --allow-env --allow-read worker/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "1. Copy your project files to /opt/brand-worker/"
echo "   scp -r lib/ worker/ /opt/brand-worker/"
echo ""
echo "2. Edit /opt/brand-worker/.env with your real API keys"
echo "   nano /opt/brand-worker/.env"
echo ""
echo "3. Start the worker:"
echo "   systemctl daemon-reload"
echo "   systemctl enable brand-worker"
echo "   systemctl start brand-worker"
echo ""
echo "4. Check status:"
echo "   systemctl status brand-worker"
echo "   journalctl -u brand-worker -f"
echo ""
echo "5. Test health:"
echo "   curl http://localhost:8787/api/health"
