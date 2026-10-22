"use strict";
/**
 * Proxmox VE API client (Region 2 / Region 3 helpers).
 *
 * - Authenticates with an API token (PVEAPIToken header) — no password ticket dance.
 * - request() wraps fetch with rejectUnauthorized=false because the PVE host
 *   serves a self-signed certificate by default.
 * - waitForTask() implements the required UPID polling loop (5s interval)
 *   that must not release control until status === "stopped" && exitstatus === "OK".
 *
 * In PROXMOX_MOCK=true mode every call is delegated to src/mock/proxmox-mock.js.
 */
const https = require("https");
const { URLSearchParams } = require("url");
const config = require("../config");
const C = require("../config/constants");
const NODE = () => config.proxmox.node; // real node name from env (e.g. "puja")
const mock = require("../mock/proxmox-mock");

/**
 * Node's global fetch (undici) ignores https.Agent TLS options and mixes
 * badly with a locally-installed undici; use the core https.request with a
 * per-request rejectUnauthorized instead (PVE serves a self-signed cert).
 */
function rawRequest(method, urlStr, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: body ? { ...headers, "Content-Length": Buffer.byteLength(body) } : headers,
        rejectUnauthorized: !config.proxmox.insecureTls,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const response = { status: res.statusCode, text: async () => data, _text: data };
          resolve(response);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeader() {
  return `PVEAPIToken=${config.proxmox.tokenUser}!${config.proxmox.tokenId}=${config.proxmox.apiKey}`;
}

/**
 * Generic API call. Returns parsed JSON body.
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path e.g. `/nodes/pve/status`
 * @param {object} [params] urlencoded request parameters (POST/PUT)
 */
async function request(method, path, params) {
  if (config.proxmox.mock) return mock.request(method, path, params);

  const url = `${config.proxmox.apiUrl}/api2/json${path}`;
  const headers = {
    Authorization: authHeader(),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let body = null;
  if (params && method !== "GET") {
    body = new URLSearchParams(params).toString();
  }
  const res = await rawRequest(method, url, headers, body);
  if (res.status >= 400) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Proxmox API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const json = (() => {
    try { return JSON.parse(res._text); } catch (_e) { return null; }
  })();
  return json ? json.data : null;
}

/**
 * POST wrapper: PVE responds { data: "UPID:..." } for async tasks.
 */
async function postTask(path, params) {
  const upid = await request("POST", path, params);
  if (!upid || typeof upid !== "string" || !upid.startsWith("UPID:")) {
    throw new Error(`Expected UPID from POST ${path}, got: ${JSON.stringify(upid)}`);
  }
  return upid;
}

/**
 * Polling loop for a Proxmox task.
 * Resolves when { status: "stopped", exitstatus: "OK" }.
 * Re-throws with the task exitstatus on failure.
 * exitstatus "WARNINGS: <n>" is treated as success, but the warnings are
 * surfaced in the error message so operators see them in logs.
 */
async function waitForTask(upid, { intervalMs, timeoutMs } = {}) {
  const interval = intervalMs || require("../config/constants").TASK_POLL_INTERVAL_MS;
  const timeout = timeoutMs || require("../config/constants").TASK_POLL_TIMEOUT_MS;
  const node = upid.split(":")[1] || NODE(); // UPID:pve:pid:...
  const started = Date.now();

  for (;;) {
    const st = await request("GET", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
    if (st && st.status === "stopped") {
      if (st.exitstatus === "OK") return st;
      if (/^WARNINGS(:\s*\d+)?$/.test(st.exitstatus)) {
        console.warn(`[proxmox] task completed with warnings [${upid}] exitstatus=${st.exitstatus}`);
        return st;
      }
      throw new Error(`Proxmox task failed [${upid}] exitstatus=${st.exitstatus}`);
    }
    if (started + timeout < Date.now()) {
      throw new Error(`Proxmox task timeout after ${Math.round(timeout / 1000)}s [${upid}]`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** POST a task then block on its completion. */
async function postTaskAndWait(path, params, opts) {
  const upid = await postTask(path, params);
  return waitForTask(upid, opts);
}

// ---- Convenience wrappers used by services ------------------------------

/** Host health: CPU %, RAM, SSD storage, uptime (Region 3.1). */
function nodeStatus() {
  return request("GET", `/nodes/${NODE()}/status`);
}

/** Provisioning pipeline steps. */
function cloneTemplate({ newId, name }) {
  return postTaskAndWait(
    `/nodes/${NODE()}/qemu/${config.proxmox.templateId}/clone`,
    { newid: newId, name, full: 1 }
  );
}

/**
 * PUT resize is synchronous on real PVE, but a host wrapper may respond with
 * a UPID string — if so, run the same UPID polling loop (spec requirement).
 */
async function resizeDisk(vmid, disk, sizeGb) {
  const r = await request(
    "PUT",
    `/nodes/${NODE()}/qemu/${vmid}/resize`,
    { disk, size: `${sizeGb}G` }
  );
  if (typeof r === "string" && r.startsWith("UPID:")) return waitForTask(r);
  return r;
}

/**
 * Apply the purchased package spec to the cloned VM (vCPU, RAM — and the
 * net0 bridge to guarantee the internal NAT bridge regardless of template).
 * The template clone inherits the template's 2 vCPU / 2GB, so this PUT config
 * is what makes K-BIG really 8 vCPU / 8GB. Runs before start.
 */
function applyPackageSpec(vmid, { vcpu, ramMb }) {
  return request("PUT", `/nodes/${NODE()}/qemu/${vmid}/config`, {
    cores: String(vcpu),
    memory: String(ramMb),
    sockets: "1",
  });
}

function injectCloudInit(vmid, { ciuser, cipassword, ipconfig0 }) {
  return request("PUT", `/nodes/${NODE()}/qemu/${vmid}/config`, {
    ciuser,
    cipassword,
    ipconfig0,
    sshkeys: "", // password auth focus per spec
  });
}

function startVm(vmid) {
  return postTaskAndWait(`/nodes/${NODE()}/qemu/${vmid}/status/start`, {});
}

function stopVm(vmid) {
  return postTaskAndWait(`/nodes/${NODE()}/qemu/${vmid}/status/stop`, {});
}

function destroyVm(vmid) {
  return request("DELETE", `/nodes/${NODE()}/qemu/${vmid}`);
}

/** Single VM status { status: "running" | "stopped", ... } or null if absent. */
async function vmStatus(vmid) {
  try {
    return await request("GET", `/nodes/${NODE()}/qemu/${vmid}/status/current`);
  } catch (err) {
    if (err.status === 404 || err.status === 500) return null; // VM gone
    throw err;
  }
}

// ---- LXC container guest (optional second product tier) -----------------

/**
 * Create + start an unprivileged LXC container from the node-local template
 * tarball. Password belongs to the container ROOT user (PVE create hook) —
 * unlike KVM cloud-init there is no per-user injection. Disk size, cores,
 * RAM, static veth on the internal NAT bridge all set at create time.
 */
async function createLxc({ vmid, hostname, diskGb, cores, ramMb, ipInternal, rootPassword }) {
  // Bandwidth cap: tc shaping on the veth (host-side). One greedy container
  // must never absorb the whole shared uplink.
  // Proxmox `rate` on net0 is MB/s, and tc class becomes rate*8 Mbit/s.
  // Convert Mbps -> MB/s so the limit matches what we advertise to buyers.
  const rateMbPerSec = Math.max(1, Math.floor(config.proxmox.lxcNetMbps / 8));
  return postTaskAndWait(`/nodes/${NODE()}/lxc`, {
    vmid: String(vmid),
    hostname: String(hostname).slice(0, 60),
    ostype: "ubuntu",
    ostemplate: config.proxmox.lxcOstemplate,
    rootfs: `${config.proxmox.lxcStorage}:${diskGb}`,
    cores: String(cores),
    memory: String(ramMb),
    swap: "0",
    password: rootPassword,
    unprivileged: "1",
    net0: `name=eth0,bridge=${C.BRIDGE},rate=${rateMbPerSec},ip=${ipInternal}/${C.NETMASK_CIDR},gw=${C.GATEWAY},firewall=0`,
    onboot: "0",
    start: "1",
  }, { intervalMs: 1500, timeoutMs: 3 * 60 * 1000 });
}

function startLxc(vmid) {
  return postTaskAndWait(`/nodes/${NODE()}/lxc/${vmid}/status/start`, {});
}

function stopLxc(vmid) {
  return postTaskAndWait(`/nodes/${NODE()}/lxc/${vmid}/status/stop`, {});
}

/** DELETE /lxc/{id} — CT must be stopped first; purge unreferenced volumes. */
function destroyLxc(vmid) {
  return request("DELETE", `/nodes/${NODE()}/lxc/${vmid}?destroy-unreferenced-disks=1&purge=1`);
}

/** Single CT status or null if absent. Mirrors vmStatus(). */
async function lxcStatus(vmid) {
  try {
    return await request("GET", `/nodes/${NODE()}/lxc/${vmid}/status/current`);
  } catch (err) {
    if (err.status === 404 || err.status === 500) return null; // CT gone
    throw err;
  }
}

/** Dispatch stop/destroy/status for either guest kind (KVM qemu vs LXC). */
function stopGuest(kind, vmid) { return kind === "LXC" ? stopLxc(vmid) : stopVm(vmid); }
function destroyGuest(kind, vmid) { return kind === "LXC" ? destroyLxc(vmid) : destroyVm(vmid); }
function guestStatus(kind, vmid) { return kind === "LXC" ? lxcStatus(vmid) : vmStatus(vmid); }

/**
 * Next free VM id from the cluster. We probe BOTH qemu and lxc so a K-MICRO
 * VM and an LXC container can never collide on the same id.
 */
async function nextVmId() {
  if (config.proxmox.mock) return mock.nextVmId();
  // Loop guard: PVE's /cluster/nextid suggests an ID; if a VM with that id
  // already exists on the node (manually created outside the app), request
  // the next suggestion up to a few retries so we never collide.
  for (let attempt = 0; attempt < 5; attempt++) {
    const used = await request("GET", "/cluster/nextid");
    const id = parseInt(used, 10);
    if (!Number.isFinite(id)) throw new Error("Could not obtain next VM id");
    const existing = await vmStatus(id);
    if (existing === null) {
      const existingCt = await lxcStatus(id);
      if (existingCt === null) return id; // truly free in both worlds
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("No free VM id found after 5 attempts");
}

module.exports = {
  request,
  postTask,
  waitForTask,
  postTaskAndWait,
  nodeStatus,
  cloneTemplate,
  resizeDisk,
  injectCloudInit,
  applyPackageSpec,
  startVm,
  stopVm,
  destroyVm,
  vmStatus,
  // LXC container tier
  createLxc,
  startLxc,
  stopLxc,
  destroyLxc,
  lxcStatus,
  stopGuest,
  destroyGuest,
  guestStatus,
  nextVmId,
};
