# MYVPS — Automated Home-Lab VPS Billing & Monitoring on Proxmox VE

Sistem otomasi penagihan + provisioning + monitoring VPS yang berjalan **langsung
di Host OS Proxmox VE** (Debian baremetal). Dibangun dengan **Node.js (Express) +
PostgreSQL (Prisma ORM) + EJS**, theme UI meng-clone SayOne-Learning.

## Arsitektur

```
User checkout (bukti QRIS via multer)
        │
        ▼
[cek RAM host → SERVER_FULL guard]
        │
        ▼
allocateIpAndPort()  ← transaksi Prisma + SELECT ... FOR UPDATE
  (pool 10.0.0.100–250, port 10100–10250)
        │
        ▼
clone template VM #100 → polling UPID (5s)
  → resize scsi0 → polling UPID
  → cloud-init (ciuser=ubuntu, ipconfig0=ip=10.0.0.x/24,gw=10.0.0.1)
  → start VM
        │
        ▼
iptables -t nat -A PREROUTING --dport {port} → {ip}:22 (comment vps-{orderId})
iptables-save > /etc/iptables/rules.v4
        │
        ▼
nginx vhost {orderId}.MAIN_DOMAIN → proxy_pass http://{ip}:80
(wildcard cert — tanpa certbot untuk subdomain default)
        │
        ▼
Email kredensial (Nodemailer)
```

Admin dapat **CANCEL/REJECT PERMANENT ⚛** yang melepas SEMUA-nya secara graceful
(tiap langkah try-catch terisolasi): stop+destroy VM → hapus rule iptables
(match argumen penuh, bukan line number) → certbot delete + hapus vhost (custom
domain) atau cukup hapus vhost subdomain → order REJECTED + slots AVAILABLE.

## Struktur

```
server.js                     HTTP entry (Express, helmet, session, EJS)
prisma/schema.prisma          skema lengkap (User/Order/OrderVps/pool/Invoice/Revenue)
prisma/seed.js                seed admin + 4 paket + 151 IP + 151 port
src/config/                   constants tetap (node 'pve', template 100, pool, dsb.)
src/lib/proxmox.js            API client PVE + UPID polling
src/lib/shell.js              sudo allowlist: nginx / certbot / iptables / iptables-save
src/lib/email.js              Nodemailer (demo: file inbox)
src/lib/multer.js             unggahan bukti QRIS (png/jpg/webp ≤2MB)
src/services/resources.js     alokasi slot transaksional (anti-duplikasi)
src/services/provisioning.js  pipeline checkout instan
src/services/nucleus.js       rollback total (REGION 3.2)
src/services/monitoring.js    host health + VM live status
src/services/finance.js       verifikasi invoice + pembukuan pendapatan bulanan
src/routes/{public,client,admin}.js
src/views/                    EJS pages (theme SayOne-Learning, light+dark)
src/mock/                     PROXMOX_MOCK=true: simulator PVE + perekam shell
public/css/theme.css          palet SayOne-Learning lengkap
DEPLOYMENT.md                 panduan produksi (sudoers, systemd, wildcard cert)
```

## Menjalankan lokal (DEMO MODE)

```bash
npm ci
npx prisma db push
node prisma/seed.js
npm start          # http://localhost:3500
```

Dengan `PROXMOX_MOCK=true` (file `.env`), seluruh Proxmox API disimulasikan
(clone/start bisa di-polling sungguhan lewat UPID palsu 2 detik), perintah
`sudo` dicatat di `outputs/mock/shell-history.jsonl`, dan email masuk ke
`outputs/mock/inbox.jsonl`.

Login admin: dari `.env` (default seed pertama: email & password ikut
`ADMIN_EMAIL`, `ADMIN_PASSWORD`).

## MOTION produksi

Lihat [DEPLOYMENT.md](DEPLOYMENT.md).
