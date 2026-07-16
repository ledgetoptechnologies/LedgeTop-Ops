// ===========================================================================
// Ledge Top Drone Services — Client Data Delivery Worker
// 
// Branded portal for delivering drone footage/photos to clients via Cloudflare R2.
// Token-based access: delivery.ledgetoptechnologies.com/?token=abc123
//
// Architecture:
//   Client visits URL with token → Worker looks up token in D1 →
//   Worker lists files from R2 bucket (prefix per client) →
//   Client clicks file → Worker streams it from R2
//
// Endpoints:
//   GET  /?token=xxx        — File listing page (branded HTML)
//   GET  /download?token=xxx&file=path — Stream file from R2
//   POST /api/admin/token   — Create access token (requires ADMIN_SECRET)
//   DELETE /api/admin/token — Revoke access token (requires ADMIN_SECRET)
// ===========================================================================

// ---------------------------------------------------------------------------
// LTDS Brand Constants
// ---------------------------------------------------------------------------
const BRAND = {
  name: "Ledge Top Drone Services",
  logoUrl: "https://ledgetopdroneservices.com/images/DroneLogo01.webp",
  primaryColor: "#F8CB2E",
  secondaryColor: "#EE5007",
  darkColor: "#000000",
  bgColor: "#f0f8ff",
  textColor: "#717275",
  fontFamily: "'Outfit', sans-serif",
  websiteUrl: "https://ledgetopdroneservices.com",
};

