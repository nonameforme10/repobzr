# SalesTrack Backend — VPS Deployment Guide

This service provides exchange rates and history proxying for SalesTrack using the Central Bank of Uzbekistan (CBU) API, with in-memory caching, stale fallback, rate limiting, and security headers.

---

## 1. Initial VPS Setup (Ubuntu / Debian)

### 1.1. Update System & Install Essentials
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw certbot python3-certbot-nginx
```

### 1.2. Install Node.js (Version 20 LTS) & PM2
```bash
# Setup NodeSource repository for Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify versions
node -v   # Should be v20.x+
npm -v

# Install PM2 globally
sudo npm install -g pm2
```

---

## 2. Deploying from GitHub to VPS

### 2.1. Clone Repository & Setup
```bash
cd /var/www  # or your home directory, e.g. /home/ubuntu
git clone https://github.com/nonameforme10/repobzr.git
cd repobzr/backend

# Create production .env file
cp .env.example .env
nano .env
```
Ensure `.env` contains:
```env
PORT=5000
NODE_ENV=production
CORS_ORIGIN=https://caretrack.website,https://www.caretrack.website,https://project-7gjuu.vercel.app
RATES_CACHE_TTL_MS=3600000
HISTORY_CACHE_TTL_MS=86400000
FETCH_TIMEOUT_MS=8000
```

### 2.2. Install Dependencies & Start PM2
```bash
# Clean install production dependencies only
npm ci --omit=dev

# Start application using PM2 ecosystem config
pm2 start ecosystem.config.js

# Configure PM2 to start automatically on VPS reboot
pm2 save
pm2 startup
# (Run the sudo env PATH=... command that PM2 prints out)
```

---

## 3. Nginx Reverse Proxy & SSL (HTTPS)

Vercel serves your frontend over HTTPS (`https://project-7gjuu.vercel.app`). For Vercel rewrites and browser requests to work seamlessly, the VPS must serve HTTPS over port 443.

### 3.1. Create Nginx Site Configuration
Point your domain or subdomain (e.g. `api.caretrack.website`) to your VPS IP address in your DNS settings (A record). Then create the Nginx configuration:

```bash
sudo nano /etc/nginx/sites-available/salestrack-backend
```

Paste the following configuration (replace `api.caretrack.website` with your actual domain):

```nginx
server {
    listen 80;
    server_name api.caretrack.website;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts matching backend AbortController
        proxy_connect_timeout 10s;
        proxy_read_timeout 15s;
    }
}
```

Enable the site and verify syntax:
```bash
sudo ln -s /etc/nginx/sites-available/salestrack-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.2. Secure with Free Let's Encrypt SSL
```bash
sudo certbot --nginx -d api.caretrack.website
```
Certbot will automatically obtain the SSL certificate and update Nginx to redirect HTTP to HTTPS.

### 3.3. Configure Firewall (UFW)
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 4. Routine Update Workflow (GitHub Bridge)

Whenever you push backend code changes to GitHub:

```bash
# On your local machine:
git add backend/
git commit -m "update backend"
git push origin main

# On your VPS:
cd /var/www/repobzr/backend
git pull
npm ci --omit=dev
pm2 restart bozor-backend
```

---

## 5. API Reference & Verification

| Method | Endpoint | Description | Headers |
|---|---|---|---|
| `GET` | `/api/health` | Health and uptime status | `status: "ok"` |
| `GET` | `/api/rates` | Today's full CBU rates array | `X-Cache: HIT \| MISS \| STALE` |
| `GET` | `/api/history?ccy=USD&days=30` | Historical rates for currency | `X-Cache: HIT \| MISS \| STALE` |
| `GET` | `/api/getCbuRates` | Backward compatibility alias | Same as `/api/rates` |
| `GET` | `/api/getCbuHistory` | Backward compatibility alias | Same as `/api/history` |
