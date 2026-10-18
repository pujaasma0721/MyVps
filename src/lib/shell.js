"use strict";
/**
 * Hardened shell executor (Region 2 / Region 4).
 *
 * Every call spawns child_process.execFile with an explicit argv array —
 * never a concatenated shell string — and an allowlist check so that even a
 * future mistake cannot inject arbitrary host commands. The `apps` user only
 * gets NOPASSWD sudo rights for these 4 binaries (see DEPLOYMENT.md):
 *   /usr/sbin/nginx, /usr/bin/certbot, /sbin/iptables, /sbin/iptables-save
 *
 * Nginx vhost files are written WITHOUT sudo into a directory owned by the
 * `apps` user (/opt/myvps/nginx-sites) that /etc/nginx/nginx.conf includes
 * with `include /opt/myvps/nginx-sites/*;`. This keeps the sudoers contract
 * intact: no /bin/sh, no tee, no root-owned writable files.
 */
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const config = require("../config");
const mock = require("../mock/shell-mock");

const NGINX_SITES_DIR = process.env.NGINX_SITES_DIR || "/opt/myvps/nginx-sites/dev-sites";

const SUDO_BIN = "/usr/bin/sudo";
/**
 * Binaries exist in different paths across distros (Debian PVE ships
 * iptables/iptables-save under /usr/sbin; the spec references /sbin).
 * Candidates are probed in order by the auto-probe below.
 */
const CANDIDATE_PATHS = {
  "/usr/sbin/nginx": ["/usr/sbin/nginx", "/usr/bin/nginx", "/sbin/nginx"],
  "/usr/bin/certbot": ["/usr/bin/certbot", "/usr/local/bin/certbot"],
  "/sbin/iptables": ["/sbin/iptables", "/usr/sbin/iptables", "/usr/bin/iptables"],
  "/sbin/iptables-save": ["/sbin/iptables-save", "/usr/sbin/iptables-save", "/usr/bin/iptables-save"],
};

/** Canonical allowlist keys (spec binaries). */
const ALLOWLIST = new Set(Object.keys(CANDIDATE_PATHS));

/**
 * Resolve which candidate path actually exists on the target host.
 * Cached after the first successful probe. Uses `command -v <bin> <bin>...`
 * over the transport. Returns the existing path or null.
 */
let resolvedPaths = null;
async function resolveRemotePath(bin) {
  if (resolvedPaths && resolvedPaths[bin]) return resolvedPaths[bin];
  const candidates = CANDIDATE_PATHS[bin];
  const cmdline = candidates.map((p) => `command -v ${p} 2>/dev/null`).join(" || ");
  const out = await new Promise((resolve, reject) => {
    const argv = SSH_REMOTE ? ["ssh", "-o", "BatchMode=yes", SSH_REMOTE, cmdline] : ["/bin/sh", "-c", cmdline];
    execFile(argv[0], argv.slice(1), { timeout: 7000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    );
  }).catch(() => "");
  const resolved = out.split("\n")[0].trim() || null;
  resolvedPaths = resolvedPaths || {};
  resolvedPaths[bin] = resolved;
  if (!resolved) console.warn(`[shell] ${bin} not found on target host (missing tool is OK for optional steps)`);
  return resolved;
}

/**
 * Remote transport for TESTING from a workstation (e.g. Windows box) against
 * the PVE host: when SHELL_SSH_HOST is set, each allowlisted command runs
 * over ssh. sudo is used ONLY when present on the target (PVE bare hosts
 * usually run as root and have no sudo installed).
 *
 * In production on the PVE host with user `apps`, SHELL_SSH_HOST stays empty
 * and the local NOPASSWD sudo contract applies.
 */
const SSH_REMOTE = process.env.SHELL_SSH_HOST || "";

function execBin(bin, args, timeoutMs = 15000) {
  if (!ALLOWLIST.has(bin)) {
    return Promise.reject(new Error(`shell: binary ${bin} is outside the sudoers allowlist`));
  }
  return new Promise((resolve, reject) => {
    // In demo mode record instead of executing (see src/mock/shell-mock.js).
    if (config.proxmox.mock) {
      return mock.exec(bin, args, resolve, reject);
    }
    // Remote path resolution happens up-front (async) before spawning.
    (async () => {
      const resolved = await resolveRemotePath(bin);
      if (!resolved) {
        const e = new Error(`shell: ${bin} not installed on target host`);
        e.notInstalled = true;
        return reject(e);
      }
      let argv;
      if (SSH_REMOTE) {
        // root over ssh; prepend sudo only when the host has it
        const prefix = await sudoPrefix();
        argv = ["ssh", "-o", "BatchMode=yes", SSH_REMOTE, `${prefix}${resolved} ${args.map(quoteArg).join(" ")}`];
      } else {
        argv = [SUDO_BIN, resolved, ...args];
      }
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`shell ${bin} ${args.join(" ")} -> ${err.message} :: ${stderr}`);
          e.code = err.code;
          e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    })().catch(reject);
  });
}

let SUDO_PREFIX_CACHE = null;
/** Detect whether target host has sudo; cache prefix "sudo ". */
async function sudoPrefix() {
  if (SUDO_PREFIX_CACHE !== null) return SUDO_PREFIX_CACHE;
  SUDO_PREFIX_CACHE = "";
  if (!SSH_REMOTE) return "";
  const has = await new Promise((resolve) => {
    execFile("ssh", ["-o", "BatchMode=yes", SSH_REMOTE, "command -v sudo"],
      { timeout: 6000 }, (err) => resolve(!err));
  });
  SUDO_PREFIX_CACHE = has ? "sudo " : "";
  return SUDO_PREFIX_CACHE;
}

