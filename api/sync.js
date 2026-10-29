/* One progress record per family code.
   Storage: Upstash REST (KV_REST_API_*), any Redis (REDIS_URL), or a local file when the Node server allows it. */
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");

const MAX_BYTES = 250000;

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function storageKey(code) {
  return "tree:" + crypto.createHash("sha256").update(code).digest("hex");
}

const FLOWERS = new Set(["pink", "coral", "gold", "lilac"]);
const BIRDS = new Set(["blue", "gold", "rose"]);

function cleanName(v) {
  return String(v || "").replace(/[<>&]/g, "").trim().slice(0, 24);
}

function cleanDecor(d) {
  if (!d || typeof d !== "object") return {};
  const o = {};
  if (FLOWERS.has(d.flower)) o.flower = d.flower;
  if (BIRDS.has(d.bird)) o.bird = d.bird;
  if (d.swing) o.swing = true;
  return o;
}

function cleanWatered(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

function cleanSeen(seen) {
  const miles = [];
  const facts = [];
  for (const m of (seen && seen.miles) || []) if ((m === 5 || m === 10 || m === 15) && !miles.includes(m)) miles.push(m);
  for (const f of (seen && seen.facts) || []) {
    const n = Number(f);
    if (Number.isInteger(n) && n >= 1 && n <= 20 && !facts.includes(n)) facts.push(n);
  }
  return { miles, facts };
}

function fresh(resetAt) {
  return {
    best: {}, done: {}, unlockAll: false, history: [], days: [], skills: {}, words: {},
    resetAt: resetAt || 0, settingsAt: 0, pin: null, pinAt: 0,
    childName: "", nameAt: 0, decor: {}, decorAt: 0, watered: "", seen: { miles: [], facts: [] },
  };
}

/* Same rules as the page: union lessons, keep the better score, newest reset / PIN / setting wins. */
function mergeSnapshots(local, remote) {
  if (!remote || typeof remote !== "object") return local ? JSON.parse(JSON.stringify(local)) : null;
  let S = local ? JSON.parse(JSON.stringify(local)) : fresh(0);
  S.best = S.best || {};
  S.done = S.done || {};
  S.history = Array.isArray(S.history) ? S.history : [];
  S.days = Array.isArray(S.days) ? S.days : [];
  S.skills = S.skills || {};
  S.words = S.words || {};
  S.resetAt = S.resetAt || 0;
  S.settingsAt = S.settingsAt || 0;
  S.pinAt = S.pinAt || 0;
  if (remote.pin && (!S.pin || ((remote.pinAt || 0) > S.pinAt && remote.pin !== S.pin))) {
    S.pin = remote.pin;
    S.pinAt = remote.pinAt || 0;
  }
  let childName = cleanName(S.childName);
  let nameAt = S.nameAt || 0;
  let decor = cleanDecor(S.decor);
  let decorAt = S.decorAt || 0;
  if (remote.childName && (remote.nameAt || 0) > nameAt) {
    const next = cleanName(remote.childName);
    if (next) {
      childName = next;
      nameAt = remote.nameAt || 0;
    }
  }
  if (remote.decor && typeof remote.decor === "object" && (remote.decorAt || 0) > decorAt) {
    decor = cleanDecor(remote.decor);
    decorAt = remote.decorAt || 0;
  }
  const rr = remote.resetAt || 0;
  const lr = S.resetAt || 0;
  if (lr > rr) {
    S.childName = childName;
    S.nameAt = nameAt;
    S.decor = decor;
    S.decorAt = decorAt;
    S.watered = cleanWatered(S.watered);
    S.seen = cleanSeen(S.seen);
    return S;
  }
  if (rr > lr) {
    const pin = S.pin;
    const pinAt = S.pinAt;
    S = fresh(rr);
    S.pin = pin;
    S.pinAt = pinAt;
  }
  S.childName = childName;
  S.nameAt = nameAt;
  S.decor = decor;
  S.decorAt = decorAt;
  S.seen = cleanSeen(S.seen);
  const remoteWatered = cleanWatered(remote.watered);
  if (remoteWatered && remoteWatered > cleanWatered(S.watered)) S.watered = remoteWatered;
  else S.watered = cleanWatered(S.watered);
  const remoteSeen = cleanSeen(remote.seen);
  for (const m of remoteSeen.miles) if (!S.seen.miles.includes(m)) S.seen.miles.push(m);
  for (const f of remoteSeen.facts) if (!S.seen.facts.includes(f)) S.seen.facts.push(f);
  const remoteBest = remote.best && typeof remote.best === "object" ? remote.best : {};
  for (const id in remoteBest) {
    const a = S.best[id];
    const b = remoteBest[id];
    if (!b || typeof b !== "object") continue;
    if (!a || b.stars > a.stars || (b.stars === a.stars && ((b.score || 0) > (a.score || 0) || (b.last || "") > (a.last || "")))) {
      S.best[id] = { ...b, tries: Math.max(b.tries || 0, a ? a.tries || 0 : 0) };
    } else if ((b.tries || 0) > (a.tries || 0)) {
      a.tries = b.tries;
    }
  }
  const hk = (h) => `${h.id}|${h.d}|${h.t || ""}|${h.ts || ""}`;
  const seen = new Set(S.history.map(hk));
  for (const h of Array.isArray(remote.history) ? remote.history : []) {
    if (!h || typeof h !== "object" || seen.has(hk(h))) continue;
    S.history.push(h);
    seen.add(hk(h));
  }
  const when = (h) => h.ts || Date.parse(h.d + "T12:00") || 0;
  S.history.sort((a, b) => when(a) - when(b));
  if (S.history.length > 300) S.history = S.history.slice(-300);
  for (const d of Array.isArray(remote.days) ? remote.days : []) {
    if (typeof d === "string" && !S.days.includes(d)) S.days.push(d);
  }
  S.days.sort();
  const remoteSkills = remote.skills && typeof remote.skills === "object" ? remote.skills : {};
  for (const k in remoteSkills) {
    const a = S.skills[k];
    const b = remoteSkills[k];
    if (Array.isArray(b) && (!a || b[1] > a[1])) S.skills[k] = b.slice();
  }
  const remoteWords = remote.words && typeof remote.words === "object" ? remote.words : {};
  for (const w in remoteWords) {
    if ((remoteWords[w] || 0) > (S.words[w] || 0)) S.words[w] = remoteWords[w];
  }
  const remoteDone = remote.done && typeof remote.done === "object" ? remote.done : {};
  for (const k in remoteDone) {
    if (remoteDone[k] && !S.done[k]) S.done[k] = true;
  }
  if ((remote.settingsAt || 0) > (S.settingsAt || 0)) {
    S.unlockAll = !!remote.unlockAll;
    S.settingsAt = remote.settingsAt;
  }
  return S;
}

function upstashEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function upstash(command) {
  const { url, token } = upstashEnv();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == false then cur = '' end
if cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

function upstashStore() {
  return {
    async get(key) {
      const v = await upstash(["GET", key]);
      return v == null ? null : String(v);
    },
    async compareAndSet(key, oldRaw, nextRaw) {
      const n = await upstash(["EVAL", CAS_LUA, "1", key, oldRaw || "", nextRaw]);
      return Number(n) === 1;
    },
  };
}

function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

function readReply(buf, offset) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const line = buf.toString("utf8", offset + 1, lineEnd);
  if (type === "+") return { value: line, next: lineEnd + 2 };
  if (type === "-") {
    const err = new Error(line);
    err.redis = true;
    return { value: err, next: lineEnd + 2 };
  }
  if (type === ":") return { value: Number(line), next: lineEnd + 2 };
  if (type === "$") {
    const n = Number(line);
    if (n < 0) return { value: null, next: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + n;
    if (buf.length < end + 2) return null;
    return { value: buf.toString("utf8", start, end), next: end + 2 };
  }
  throw new Error("Unexpected Redis reply");
}

function redisCall(url, args) {
  const u = new URL(url);
  const secure = u.protocol === "rediss:";
  const port = Number(u.port || 6379);
  const host = u.hostname;
  const password = u.password ? decodeURIComponent(u.password) : "";
  const username = u.username ? decodeURIComponent(u.username) : "";
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect(port, host);
    const commands = [];
    if (password) commands.push(username ? ["AUTH", username, password] : ["AUTH", password]);
    commands.push(args);
    let buf = Buffer.alloc(0);
    let replies = 0;
    let settled = false;
    let timer;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    timer = setTimeout(() => fail(new Error("The progress store took too long to answer.")), 8000);
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (replies < commands.length) {
          const parsed = readReply(buf, 0);
          if (!parsed) return;
          buf = buf.subarray(parsed.next);
          replies++;
          if (parsed.value instanceof Error) return fail(parsed.value);
          if (replies === commands.length) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.end();
            resolve(parsed.value);
            return;
          }
        }
      } catch (err) { fail(err); }
    });
    socket.on(secure ? "secureConnect" : "connect", () => {
      socket.write(Buffer.concat(commands.map(encodeCommand)));
    });
  });
}

