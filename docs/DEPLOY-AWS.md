# Deploying HotelPOS on AWS

This guide puts HotelPOS online with one **EC2** server running Node.js behind **Nginx**, and the database on **Amazon RDS for MySQL**. That is the simplest setup that matches how the app is built:

- uploads go to local disk;
- the API rate limit is kept in memory;
- one process runs the event dispatcher.

It suits a single property and a capstone demo.

```
 Browser / POS tablet ──HTTPS──▶ EC2 (Ubuntu)                      RDS MySQL 8.4
                                  Nginx :443 ──▶ Node :3000 ──3306──▶ (private, only the EC2
                                  certbot (Let's Encrypt)              security group may connect)
```

Region: **Asia Pacific (Singapore) `ap-southeast-1`** is the closest to the Philippines.

---

## 0. Before you start

- An AWS account. Under **Billing and Cost Management**, open **Budgets** and create a monthly cost budget, for example USD 10, with an email alert. New accounts get free-tier credits; check what is left on the Billing home page.
- Optional but needed for HTTPS: a domain name, or a free subdomain (for example DuckDNS). Without HTTPS, browsers block the camera and some e-wallet redirects, and session cookies are sent unencrypted.
- The code pushed to GitHub. The server clones it.

## 1. Security groups (the firewall)

Open **EC2 → Security Groups → Create security group** in your default VPC, and create two groups:

| Name | Inbound rules |
|---|---|
| `hotelpos-web` | SSH 22 from **My IP**; HTTP 80 and HTTPS 443 from `0.0.0.0/0` (and `::/0`) |
| `hotelpos-db` | MySQL/Aurora 3306 from source **`hotelpos-web`** (the group itself, not an IP) |

The database is then reachable only from the app server, never from the internet.

## 2. The database (RDS)

Open **RDS → Create database → Standard create**:

| Setting | Value |
|---|---|
| Engine | MySQL, version **8.4.x** (same as Laragon) |
| Template | Free tier (or Dev/Test) |
| DB instance identifier | `hotelpos-db` |
| Master username | `admin`, with a strong password; store it in a password manager |
| Instance class | `db.t4g.micro` |
| Storage | 20 GB gp3, autoscaling off |
| Public access | **No** |
| VPC security group | `hotelpos-db` only (remove `default`) |
| Initial database name | leave empty (the migration creates `HotelPOS`) |
| Backups | 7 days automated backups |

After creating it, copy the **Endpoint** (for example `hotelpos-db.xxxx.ap-southeast-1.rds.amazonaws.com`).

## 3. The server (EC2)

Open **EC2 → Launch instance**:

| Setting | Value |
|---|---|
| Name | `hotelpos-web` |
| AMI | **Ubuntu Server 24.04 LTS** (64-bit x86) |
| Instance type | `t3.small` (2 GB). `t3.micro` works too if you add swap in step 4 |
| Key pair | create one (`hotelpos-key.pem`) and keep the file safe |
| Network | security group `hotelpos-web` |
| Storage | 20 GB gp3 |

Then go to **EC2 → Elastic IPs → Allocate → Associate** with the instance. The address then survives reboots, and this is the IP your domain points to.

Connect from Windows PowerShell:

```powershell
ssh -i C:\path\to\hotelpos-key.pem ubuntu@<ELASTIC-IP>
```

(If SSH complains the key is "too open", right-click the .pem, then Properties → Security → Advanced. Disable inheritance and leave only your own user.)

## 4. Install Node.js, Nginx and the MySQL client

```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git mysql-client build-essential
node -v        # v22.x (HotelPOS needs 20.12 or newer)

# t3.micro only: 2 GB of swap so npm install doesn't run out of memory
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5. Create the application's database user

The app should not use the RDS master account. From the EC2 server:

```bash
mysql -h <RDS-ENDPOINT> -u admin -p
```

```sql
CREATE DATABASE HotelPOS CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hotelpos'@'%' IDENTIFIED BY '<a long random password>';
GRANT ALL PRIVILEGES ON HotelPOS.* TO 'hotelpos'@'%';
EXIT;
```

If this hangs, the `hotelpos-db` security group isn't allowing `hotelpos-web` (step 1).

## 6. Get the code

```bash
sudo useradd --system --no-create-home --home-dir /opt/hotelpos --shell /usr/sbin/nologin hotelpos
sudo mkdir /opt/hotelpos && sudo chown hotelpos:hotelpos /opt/hotelpos
sudo -u hotelpos git clone https://github.com/Denver-debug/HotelPOS-Hotel-Restaurant-Point-of-Sale-and-Order-Management-System.git /opt/hotelpos
cd /opt/hotelpos
sudo -u hotelpos mkdir -p storage public/uploads/products
sudo -u hotelpos npm ci --omit=dev --cache /tmp/npm-cache   # production dependencies only (no Electron)
```

For a **private** repository, git asks for a username and password. Use your GitHub username and a **fine-grained personal access token** with read-only *Contents* access to this repository, not your GitHub password.

## 7. Configure `.env`

```bash
cd /opt/hotelpos
sudo -u hotelpos cp .env.example .env
sudo chmod 600 .env
openssl rand -hex 32            # copy the output for SESSION_SECRET
sudo -u hotelpos nano .env
```

Change these lines and leave the rest as in `.env.example`:

```ini
NODE_ENV=production
PORT=3000
SESSION_SECRET=<the openssl output>
# false until HTTPS works (step 10), then true
COOKIE_SECURE=false
# Nginx runs on the same machine
TRUST_PROXY=loopback

