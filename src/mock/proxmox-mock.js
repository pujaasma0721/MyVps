"use strict";
/**
 * In-memory Proxmox VE API simulator (demo mode only).
 *
 * Handles the exact endpoints used by src/lib/proxmox.js. Clone/resize/start
 * produce fake UPID tasks that resolve to { status: "stopped", exitstatus: "OK" }
 * after MOCK_TASK_MS milliseconds, so the real polling loop in waitForTask()
 * is exercised end-to-end.
 */
const MOCK_TASK_MS = parseInt(process.env.MOCK_TASK_MS || "2500", 10);

const state = {
  nextId: 101,
  tasks: new Map(), // upid -> { status, exitstatus|"" , doneAt }
  vms: new Map(),   // vmid -> { id, name, status, cores, ramMb, diskGb, ciuser, cipassword, ipconfig0 }
};

let seq = 0;
function buildUpid(node, workertype) {
  return `UPID:${node}:${process.pid}:${++seq}:${Date.now()}:${100000 + seq}:${workertype}:user@pam:`;
}

function spawnTask(node, workertype, onDoneOk = true) {
  const upid = buildUpid(node, workertype);
  const finishAt = Date.now() + MOCK_TASK_MS;
  state.tasks.set(upid, {
    finishAt,
    status: () => (Date.now() >= finishAt ? { status: "stopped", exitstatus: onDoneOk ? "OK" : "ERR-1015" } : { status: "running" }),
  });
  return upid;
}

/**
 * Fake host status shaped exactly like GET /nodes/{node}/status.
 */
function hostStatus() {
  const totalMem = 32 * 1024 ** 3;      // 32 GB fixed "hardware"
  const usedMem = 12 * 1024 ** 3 + state.vms.size * 1.2 * 1024 ** 3;
  const loadtime = Math.floor(process.uptime()) + 133700;
  return {
    cpu: 0.12 + (state.vms.size % 7) * 0.03, // fraction 0..1
    uptime: loadtime,
    memory: {
      total: totalMem,
      used: Math.floor(usedMem),
      free: Math.max(0, totalMem - Math.floor(usedMem)),
    },
    rootfs: {
      total: 900 * 1024 ** 3,           // 900 GB "SSD"
      used: Math.floor(300 * 1024 ** 3 + state.vms.size * 25 * 1024 ** 3),
      free: 0, // computed on return below
      usedPercent: 0,
    },
  };
}

/** Router wired from src/lib/proxmox.js request(). */
async function request(method, path, params = {}) {
  let m;

  if ((m = path.match(/^\/nodes\/([^/]+)\/status$/)) && method === "GET") {
    const s = hostStatus();
    s.rootfs.free = Math.max(0, s.rootfs.total - s.rootfs.used);
    s.rootfs.usedPercent = s.rootfs.used / s.rootfs.total;
    return s;
  }

  if ((m = path.match(/^\/cluster\/nextid$/)) && method === "GET") {
    return String(state.nextId++);
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)\/clone$/)) && method === "POST") {
    const vmid = parseInt(params.newid, 10);
    state.vms.set(vmid, {
      id: vmid,
      name: params.name || `vm-${vmid}`,
      status: "stopped",
      corestemplate: true, // clone keeps template spec until resize/config
      cores: 2, ramMb: 2048, diskGb: 10,
      ciuser: "", cipassword: "", ipconfig0: "",
    });
    return spawnTask(m[1], "clone");
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)\/resize$/)) && method === "PUT") {
    const vm = state.vms.get(parseInt(m[2], 10));
    if (!vm) throw mockErr(500, `VM ${m[2]} does not exist (mock)`);
    vm.diskGb = parseInt(String(params.size), 10) || vm.diskGb;
    return spawnTask(m[1], "resize");
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)\/config$/))) {
    if (method === "PUT") {
      const vm = state.vms.get(parseInt(m[2], 10));
      if (!vm) throw mockErr(500, `VM ${m[2]} does not exist (mock)`);
      Object.assign(vm, {
        ciuser: params.ciuser || vm.ciuser,
        cipassword: params.cipassword || vm.cipassword,
        ipconfig0: params.ipconfig0 || vm.ipconfig0,
      });
      return null; // config PUT is synchronous
    }
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)\/status\/(start|stop)$/)) && method === "POST") {
    const vm = state.vms.get(parseInt(m[2], 10));
    if (!vm) throw mockErr(500, `VM ${m[2]} does not exist (mock)`);
    vm.status = m[3] === "start" ? "running" : "stopped";
    return spawnTask(m[1], m[3]);
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)\/status\/current$/)) && method === "GET") {
    const vm = state.vms.get(parseInt(m[2], 10));
    if (!vm) throw mockErr(500, `VM ${m[2]} does not exist (mock)`);
    return { status: vm.status, name: vm.name, cpus: 2, maxmem: vm.ramMb * 1024 ** 2, mem: vm.ramMb * 1024 ** 2 * 0.4, uptime: vm.status === "running" ? 180 : 0 };
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/qemu\/(\d+)$/)) && method === "DELETE") {
    state.vms.delete(parseInt(m[2], 10));
    return null;
  }

  if ((m = path.match(/^\/nodes\/([^/]+)\/tasks\/([^/]+)\/status$/)) && method === "GET") {
    const t = state.tasks.get(decodeURIComponent(m[2]));
    if (!t) throw mockErr(404, "no such task (mock)");
    return t.status();
  }

  throw mockErr(501, `mock has no handler for ${method} ${path}`);
}

function mockErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function nextVmId() {
  return state.nextId++;
}

/** Test helper: crash a VM out of existence while a task "runs". */
function setTaskFailure(upidShouldFail) {
  for (const [, t] of state.tasks) t.failNext = upidShouldFail;
}

module.exports = { request, nextVmId, _state: state, setTaskFailure, buildUpid };
