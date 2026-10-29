/* Serves the reading app and the lesson-sync API. Bind all interfaces so a host can reach it. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { openStore, handleRequest } = require("./api/sync");

const ROOT = __dirname;
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/icon-source.html": ["icon-source.html", "text/html; charset=utf-8"],
};

const store = openStore({ allowFile: true });

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 300000) {
        reject(new Error("Too much data to store."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/progress") {
      const body = req.method === "POST" ? await readBody(req) : null;
      const out = await handleRequest(store, req.method, url.searchParams.get("code") || "", body);
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (out.allow) headers.Allow = out.allow;
      return send(res, out.status, headers, JSON.stringify(out.json));
    }
    const file = FILES[url.pathname];
    if (!file || req.method !== "GET") {
      return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
    }
    const headers = { "Content-Type": file[1], "X-Content-Type-Options": "nosniff" };
    headers["Cache-Control"] = file[0].endsWith(".html") || file[0].endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400";
    fs.readFile(path.join(ROOT, file[0]), (err, buf) => {
      if (err) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      send(res, 200, headers, buf);
    });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ error: e.message }));
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0");
module.exports = server;