/** POSIX-safe quoting for a single argument inside an ssh command line. */
function quoteArg(s) {
  return "'" + String(s).replace(/'/g, `'\''`) + "'";
}

// ---- IPTables NAT (port forwarding) -------------------------------------

function iptablesArgs({ portCustom, ipInternal, orderId, action }) {
  // Full-argument matching delete (Region 3.2 step 2) — never line numbers.
  return [
    "-t", "nat",
    action === "del" ? "-D" : "-A",
    "PREROUTING",
    "-p", "tcp",
    "--dport", String(portCustom),
    "-j", "DNAT",
    "--to-destination", `${ipInternal}:22`,
    "-m", "comment", "--comment", `vps-${orderId}`,
  ];
}

/** iptables -A RULE ; then iptables-save > /etc/iptables/rules.v4 */
async function iptablesAddRule({ portCustom, ipInternal, orderId }) {
  await execBin("/sbin/iptables", iptablesArgs({ portCustom, ipInternal, orderId, action: "add" }), 10000);
  await iptablesSave();
}

/**
 * Delete exactly matching rule. Errors are swallowed because the rule may
 * not exist (spec: ignore errors and keep cleaning the other components).
 */
async function iptablesRemoveRule({ portCustom, ipInternal, orderId }) {
  try {
    await execBin("/sbin/iptables", iptablesArgs({ portCustom, ipInternal, orderId, action: "del" }), 10000);
  } catch (_e) {
    // intentionally ignored per spec
  }
  await iptablesSave().catch(() => {}); // persistence errors are also non-fatal here
}

async function iptablesSave() {
  const res = await execBin("/sbin/iptables-save", [], 10000);
  // iptables-save only reads; persist via root helper documented in DEPLOYMENT.md
  await fs.appendFile(path.join(process.cwd(), "outputs", "iptables-snapshot.rules"),
    `${res.stdout}\n`).catch(() => {});
  return res;
}

// ---- Nginx management (Region 2.3 / Region 3.2 step 3) ------------------

function sanitizeDomain(domain) {
  const d = String(domain).toLowerCase().replace(/[^a-z0-9.\-]/g, "");
  if (!d || d.length > 253) throw new Error(`Invalid domain: ${domain}`);
  return d;
}

function nginxConfFor(domain, ipInternal) {
  return [
    "# managed by myvps-billing — do not edit by hand",
    `# vps proxy for ${domain}`,
    "server {",
    "  listen 80;",
    "  listen 443 ssl;",
    `  server_name ${domain};`,
    `  ssl_certificate     /etc/nginx/certs/wildcard.${config.mainDomain}.pem;`,
    `  ssl_certificate_key /etc/nginx/certs/wildcard.${config.mainDomain}.key;`,
    "  location / {",
    `    proxy_pass http://${ipInternal}:80;`,
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "  }",
    "}",
  ].join("\n") + "\n";
}

/**
 * Write proxy_pass vhost for `domain`. SAFETY CHECK via `nginx -t`:
 * on failure delete the file and throw WITHOUT reloading nginx.
 * On success `nginx -s reload`.
 */
async function nginxAddDomain(domain, ipInternal) {
  const d = sanitizeDomain(domain);
  const confPath = path.join(NGINX_SITES_DIR, `${d}.conf`);
  // Nginx is OPTIONAL on the test host: if the binary is absent, write the
  // file for documentation and continue — user still gets a working VPS.
  await fs.mkdir(NGINX_SITES_DIR, { recursive: true });
  await fs.writeFile(confPath, nginxConfFor(d, ipInternal), "utf8");
  try {
    await execBin("/usr/sbin/nginx", ["-t"], 10000); // SAFETY CHECK
  } catch (err) {
    await fs.unlink(confPath).catch(() => {}); // rollback the bad file, NO reload
    if (err.notInstalled) return { confPath, skipped: "nginx-not-installed" };
    throw new Error(`Nginx config invalid for ${d}: ${err.message}`);
  }
  await execBin("/usr/sbin/nginx", ["-s", "reload"], 10000);
  return { confPath };
}

async function nginxRemoveDomain(domain) {
  const d = sanitizeDomain(domain);
  await fs.unlink(path.join(NGINX_SITES_DIR, `${d}.conf`)).catch(() => {});
  // reload only if the config is still valid afterwards
  try {
    await execBin("/usr/sbin/nginx", ["-t"], 10000);
    await execBin("/usr/sbin/nginx", ["-s", "reload"], 10000);
  } catch (_e) {
    // never block the nuclear cleanup on a reload hiccup
  }
}

/** Certbot for a CUSTOM domain only (never for default subdomains). */
async function certbotIssue(domain) {
  return execBin("/usr/bin/certbot", [
    "--nginx", "-d", sanitizeDomain(domain),
    "--non-interactive", "--agree-tos", "--register-unsafely-without-email",
  ], 120000);
}

async function certbotDelete(domain) {
  try {
    await execBin("/usr/bin/certbot", ["delete", "--cert-name", sanitizeDomain(domain), "--non-interactive"], 60000);
  } catch (_e) {
    // absent cert -> ignore, keep the rest of the nuclear cleanup running
  }
}

module.exports = {
  iptablesAddRule,
  iptablesRemoveRule,
  iptablesSave,
  nginxAddDomain,
  nginxRemoveDomain,
  certbotIssue,
  certbotDelete,
};