// ---------------------------------------------------------------------------
// CSS (inline — no external dependencies for the portal page)
// ---------------------------------------------------------------------------
function getStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${BRAND.fontFamily};
      background-color: ${BRAND.bgColor};
      color: #333;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    /* Navbar */
    .navbar {
      background-color: ${BRAND.darkColor};
      padding: 15px 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .navbar-brand img {
      height: 50px;
      width: auto;
    }
    .navbar-text {
      color: ${BRAND.primaryColor};
      font-size: 1.1rem;
      font-weight: 600;
      text-decoration: none;
    }
    .navbar-text:hover {
      color: ${BRAND.secondaryColor};
    }
    /* Main content */
    .container {
      max-width: 1000px;
      margin: 40px auto;
      padding: 0 20px;
      flex: 1;
    }
    .header-card {
      background: white;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      margin-bottom: 30px;
    }
    .header-card h1 {
      color: ${BRAND.darkColor};
      font-size: 1.8rem;
      margin-bottom: 10px;
    }
    .header-card p {
      color: ${BRAND.textColor};
      font-size: 1rem;
    }
    .header-card .client-name {
      color: ${BRAND.secondaryColor};
      font-weight: 600;
    }
    /* File list */
    .file-list {
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .file-list-header {
      background-color: ${BRAND.darkColor};
      color: ${BRAND.primaryColor};
      padding: 15px 25px;
      font-weight: 600;
      font-size: 1.1rem;
    }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 25px;
      border-bottom: 1px solid #eee;
      transition: background-color 0.15s;
    }
    .file-item:hover {
      background-color: #f8f9fa;
    }
    .file-item:last-child {
      border-bottom: none;
    }
    .file-info {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .file-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
      flex-shrink: 0;
    }
    .file-icon.video { background: #fff3cd; }
    .file-icon.image { background: #d1ecf1; }
    .file-icon.doc   { background: #d4edda; }
    .file-icon.other { background: #e2e3e5; }
    .file-name {
      font-weight: 500;
      color: #333;
    }
    .file-meta {
      font-size: 0.85rem;
      color: #999;
      margin-top: 2px;
    }
    .download-btn {
      background-color: ${BRAND.secondaryColor};
      color: white;
      padding: 8px 20px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 500;
      transition: background-color 0.15s;
      white-space: nowrap;
    }
    .download-btn:hover {
      background-color: #c01f27;
    }
    .download-all-btn {
      display: inline-block;
      margin-top: 15px;
      background-color: ${BRAND.darkColor};
      color: ${BRAND.primaryColor};
      padding: 10px 25px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      transition: opacity 0.15s;
    }
    .download-all-btn:hover {
      opacity: 0.85;
    }
    /* Error / empty states */
    .error-page {
      text-align: center;
      padding: 80px 20px;
    }
    .error-page h2 {
      color: ${BRAND.secondaryColor};
      font-size: 1.5rem;
      margin-bottom: 15px;
    }
    .error-page p {
      color: ${BRAND.textColor};
      font-size: 1.1rem;
    }
    /* Footer */
    .footer {
      background-color: ${BRAND.darkColor};
      color: #666;
      text-align: center;
      padding: 20px;
      font-size: 0.85rem;
    }
    .footer a {
      color: ${BRAND.primaryColor};
      text-decoration: none;
    }
    .footer a:hover {
      color: ${BRAND.secondaryColor};
    }
    /* Responsive */
    @media (max-width: 600px) {
      .navbar { padding: 12px 15px; }
      .container { margin: 20px auto; padding: 0 15px; }
      .header-card { padding: 20px; }
      .file-item { padding: 14px 15px; flex-direction: column; align-items: flex-start; gap: 10px; }
      .download-btn { align-self: flex-end; }
    }
  `;
}

// ---------------------------------------------------------------------------
// Helper: format file size
// ---------------------------------------------------------------------------
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ---------------------------------------------------------------------------
// Helper: get file icon class based on extension
// ---------------------------------------------------------------------------
function getFileIcon(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const videoExts = ["mp4", "mov", "avi", "mkv", "webm"];
  const imageExts = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "raw"];
  const docExts = ["pdf", "doc", "docx", "txt", "csv"];

  if (videoExts.includes(ext)) return { class: "video", icon: "🎬" };
  if (imageExts.includes(ext)) return { class: "image", icon: "🖼️" };
  if (docExts.includes(ext)) return { class: "doc", icon: "📄" };
  return { class: "other", icon: "📁" };
}

// ---------------------------------------------------------------------------
// Helper: HTML escape
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// Render the portal page
// ---------------------------------------------------------------------------
function renderPortal(clientName, project, files, token) {
  const fileListHtml = files
    .map((file) => {
      const icon = getFileIcon(file.name);
      const fileName = file.key.split("/").pop();
      const size = file.size ? formatSize(file.size) : "";
      const downloadUrl = `/download?token=${encodeURIComponent(token)}&file=${encodeURIComponent(file.key)}`;
      return `
        <div class="file-item">
          <div class="file-info">
            <div class="file-icon ${icon.class}">${icon.icon}</div>
            <div>
              <div class="file-name">${escapeHtml(fileName)}</div>
              ${size ? `<div class="file-meta">${size}</div>` : ""}
            </div>
          </div>
          <a href="${downloadUrl}" class="download-btn">Download</a>
        </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(BRAND.name)} — Client Data</title>
  <link rel="icon" href="${BRAND.logoUrl}">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>${getStyles()}</style>
</head>
<body>
  <nav class="navbar">
    <a href="${BRAND.websiteUrl}" class="navbar-brand">
      <img src="${BRAND.logoUrl}" alt="${escapeHtml(BRAND.name)} Logo">
    </a>
    <a href="${BRAND.websiteUrl}" class="navbar-text">${escapeHtml(BRAND.name)}</a>
  </nav>

  <div class="container">
    <div class="header-card">
      <h1>Project Files</h1>
      <p>Client: <span class="client-name">${escapeHtml(clientName)}</span>${project ? ` &middot; Project: ${escapeHtml(project)}` : ""}</p>
      <p style="margin-top:8px; font-size:0.85rem; color:#999;">${files.length} file${files.length !== 1 ? "s" : ""} available for download</p>
    </div>

    ${files.length > 0 ? `
      <div class="file-list">
        <div class="file-list-header">Available Downloads</div>
        ${fileListHtml}
      </div>
      <a href="mailto:beaukoltz@ledgetopdroneservices.com" class="download-all-btn" style="background-color:#F8CB2E;color:#000;">Questions about your files? Contact us</a>
    ` : `
      <div class="error-page">
        <h2>No Files Available</h2>
        <p>Files for this project haven't been uploaded yet. Please check back later.</p>
      </div>
    `}
  </div>

  <footer class="footer">
    <p>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND.name)} &middot; <a href="${BRAND.websiteUrl}">ledgetopdroneservices.com</a></p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Render error page
// ---------------------------------------------------------------------------
function renderError(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(BRAND.name)} — Error</title>
  <link rel="icon" href="${BRAND.logoUrl}">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>${getStyles()}</style>
</head>
<body>
  <nav class="navbar">
    <a href="${BRAND.websiteUrl}" class="navbar-brand">
      <img src="${BRAND.logoUrl}" alt="${escapeHtml(BRAND.name)} Logo">
    </a>
    <a href="${BRAND.websiteUrl}" class="navbar-text">${escapeHtml(BRAND.name)}</a>
  </nav>
  <div class="container">
    <div class="error-page">
      <h2>Access Denied</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  </div>
  <footer class="footer">
    <p>&copy; ${new Date().getFullYear()} ${escapeHtml(BRAND.name)} &middot; <a href="${BRAND.websiteUrl}">ledgetopdroneservices.com</a></p>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// D1 Database helpers
// ---------------------------------------------------------------------------
async function getTokenInfo(db, token) {
  try {
    const result = await db
      .prepare("SELECT * FROM access_tokens WHERE token = ? AND active = 1")
      .bind(token)
      .first();
    return result;
  } catch (e) {
    // Table might not exist yet — return null
    return null;
  }
}

async function initDb(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS access_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        client_name TEXT NOT NULL,
        project TEXT,
        r2_prefix TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        active INTEGER DEFAULT 1
      );
    `);
  } catch (e) {
    // Might already exist
  }
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- CORS for API endpoints ---
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- Admin API: create/revoke tokens ---
    if (path === "/api/admin/token" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await initDb(env.DB);
      const body = await request.json();
      const { client_name, project, r2_prefix, expires_at } = body;

      if (!client_name || !r2_prefix) {
        return new Response(
          JSON.stringify({ error: "client_name and r2_prefix are required" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // Generate a random token
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

      try {
        await env.DB.prepare(
          "INSERT INTO access_tokens (token, client_name, project, r2_prefix, expires_at) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(token, client_name, project || null, r2_prefix, expires_at || null)
          .run();

        return new Response(
          JSON.stringify({ success: true, token, url: `/?token=${token}` }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    if (path === "/api/admin/token" && request.method === "DELETE") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await initDb(env.DB);
      const body = await request.json();
      const { token } = body;

      try {
        await env.DB.prepare("UPDATE access_tokens SET active = 0 WHERE token = ?")
          .bind(token)
          .run();
        return new Response(
          JSON.stringify({ success: true }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // --- Portal page: /?token=xxx ---
    if (path === "/" || path === "") {
      const token = url.searchParams.get("token");

      if (!token) {
        return new Response(
          renderError("No access token provided. Please use the link provided to you by Ledge Top Drone Services."),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      await initDb(env.DB);
      const tokenInfo = await getTokenInfo(env.DB, token);

      if (!tokenInfo) {
        return new Response(
          renderError("Invalid or expired access token. Please contact Ledge Top Drone Services for a new link."),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      // Check expiration
      if (tokenInfo.expires_at && new Date(tokenInfo.expires_at) < new Date()) {
        return new Response(
          renderError("This access link has expired. Please contact Ledge Top Drone Services for a new link."),
          { headers: { "Content-Type": "text/html" } }
        );
      }

      // List files from R2 bucket under the token's prefix
      let files = [];
      try {
        const listed = await env.DATA_BUCKET.list({ prefix: tokenInfo.r2_prefix });
        if (listed.objects) {
          files = listed.objects.map((obj) => ({
            key: obj.key,
            name: obj.key.split("/").pop(),
            size: obj.size,
          }));
        }
        // Handle pagination if more than 1000 objects
        while (listed.truncated) {
          const more = await env.DATA_BUCKET.list({
            prefix: tokenInfo.r2_prefix,
            cursor: listed.truncated,
          });
          if (more.objects) {
            files.push(
              ...more.objects.map((obj) => ({
                key: obj.key,
                name: obj.key.split("/").pop(),
                size: obj.size,
              }))
            );
          }
          listed.truncated = more.truncated;
        }
      } catch (e) {
        // R2 bucket might not exist yet
        console.error("R2 list error:", e.message);
      }

      const html = renderPortal(
        tokenInfo.client_name,
        tokenInfo.project,
        files,
        token
      );
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // --- Download endpoint: /download?token=xxx&file=path ---
    if (path === "/download") {
      const token = url.searchParams.get("token");
      const fileKey = url.searchParams.get("file");

      if (!token || !fileKey) {
        return new Response("Missing token or file parameter", { status: 400 });
      }

      await initDb(env.DB);
      const tokenInfo = await getTokenInfo(env.DB, token);

      if (!tokenInfo) {
        return new Response("Invalid or expired token", { status: 403 });
      }

      // Security: verify the file key starts with the token's R2 prefix
      if (!fileKey.startsWith(tokenInfo.r2_prefix)) {
        return new Response("Access denied: file not in your project scope", { status: 403 });
      }

      // Stream the file from R2
      try {
        const object = await env.DATA_BUCKET.get(fileKey);
        if (!object) {
          return new Response("File not found", { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("Content-Disposition", `attachment; filename="${fileKey.split("/").pop()}"`);
        headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
        if (object.size) {
          headers.set("Content-Length", object.size);
        }

        return new Response(object.body, { headers });
      } catch (e) {
        return new Response(`Download failed: ${e.message}`, { status: 500 });
      }
    }

    // --- Health check ---
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "client-data-server" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 404 for everything else ---
    return new Response("Not found", { status: 404 });
  },
};