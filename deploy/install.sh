#!/usr/bin/env bash
set -euo pipefail
APP=/home/ubuntu/mibombochat
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sudo apt update
sudo apt install -y build-essential nginx
sudo mkdir -p "$APP"
sudo cp -r "$SCRIPT_DIR"/* "$APP"/
sudo chown -R ubuntu:ubuntu "$APP"
cd "$APP"
npm install --omit=dev
sudo cp deploy/mibombo.service /etc/systemd/system/mibombo.service
sudo cp deploy/nginx-mibombo.conf /etc/nginx/sites-available/default
sudo systemctl daemon-reload
sudo systemctl enable --now mibombo
sudo nginx -t
sudo systemctl reload nginx

echo "Mi Bombo instalado. Comprueba: sudo systemctl status mibombo"
