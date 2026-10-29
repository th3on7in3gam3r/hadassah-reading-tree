/* Vercel/serverless entry for lesson sync. The Node server (server.js) serves the same API. */
const { openStore, handleRequest } = require("./sync");

const store = openStore({ allowFile: false });

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  const out = await handleRequest(store, req.method, (req.query && req.query.code) || "", body);
  if (out.allow) res.setHeader("Allow", out.allow);
  res.status(out.status).json(out.json);
};