DB_HOST=<RDS-ENDPOINT>
DB_PORT=3306
DB_NAME=HotelPOS
DB_USER=hotelpos
DB_PASSWORD=<the password from step 5>

# Optional: a known admin password instead of a random one
SEED_ADMIN_PASSWORD=

# Leave the integrations on mock for the defense; for PayMongo see docs/INTEGRATIONS.md
PAYMENT_RETURN_URL=https://pos.example.com/pay/complete
```

With mock adapters in production the app logs a warning at startup ("Running in production with simulated integrations"). That is expected: it reminds you that no real PMS, payment or HR calls are made.

Create the schema and the reference data:

```bash
cd /opt/hotelpos
sudo -u hotelpos npm run migrate -- --seed --demo   # --demo adds cashier01, supervisor01 … for the demo
```

The generated passwords are printed **once**. They are also saved in `/opt/hotelpos/storage/seed-credentials.txt`; copy them somewhere safe, then delete that file.

## 8. Run it as a service

```bash
sudo cp /opt/hotelpos/deploy/hotelpos.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hotelpos
sudo systemctl status hotelpos          # should say "active (running)"
curl -s http://127.0.0.1:3000/api/v1/health   # {"ok":true,"status":"up",...,"database":"up"}
```

systemd starts the app at boot and restarts it if it crashes. Logs:

```bash
journalctl -u hotelpos -f               # live; Ctrl+C to stop
journalctl -u hotelpos --since "1 hour ago"
```

## 9. Nginx in front

```bash
sudo cp /opt/hotelpos/deploy/nginx-hotelpos.conf /etc/nginx/sites-available/hotelpos
sudo nano /etc/nginx/sites-available/hotelpos      # set server_name to your domain, or _ for the bare IP
sudo ln -s /etc/nginx/sites-available/hotelpos /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Open `http://<ELASTIC-IP>/` in a browser. You should see the HotelPOS landing page; sign in as `admin`.

## 10. HTTPS (needs a domain)

1. At your DNS provider, add an **A record** for, say, `pos.yourdomain.com` pointing to the Elastic IP. Wait until `nslookup pos.yourdomain.com` returns it.
2. Get a certificate:

   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d pos.yourdomain.com --redirect -m you@example.com --agree-tos
   ```

   Certbot edits the Nginx config, redirects HTTP to HTTPS and renews automatically (`systemctl list-timers | grep certbot`).
3. In `.env`, set `COOKIE_SECURE=true` and `PAYMENT_RETURN_URL=https://pos.yourdomain.com/pay/complete`, then `sudo systemctl restart hotelpos`.

## 11. Updating after you push new code

```bash
cd /opt/hotelpos
sudo -u hotelpos git pull
sudo -u hotelpos npm ci --omit=dev --cache /tmp/npm-cache
sudo -u hotelpos npm run migrate        # applies new migrations only; never use --fresh here
sudo systemctl restart hotelpos
```

The restart sends SIGTERM. HotelPOS finishes the requests in progress, closes its database connections and exits, and systemd starts the new version.

## 12. Backups, monitoring and cost

- **Database:** RDS takes daily snapshots (step 2). Before a risky change, take one by hand: **RDS → hotelpos-db → Actions → Take snapshot**.
- **Product images** live on the EC2 disk (`public/uploads`). Back them up with an EBS snapshot (**EC2 → Volumes → Create snapshot**), or copy them to S3:

  ```bash
  aws s3 sync /opt/hotelpos/public/uploads s3://<bucket>/uploads
  ```

- **Health:** `GET /api/v1/health` returns 200 while the database is up and 503 otherwise. You can point a free uptime monitor (for example UptimeRobot) or a Route 53 health check at it. Health checks don't create sessions.
- **Stop paying when idle:** stopping the EC2 instance and the RDS database (**Actions → Stop**) stops compute charges. Storage and the Elastic IP still cost a little. RDS restarts itself after 7 days stopped.

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `SESSION_SECRET must be set in production.` | `.env` is missing it, or the service doesn't run from `/opt/hotelpos` |
| `connect ETIMEDOUT` to the database | `hotelpos-db` security group doesn't allow `hotelpos-web` on 3306 |
| `Access denied for user 'hotelpos'` | Password in `.env` differs from step 5, or the `GRANT` was not run |
| `Connections using insecure transport are prohibited` | The RDS parameter group has `require_secure_transport=1`. Create a custom parameter group with it set to `0`; the traffic stays inside your VPC |
| `502 Bad Gateway` from Nginx | The app isn't running: `systemctl status hotelpos`, then `journalctl -u hotelpos -n 50` |
| Signed out right after signing in | `COOKIE_SECURE=true` while still on plain HTTP; set it to `false` until step 10 is done |
| Audit log shows `127.0.0.1` for everyone | `TRUST_PROXY=loopback` is missing from `.env` |
| Image upload fails with `413` | Nginx `client_max_body_size`; the config sets 3 MB |
| `npm ci` killed or very slow | Out of memory on `t3.micro`: add the swap file from step 4 |

## When to outgrow this setup

Running more than one app server behind an Application Load Balancer needs these changes first:

- product images on S3 instead of local disk;
- a shared rate-limit store (AUDIT D9);
- `TRUST_PROXY=1` for the ALB hop.

The sessions already live in MySQL, and event dispatch already copes with several instances (`SKIP LOCKED`), so neither needs to change.
