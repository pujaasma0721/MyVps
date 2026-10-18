# DEPLOYMENT — MYVPS Billing & Monitoring (Proxmox VE baremetal host)

Panduan penuh menempatkan aplikasi **langsung di Host OS Proxmox VE** (Debian),
berjalan sebagai user non-root `apps` (Region 4 spesifikasi).

---

## 1. Siapkan Host

```bash
# sesudah instal Node.js >= 20 dari nodesource
node -v
```

```bash
# user sistem terisolasi, home di /opt/myvps (bukan login shell)
sudo useradd --system --home /opt/myvps --shell /usr/sbin/nologin apps
sudo mkdir -p /opt/myvps && sudo chown apps:apps /opt/myvps
```

```bash
# PostgreSQL di host (atau di container lain)
sudo -u postgres createuser apps -P        # beri password
sudo -u postgres createdb myvps -O apps
```

## 2. Taruh Aplikasi

```bash
sudo -u apps git clone <repo-anda> /opt/myvps/app   # atau rsync/upload folder
cd /opt/myvps/app
sudo -u apps npm ci
sudo -u apps npx prisma db push
sudo -u apps node prisma/seed.js     # buat admin + 151 IP + 151 port
```

## 3. DIRECTIVE /etc/sudoers (WAJIB HANYA 4 BINARI)

Dokumentasi konfigurasi `/etc/sudoers` **NOPASSWD** spesifik untuk user `apps`
— jangan pernah beri akses umum. Buat file baru lewat `visudo -f /etc/sudoers.d/myvps-apps`
(VALIDASI WAJIB sebelum keluar editor; salah sintaks = lock-out root):

```text
# /etc/sudoers.d/myvps-apps — compiled by myvps-billing spec Region 4
apps ALL=(root) NOPASSWD: /usr/sbin/nginx
apps ALL=(root) NOPASSWD: /usr/bin/certbot
apps ALL=(root) NOPASSWD: /sbin/iptables
apps ALL=(root) NOPASSWD: /sbin/iptables-save
```

.. apa pun juga bukan. **Tidak ada /bin/sh**, **tidak ada tee**, **tidak ada root-owned folders
yg apps bisa tulis** — vhost Nginx ditulis ke direktori milik `apps`
(`/opt/myvps/nginx-sites/`) dan `nginx.conf` host menyisipkannya via:

```nginx
# blok http{} di /etc/nginx/nginx.conf
include /opt/myvps/nginx-sites/*;
```

## 4. Environment

Salin `.env.example` → `.env` di `/opt/myvps/app`, isikan nyata:
`PUBLIC_IP`, `MAIN_DOMAIN`, `PROXMOX_TOKEN_*`, `SMTP_*`, `SESSION_SECRET` (≥32 karakter acak),
`DATABASE_URL`. **WAJIB `PROXMOX_MOCK=false` di produksi** — kemampuan mock
hanya untuk pengembangan. Pastikan `chmod 600 .env && chown apps:apps .env`.

Token API Proxmox dibuat di GUI PVE: *Datacenter → Permissions → API Tokens*,
user `root@pam` tanpa *privilege separation* (token mewarisi permission root yang
dipakai untuk clone/resize/config/destroy).

## 5. Wildcard Certificate untuk Subdomain Default

```bash
sudo certbot certonly --dns-cloudflare -d "vpsrumah.com" -d "*.vpsrumah.com"
sudo mkdir -p /etc/nginx/certs
sudo ln -sf /etc/letsencrypt/live/vpsrumah.com/fullchain.pem /etc/nginx/certs/wildcard.vpsrumah.com.pem
sudo ln -sf /etc/letsencrypt/live/vpsrumah.com/privkey.pem  /etc/nginx/certs/wildcard.vpsrumah.com.key
```

> wildcard cert untuk `*.{MAIN_DOMAIN}` dipakai vhost subdomain default `{order_id}.MAIN_DOMAIN`
> — checkout baru TIDAK memanggil Let's Encrypt (sesuai spesifikasi).

## 6. systemd unit untuk service `apps`

`/etc/systemd/system/myvps-billing.service`:

```ini
[Unit]
Description=MYVPS Billing & Monitoring
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=apps
Group=apps
WorkingDirectory=/opt/myvps/app
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=false   # butuh sudo untuk 4 binari allowlist
PrivateTmp=true
Environment=NODE_ENV=production
Environment=PORT=3500

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myvps-billing
curl -s http://127.0.0.1:3500/healthz   # -> {"ok":true,...}
```

Rekomendasi reverse proxy Nginx host (subdomain panel, misal billing.vpsrumah.com):

```nginx
server {
  server_name billing.vpsrumah.com;
  location / { proxy_pass http://127.0.0.1:3500; proxy_set_header Host $host; }
  listen 443 ssl;
  ssl_certificate     /etc/nginx/certs/wildcard.vpsrumah.com.pem;
  ssl_certificate_key /etc/nginx/certs/wildcard.vpsrumah.com.key;
}
```

## 7. Konfigurasi Nginx induk & pool jaringan internal

- VM Cloud-Init memakai bridge internal/PVE NAT (umumnya `vmbr1` dengan
  `10.0.0.1` sebagai gateway di host); pastikan `iptables` NAT POSTROUTING
  masquerade sudah ada untuk pool:
  `sudo iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE`
  → simpan juga ke `/etc/iptables/rules.v4` (pakai `iptables-persistent`).
- Template VM **#100** harus up & punya Cloud-Init + OpenSSH + user `ubuntu`.

## 8. Checklist Go-Live

- [ ] `.env` isian nyata, `PROXMOX_MOCK=false`
- [ ] `sudo -u apps curl -s http://127.0.0.1:3500/healthz` balas ok
- [ ] `sudo -u apps sudo -l` hanya menunjukkan 4 binari
- [ ] Checkout 1 order → VM muncul di PVE web UI (`vps-<orderId>`)
- [ ] `ssh ubuntu@PUBLIC_IP -p 10100` dari luar jaringan berfungsi
- [ ] `curl -I http://<orderId>.vpsrumah.com` → 200 dari VPS
- [ ] Reject dari admin = VM hilang + rule iptables lepas + conf vhost lepas + slots AVAILABLE
- [ ] Backup `prisma migrate deploy` + dump `pg_dump` recurring
