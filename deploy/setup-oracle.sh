#!/usr/bin/env bash
# One-time setup on an Oracle Cloud "Always Free" Ampere A1 instance running Ubuntu 22.04/24.04.
# Run as the default "ubuntu" user:   bash setup-oracle.sh
set -euo pipefail

echo "== Docker を入れています =="
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "== ファイアウォールで 80 と 443 を開けています =="
# Oracle's Ubuntu images reject everything except SSH in iptables. The VCN security list
# must ALSO allow 80 and 443 (see README).
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
sudo apt-get install -y netfilter-persistent iptables-persistent >/dev/null
sudo netfilter-persistent save

echo "== Orbit を取ってきています =="
if [ ! -d "$HOME/orbit" ]; then
  git clone https://github.com/zenhansha/risuka "$HOME/orbit"
fi
cd "$HOME/orbit/deploy"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^ORBIT_SECRET=$/ORBIT_SECRET=$(openssl rand -hex 32)/" .env
  echo
  echo "deploy/.env を作りました(ORBIT_SECRET は自動で入れてあります)。"
  echo "次に ORBIT_DOMAIN、ORBIT_PUBLIC_URL、ORBIT_OWNER_EMAIL、RESEND_API_KEY を入れてください:"
  echo "    nano $HOME/orbit/deploy/.env"
  echo "入れたら、これで起動します:"
  echo "    cd $HOME/orbit/deploy && sudo docker compose up -d --build"
  exit 0
fi

sudo docker compose up -d --build
echo "Orbit を起動しています。ようすを見るには:  sudo docker compose logs -f orbit"
