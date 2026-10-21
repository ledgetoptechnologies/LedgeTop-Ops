# Nginx Proxy Manager setup

The Viewer Compose stack does not contain Nginx. Nginx Proxy Manager (NPM) is
the TLS/reverse-proxy boundary and forwards to the Viewer API's LAN port.

## Proxy Host

Create one Proxy Host with these settings:

- Domain: `viewer.ledgetopdroneservices.com`
- Scheme: `http`
- Forward host/IP: the one address selected by `VIEWER_BIND_ADDRESS`, normally
  `192.168.50.80`
- Forward port: `8088`
- Cache Assets: **OFF recommended** (the Viewer also sends no-store on
  capability responses; this is not a startup prerequisite)
- Block Common Exploits: **ON**
- Websockets Support: **ON**
- SSL: select the certificate, Force SSL **ON**, HTTP/2 **ON**

Do not configure both `192.168.50.80` and `192.168.10.80` unless the Viewer is
intentionally bound and firewalled on both subnets. The standalone
`nginx-viewer.conf.example` shows an optional backup upstream for that case.

This existing NPM upstream configuration is sufficient for initial startup.
Leave `PROXY_SHARED_SECRET` and `TRUSTED_PROXY_ADDRESSES` empty in
`Config/viewer.env`. Viewer still requires the exact public Host, so ordinary
requests made directly to a LAN IP fail with `421`.

## Optional proxy-secret and forwarding hardening

The remainder of this section is a coordinated follow-up, not an initial
startup requirement. Enable it only when Viewer and NPM can be changed and
verified together.

Create a Custom Location `/` pointing to the same forward host/port and paste
the following into that location's **Advanced** field. Replace the placeholder
through NPM's protected configuration; never paste a real value into source
control, screenshots, tickets, or chat.

```nginx
client_max_body_size 33m;
client_body_timeout 60s;
send_timeout 300s;

proxy_http_version 1.1;
proxy_set_header Host viewer.ledgetopdroneservices.com;
proxy_set_header X-Forwarded-Host viewer.ledgetopdroneservices.com;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_set_header Range $http_range;
proxy_set_header If-Range $http_if_range;
# Enable only when PROXY_SHARED_SECRET is set in Config/viewer.env:
# proxy_set_header X-Viewer-Proxy-Secret "REPLACE_WITH_CONFIG_VIEWER_ENV_VALUE";

proxy_redirect off;
proxy_cache off;
proxy_buffering off;
proxy_request_buffering off;
proxy_force_ranges on;
proxy_max_temp_file_size 0;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

When enabled, setting `X-Viewer-Proxy-Secret` to this fixed protected value replaces any
client-supplied copy. Do not use `$http_x_viewer_proxy_secret`. NPM-generated
locations commonly declare their own `proxy_set_header` directives, which can
disable inheritance from a server-level Advanced block. Put the secret in the
Custom Location `/` Advanced field. If you add more specific custom locations,
put the same fixed header/include in every one rather than relying on
server-level inheritance.

For a file-backed secret, mount a root-owned mode-`640` include in NPM and use
this in every Custom Location instead of the literal secret:

```nginx
include /data/nginx/custom/viewer-proxy-headers.conf;
```

The included file should contain the fixed `proxy_set_header` lines, including
`X-Viewer-Proxy-Secret`, and must not be readable through the NPM UI/public
webroot.

## Rate and connection limits

NPM's GUI cannot declare `limit_req_zone` inside a location. Define the zones
in its persistent `/data/nginx/custom/http_top.conf` (or enforce equivalent
limits in Cloudflare), then reference them in specific Custom Locations:

```nginx
limit_req_zone $binary_remote_addr zone=viewer_redeem:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=viewer_share:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=viewer_assets:10m rate=500r/s;
limit_conn_zone $binary_remote_addr zone=viewer_asset_connections:10m;
```

- `/api/v1/admin-sessions/redeem`: `limit_req zone=viewer_redeem burst=10 nodelay;`
- `/api/share/`: `limit_req zone=viewer_share burst=30 nodelay;`,
  `access_log off;`, and `add_header Cache-Control "private, no-store" always;`
- `/session-assets/` and `/assets/`: `limit_req zone=viewer_assets burst=1000 nodelay;`
  plus `limit_conn viewer_asset_connections 64;`, `access_log off;`, and
  `add_header Cache-Control "private, no-store" always;`
- `/api/v1/admin/uploads/`: retain the 33 MiB body limit, buffering off, and
  300-second proxy read/send timeouts.

Repeat the fixed Host, forwarding, range, and proxy-secret header configuration
inside every specific NPM Custom Location. Capability-bearing `/session-assets`,
`/view`, `/embed`, and `/api/share` URLs must never enter NPM/Cloudflare caches
or persistent URL logs.

Use a short-retention access log for ordinary requests and retain the restored
end-client address only. Disable access logs for all token/capability paths
listed above. Audit every custom NPM log format: it must not record
`Authorization`, `X-Viewer-Proxy-Secret`, cookies, or full public-share URLs.

## Cloudflare source restriction

Allow only the separately managed cloudflared/Cloudflare path to reach NPM at
the host/router firewall. When Nginx real-IP processing changes `$remote_addr`
to the end-user address, Nginx `allow`/`deny` rules in the access phase no
longer see the Cloudflare connection source. Do not substitute a location-level
Cloudflare IP allowlist for the host/router firewall rule.

## Verification matrix

These checks expose no secret:

```bash
# Public domain succeeds because NPM injects the protected header.
curl -fsS https://viewer.ledgetopdroneservices.com/api/v1/health

# Direct LAN requests reject an IP Host with 421.
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.50.80:8088/api/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.10.80:8088/api/v1/health

# After optional proxy-secret enforcement is enabled, missing/wrong secrets
# reject with 403 and are never reflected.
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: viewer.ledgetopdroneservices.com' -H 'X-Viewer-Proxy-Secret: intentionally-wrong' http://192.168.50.80:8088/api/v1/health
```

If only one LAN address is bound, the other address should refuse the TCP
connection rather than return an HTTP status. Both outcomes are fail-closed.