function redisStore(url) {
  return {
    async get(key) {
      const v = await redisCall(url, ["GET", key]);
      return v == null ? null : String(v);
    },
    async compareAndSet(key, oldRaw, nextRaw) {
      const n = await redisCall(url, ["EVAL", CAS_LUA, "1", key, oldRaw || "", nextRaw]);
      return Number(n) === 1;
    },
  };
}

function fileStore(file) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { return {}; }
  };
  const writeAll = (obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  };
  return {
    get(key) {
      return locked(() => {
        const v = readAll()[key];
        return v == null ? null : String(v);
      });
    },
    compareAndSet(key, oldRaw, nextRaw) {
      return locked(() => {
        const all = readAll();
        const cur = all[key] == null ? "" : String(all[key]);
        if (cur !== (oldRaw || "")) return false;
        all[key] = nextRaw;
        writeAll(all);
        return true;
      });
    },
  };
}

function openStore(options) {
  const allowFile = options && options.allowFile;
  if (upstashEnv()) return upstashStore();
  if (process.env.REDIS_URL) return redisStore(process.env.REDIS_URL);
  if (allowFile) return fileStore(path.join(__dirname, "..", "data", "progress.json"));
  return null;
}

async function handleRequest(store, method, rawCode, body) {
  if (!store) {
    return {
      status: 503,
      json: { error: "Sync isn't set up on the website yet. Add Upstash Redis (KV_REST_API_URL and KV_REST_API_TOKEN) or set REDIS_URL." },
    };
  }
  const code = normalizeCode(rawCode);
  if (code.length < 6 || code.length > 64) {
    return { status: 400, json: { error: "The family code must be 6 to 64 characters." } };
  }
  const key = storageKey(code);
  try {
    if (method === "GET") {
      const raw = await store.get(key);
      if (!raw) return { status: 200, json: { data: null, updated: 0 } };
      const saved = JSON.parse(raw);
      return { status: 200, json: { data: saved.data || null, updated: saved.updated || 0 } };
    }
    if (method === "POST") {
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = null; }
      }
      if (!body || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        return { status: 400, json: { error: "Missing progress data." } };
      }
      if (Buffer.byteLength(JSON.stringify(body.data)) > MAX_BYTES) {
        return { status: 413, json: { error: "Too much data to store." } };
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        const raw = await store.get(key);
        let current = null;
        if (raw) {
          try { current = JSON.parse(raw).data || null; } catch (e) { current = null; }
        }
        const data = mergeSnapshots(current, body.data);
        const record = JSON.stringify({ data, updated: Date.now() });
        if (Buffer.byteLength(record) > MAX_BYTES) {
          return { status: 413, json: { error: "Too much data to store." } };
        }
        if (await store.compareAndSet(key, raw || "", record)) {
          const saved = JSON.parse(record);
          return { status: 200, json: { ok: true, data: saved.data, updated: saved.updated } };
        }
      }
      return { status: 503, json: { error: "Sync was busy. Try again in a moment." } };
    }
    return { status: 405, json: { error: "Method not allowed." }, allow: "GET, POST" };
  } catch (e) {
    return { status: 502, json: { error: "The sync service had a problem: " + e.message } };
  }
}

module.exports = {
  MAX_BYTES, normalizeCode, storageKey, mergeSnapshots, openStore, handleRequest,
  encodeCommand, readReply, redisCall,
};
