const electron = require("electron");
const {
  app,
  BrowserWindow,
  nativeTheme,
  dialog,
  shell,
  ipcMain,
  session,
  crashReporter,
} = electron;
const Store = require("electron-store");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { findConfiguredDashboardPort } = require("./data-home");
const { createTokenRetryHandler, dashboardRetryPath } = require("./token-retry");
const { createRendererRecovery } = require("./renderer-recovery");
const { classifyAuthBlock, defaultedPort } = require("./gateway-auth-hint");
const { exitImmersiveModes } = require("./blocking-prompt");
const { armSplashHistoryClear } = require("./splash-history");
const { hideToTray, cancelPendingTrayHide } = require("./hide-to-tray");
const { attachHtmlFullScreen } = require("./html-fullscreen");
const { shouldRetryLocalTokenMint, tokenMintRetryDelayMs, TOKEN_MINT_MAX_RETRIES } = require("./token-acquire");
const { createDisplayMediaHandler } = require("./display-media");
const { applyFocusModeChrome } = require("./focus-chrome");
const {
  createPermissionRequestHandler,
  createPermissionCheckHandler,
} = require("./permission-handler");
const { createWindowOpenHandler, openExternalSafely } = require("./external-scheme");
const { resolveThemeSource } = require("./native-theme");
const { initAutoUpdate } = require("./auto-update");

function ensureKirocrewBridgeInstalled() {
  try {
    // H7/bounds: require explicit consent before copying to ~/.config/opencode — do not
    // auto-enable the bridge. Consent via KIROCREW_BRIDGE_CONSENT=1 or electron-store flag
    // `kirocrewBridgeConsent`. Without it, return without touching the filesystem.
    let consented = false;
    try { if (process.env.KIROCREW_BRIDGE_CONSENT === "1") consented = true; } catch {}
    if (!consented) {
      try {
        const Store = require("electron-store");
        const _s = new Store();
        if (_s.get("kirocrewBridgeConsent")) consented = true;
      } catch {}
    }
    if (!consented) return;
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const resourcesBridge = (() => {
      try {
        // Packaged: resources/kirocrew-bridge/index.js
        const r = path.join(process.resourcesPath, "kirocrew-bridge", "index.js");
        if (fs.existsSync(r)) return r;
      } catch {}
      try {
        // Dev: ../../mcp/kirocrew-bridge/dist/index.js
        const d = path.join(__dirname, "../../mcp/kirocrew-bridge/dist/index.js");
        if (fs.existsSync(d)) return d;
      } catch {}
      return null;
    })();
    if (!resourcesBridge) return;
    const home = os.homedir();
    const opencodeConfigPath = path.join(home, ".config", "opencode", "opencode.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(opencodeConfigPath, "utf8")); } catch { cfg = {}; }
    if (!cfg.mcp || typeof cfg.mcp !== "object") cfg.mcp = {};
    const targetDir = path.join(home, ".config", "opencode", "mcp", "kirocrew-bridge");
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    // Copy/symlink bridge to stable location so opencode's mcp command path is stable across AppImage mounts
    const targetIndex = path.join(targetDir, "index.js");
    try {
      const data = fs.readFileSync(resourcesBridge);
      fs.writeFileSync(targetIndex, data, { mode: 0o755 });
    } catch {}
    const desired = {
      type: "local",
      command: ["node", targetIndex],
      enabled: true,
    };
    const existing = cfg.mcp["kirocrew-bridge"];
    if (JSON.stringify(existing) !== JSON.stringify(desired)) {
      cfg.mcp["kirocrew-bridge"] = desired;
      try {
        fs.mkdirSync(path.dirname(opencodeConfigPath), { recursive: true });
        fs.writeFileSync(opencodeConfigPath, JSON.stringify(cfg, null, 2) + "\n");
      } catch {}
    }
  } catch (e) {
    try { console.warn("kirocrew-bridge install failed", e && e.message); } catch {}
  }
}
const { makeUpdaterLogger } = require("./update-logger");
const {
  classifyBundleLocation,
  containingDirForBundle,
  shouldOfferRelocation,
  describeLocation,
} = require("./bundle-location");
const { DEFAULT_REMOTE_BIN } = require("./remote-token");
const {
  migrateRemoteHostConfig,
  remoteHostPort,
  getRemoteHostConfig,
  isSelectablePort,
} = require("./host-config");
const { isLocalGatewayEnabled } = require("./local-gateway");
const { seedRenamedStore } = require("./store-rename");
const { resolveHome, secretCandidates } = require("./home-dir");
const { identityFamily } = require("./instance-guard");
const { initNativeLogging } = require("./native-logging");
const { armCrashCollector, collectCrashReports } = require("./crash-collector");
const { initGpuPolicy } = require("./disable-gpu");
const { cancelPendingTrayHide } = require("./hide-to-tray");
const { exitImmersiveModes } = require("./blocking-prompt");
const { createMetricsRecorder } = require("./perf-metrics");
const { initMochi, shutdownMochi } = require("./mochi/index");
const { borrowSessionToken } = require("./mochi-session-token");
const {
  initCrewCompanion,
  shutdownCrewCompanion,
  suspendCrewCompanion,
  resumeCrewCompanion,
} = require("./crew-companion/index");

// An update install stops the gateway and quits the app. Close the Crew
// Companion overlay at dispatch so it does not float orphaned over the vanished
// dashboard during the quit handoff, and reopen it if the install fails and the
// gateway is restored. suspend/resume keep the companion's loop and IPC handlers
// intact, so the failure path needs no re-init. Both are best-effort — a
// companion teardown must never block an update or its recovery.
function closeCrewCompanionForUpdate() {
  try { suspendCrewCompanion(); } catch { /* best effort */ }
}
function reopenCrewCompanionAfterUpdate() {
  try { resumeCrewCompanion(); } catch { /* best effort */ }
}
const { createGatewaySupervisor } = require("./gateway-supervisor");
const { createWindowLifecycle } = require("./window-lifecycle");
const { createIpcRegistrar } = require("./ipc-registrar");

// Carry settings across the npm name rename before electron-store opens the
// destination. Construction writes defaults, after which the seed could no
// longer distinguish a first launch from an existing store.
seedRenamedStore(app.getPath("userData"), {
  log: (message) => console.log("store migration: " + message),
});

const store = new Store({
  defaults: {
    remoteHost: "",
    kirocrewBinPath: DEFAULT_REMOTE_BIN,
    remoteHosts: {},
    sshTimeoutMs: 20000,
    windowState: null,
    globalHotkey: null,
    lastNudgedVersion: "",
    themeAccent: "",
    updateChannel: "",
    autoDownloadUpdates: true,
    runLocalGateway: true,
    linuxFrameless: null,
  },
});

const KIROCREW_HOME = resolveHome();

function resolvePort() {
  const raw = process.env.KIROCREW_PORT;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.warn('Invalid KIROCREW_PORT="' + raw + '", falling back to 5476');
      return 5476;
    }
    return parsed;
  }

  // dashboard.url in the resolved data home is the backend source of truth.
  const configuredPort = findConfiguredDashboardPort(fs, path, [KIROCREW_HOME]);

  // With "Run a local gateway" off, a dashboard.url naming a port that has no
  // remote host of its own records a backend which will not run here: nothing
  // binds it and there is no host to mint a token from. A machine switched from
  // local to remote-only keeps exactly that record, so honouring it would
  // rebuild the dead end the opt-out is meant to avoid. A dashboard.url that
  // DOES name a configured crew still wins -- that is the user choosing between
  // crews rather than a leftover.
  if (!isLocalGatewayEnabled(store)) {
    if (
      configuredPort
      && isSelectablePort(configuredPort)
      && getRemoteHostConfig(store, configuredPort)?.host
    ) {
      return configuredPort;
    }
    const remotePort = remoteHostPort(store);
    if (remotePort) {
      console.log(
        "Local gateway is off; targeting the configured remote crew on port " + remotePort,
      );
      return remotePort;
    }
    // No crew is configured, so there is no better target than the local
    // record: naming the port the user configured beats naming the default.
  }

  if (configuredPort) return configuredPort;
  console.debug("No usable dashboard.url port in the data home, falling back to 5476");
  return 5476;
}

const PORT = resolvePort();
const BACKEND_URL = "http://localhost:" + PORT;

if (migrateRemoteHostConfig(store, PORT)) {
  console.log("Migrated legacy remoteHost to remoteHosts[" + PORT + "]");
}

app.name = identityFamily(app.getVersion()) === "nightly"
  ? "Kiro Crew Nightly"
  : "Kiro Crew";

// The dashboard view fills the whole content area on all platforms. On macOS
// and Windows the dashboard's own 42px header doubles as the title bar. macOS
// insets native traffic lights; Windows overlays its native caption controls
// and renders application-menu triggers inside the header. On Linux the window
// is frameless (frame:false) on desktops that prefer client-side decorations —
// same injected drag region, with an injected caption-control cluster instead
// of native controls (see linux-frame.js).

const { validateRemoteSettings } = require("./validation");
const { attachContextMenu } = require("./context-menu");

// Set app name for macOS menu bar and dock. Nightly ships as a separate
// side-by-side app, so its menu bar must say so.
app.name = identityFamily(app.getVersion()) === "nightly" ? "Kiro Crew Nightly" : "Kiro Crew";

// Windows taskbar identity. Without an explicit AppUserModelID, Windows groups
// the app under the generic Electron host (wrong icon in the taskbar/jumplist,
// pinning targets Electron rather than KiroCrew). Match the packaged appId
// (build.appId = "com.kirocrew.customapi"); nightly gets a distinct id so it
// pins/groups side-by-side with stable, mirroring the app.name split above.
if (IS_WIN) {
  const appUserModelId = identityFamily(app.getVersion()) === "nightly"
    ? "com.kirocrew.customapi.nightly" : "com.kirocrew.customapi";
// Windows groups and pins the live window by this ID. Nightly must remain
// side-by-side with stable, matching the packaged app IDs.
if (process.platform === "win32") {
  const appUserModelId = identityFamily(app.getVersion()) === "nightly"
    ? "com.amazon.kiro.crew.nightly"
    : "com.amazon.kiro.crew";
  app.setAppUserModelId(appUserModelId);
}

function gatewayLogPath() {
  let directory;
  try {
    directory = app.getPath("logs");
  } catch {
    directory = os.tmpdir();
  }
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    // Logging is diagnostic and must never block launch.
  }
  return path.join(directory, "gateway-launch.log");
}

function glog(line) {
  const entry = "[" + new Date().toISOString() + "] " + line + "\n";
  try {
    fs.appendFileSync(gatewayLogPath(), entry);
  } catch {
    // Never let logging break launch or recovery.
  }
  console.log("[gateway-launch] " + line);
}

function readInternalSecret() {
  // Re-read on every call. The gateway rotates this secret across restarts, so
  // caching turns a successful recovery into a stream of spurious 403s.
  for (const candidate of secretCandidates()) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next platform-compatible home candidate.
    }
  }
  return "";
}

// /api/health can remain healthy after a Linux AppImage shell exits while its
// backend survives under an unmounted /tmp/.mount_* path. Probe the dashboard
// root too: that request touches the bundled static files and exposes the stale
// mount as HTTP 500 before Electron decides to reuse the process.
function checkDashboardRoot(rootUrl = `${BACKEND_URL}/`) {
  return new Promise((resolve) => {
    const req = http.get(rootUrl, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Ask the OTHER channel app to quit through its normal lifecycle (its
// before-quit stops its own gateway). Never kill the gateway out from under
// its shell — the shell's exit watcher would treat that as a crash.
// Targets by app NAME: both installs share one bundle identifier
// (com.kirocrew.customapi), so `quit app id` would be ambiguous.
function quitOtherApp(appName) {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") { resolve(false); return; }
    execFile("osascript", ["-e", `quit app "${appName}"`], { timeout: 10000 }, (err) => resolve(!err));
  });
}
let isQuitting = false;
let desktopMetricsRecorder = null;
let windows = null;

let crashScan = null;
// Separate from `crashScan` so a scan that failed is not retried on every call:
// the failure is a broken path or a missing directory, not a transient.
let crashScanDone = false;

/**
 * Scan for crash artifacts once per app session, on first demand.
 *
 * LAZY on purpose, unlike `initNativeLogging` above. Native logging has to be
 * armed before Chromium initializes, but this only READS what a previous run
 * left behind — and it reads files, on the launch immediately after a crash,
 * which is the launch a user is already watching impatiently. Nothing needs the
 * answer until the dashboard's crash notice asks for it, so it costs nothing
 * until then and nothing at all on a run where the dashboard never opens.
 */
function scanCrashArtifacts() {
  if (crashScanDone) return crashScan;
  crashScanDone = true;
  try {
    crashScan = collectCrashReports({
      logsDir: path.dirname(gatewayLogPath()),
      crashDumpsDir: app.getPath("crashDumps"),
      // macOS only. `.ips` reports are the ONLY channel that captures a
      // main-process abort the Crashpad handler did not survive to write, so
      // they are worth a second directory here. Linux and Windows have no
      // equivalent user-readable per-app report directory, and passing "" makes
      // the collector skip the scan rather than guess at a path.
      diagnosticReportsDir: process.platform === "darwin"
        ? path.join(app.getPath("home"), "Library", "Logs", "DiagnosticReports")
        : "",
      appName: app.getName(),
      // BOTH names, because they are different strings and neither derives from
      // the other: `electron/package.json` sets `executableName` to
      // `kirocrew-desktop` (and the nightly channel overrides it again), while
      // `getName()` is `Kiro Crew`. Off darwin a minidump is our only crash
      // channel, so recognising the executable name is what makes Linux work.
      execName: path.basename(process.execPath),
      fs,
      log: glog,
    });
  } catch (e) {
    // A diagnostic that breaks the launch it exists to explain is worse than no
    // diagnostic. `getPath`/`getName` are the only calls here that can throw.
    glog("crash scan unavailable: " + (e && e.message));
    crashScan = null;
  }
  return crashScan;
}

const requestQuit = () => {
  // Window close handlers consult this synchronously. Set it before app.quit()
  // so a real quit can never be misread as a hide-to-tray request.
  isQuitting = true;
  app.quit();
};

// Only the lock winner may arm native logging. A rejected second instance must
// not rotate chromium.log out from under the primary process.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  // Record the moment this build became able to collect crashes, BEFORE the
  // crash reporter can produce one. The scan below is lazy — it runs when the
  // dashboard first asks — and the first scan has to distinguish artifacts that
  // predate this feature (which are history, and are marked seen without being
  // read) from ones this build produced. Deciding that at scan time answers the
  // wrong question: an app that crashes before the dashboard ever opens would
  // have its dump written off as pre-existing on the next launch, which is
  // exactly the crash worth reporting. This writes only the cutoff, does not
  // read any artifact, and is idempotent — a second launch keeps the first
  // stamp — so it is cheap enough to sit on the boot path.
  //
  // THE ORDER OF THESE TWO CALLS IS LOAD-BEARING. This must precede
  // `initNativeLogging`, because that is what calls `crashReporter.start()` and
  // so what makes Crashpad able to write a dump at all. Stamping afterwards
  // leaves a window — short, but covering precisely the startup crashes this
  // feature is most needed for — in which a dump exists with no cutoff on
  // record. The next launch then stamps a cutoff LATER than that dump's mtime,
  // the first scan reads it as history, and it is marked seen without ever being
  // surfaced: the crash is silently lost, which is the one outcome this whole
  // feature exists to prevent. Do not reorder for tidiness. Arming first is also
  // free: `armCrashCollector` uses nothing `initNativeLogging` sets up, neither
  // call creates `logsDir`, and the state write fails soft (logs and returns
  // null) rather than throwing.
  armCrashCollector({
    logsDir: path.dirname(gatewayLogPath()),
    fs,
    log: glog,
  });

  initNativeLogging({
    logsDir: path.dirname(gatewayLogPath()),
    appendSwitch: (name, value) => app.commandLine.appendSwitch(name, value),
    startCrashReporter: (options) => crashReporter.start(options),
    fs,
    log: glog,
  });

  // Chromium reads GPU switches during initialization, so the opt-in policy
  // must run inside the lock-winner branch and before app ready. Reading the
  // winning process's env/argv also avoids pretending a second-instance argv
  // handoff can repair the renderer that already launched.
  initGpuPolicy({
    appendSwitch: (name) => app.commandLine.appendSwitch(name),
    env: process.env,
    argv: process.argv,
    log: glog,
  });

  app.on("second-instance", () => {
    // Relaunch is explicit intent to see the existing window. The window owner
    // cancels a pending fullscreen/tray hide before restore/show/focus.
    windows?.showMainWindow({ focus: true });
  });
}

// Factories are created at module load, before any renderer can change settings.
// In particular, the supervisor snapshots runLocalGateway once for this launch.
const gateway = createGatewaySupervisor({
  app,
  store,
  BrowserWindow,
  nativeTheme,
  dialog,
  shell,
  ipcMain,
  port: PORT,
  backendUrl: BACKEND_URL,
  home: KIROCREW_HOME,
  getMainWindow: () => windows?.getMainWindow() || null,
  isQuitting: () => isQuitting,
  requestQuit,
  cancelPendingTrayHide,
  exitImmersiveModes,
  log: glog,
  logPath: gatewayLogPath,
});

windows = createWindowLifecycle({
  electron,
  store,
  backendUrl: BACKEND_URL,
  port: PORT,
  glog,
  readInternalSecret,
  fetchLocalToken: (...args) => gateway.fetchLocalToken(...args),
  fetchRemoteToken: (...args) => gateway.fetchRemoteToken(...args),
  isQuitting: () => isQuitting,
  requestQuit,
  connectWindow: (...args) => gateway.connect(...args),
});

const ipcRegistrar = createIpcRegistrar({
  electron,
  store,
  backendUrl: BACKEND_URL,
  port: PORT,
  windows,
  gateway,
  glog,
  closeCrewCompanionForUpdate,
  reopenCrewCompanionAfterUpdate,
  crashScan: scanCrashArtifacts,
});

async function resolveGatewayConflict(rebindDepth = 0) {
  const health = await fetchHealthInfo();
  // A remote host configured for THIS port means the user deliberately pointed
  // this app at a gateway on another machine, so the local holder is a tunnel
  // by construction and there is nothing here to evict.
  const remoteHost = getRemoteHostConfig(store, PORT)?.host || "";
  if (remoteHost) {
    glog(`:${PORT} is a configured remote host (${remoteHost}) — holder treated as non-local`);
  }
  const localOwner = remoteHost ? "foreign" : await probeGatewayPortOwner(PORT);
  const gatewayUsable = remoteHost ? true : await checkDashboardRoot();
  const decision = decideGatewayAction(app.getVersion(), health, { localOwner, gatewayUsable });
  if (decision.action === "reuse") {
    // Adopt-or-wait: the /api/status probe that got us here stays 200 while the
    // backend DRAINS after POST /api/shutdown, so "answering" is not "serving".
    // Adopting a draining gateway strands the shell: seconds later the process
    // exits and nothing ever answers this port again (a relaunch arriving
    // seconds into a graceful stop reads "reusing existing gateway" and then
    // goes dark). Only a positive shutting-down verdict refuses; every ambiguity
    // (legacy gateway, probe failure) keeps the historical adopt behavior.
    // A configured remote host is exempt: its port-holder is a tunnel by
    // construction, so "wait for the port to clear, then spawn fresh" can never
    // apply — adopting and letting the reconnect path wait out the remote
    // restart is the only correct move there.
    let adoptedDraining = false;
    const readiness = remoteHost ? "unknown" : await fetchGatewayReadiness();
    if (readiness === "shutting-down") {
      glog(`gateway on :${PORT} answers but /api/ready reports shutting-down — refusing to adopt a draining gateway`);
      sendStatus("Waiting for the previous gateway to exit…");
      // Capture the draining process NOW, while it still owns the LISTEN
      // socket — needed below to wait out its gateway.lock after the port clears.
      const drainingPids = await snapshotGatewayPortPids(PORT);
      if (unverifiedIncumbent(drainingPids)) {
        glog(`drain: could not capture the incumbent PID on :${PORT} — refusing an automatic respawn that could race gateway.lock`);
        return "probe-failed";
      }
      if (await waitForPortFree()) {
        if (localOwner === "service") {
          // A SERVICE-classified holder that released its port may be mid-restart
          // (kirocrew restart bounces the launchd/systemd unit): the manager is
          // about to respawn it, and spawning now races that rebind — one side
          // exits with EADDRINUSE. But orphans (reparented to init) classify as
          // service too and have no manager to respawn them, so don't exempt —
          // grace-wait: adopt a rebind, spawn only if the port stays free.
          sendStatus("Waiting for the gateway to restart…");
          const verdict = await waitForServiceRebind({
            isPortBound: async () => (await probeGatewayPortOwner(PORT)) !== "none",
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          });
          if (verdict === "rebound") {
            // Whatever re-bound the port has NOT been validated: it could be a
            // foreign process, a different-family gateway, or another draining
            // gateway. Do not assert "reuse" — re-run the full decision table
            // (identity + readiness) against the new holder. Depth-capped: one
            // re-entry per boot; a second rebind-into-drain falls through to
            // the adopt-anyway path rather than looping.
            if (rebindDepth < 1) {
              glog(`service rebind: :${PORT} re-bound within the grace window — re-validating the new holder`);
              return resolveGatewayConflict(rebindDepth + 1);
            }
            glog(`service rebind: :${PORT} re-bound again at depth ${rebindDepth} — treating as adopt-anyway to avoid a validation loop`);
          } else {
            glog(`service rebind: :${PORT} stayed free past the grace window (no manager respawned it) — spawning fresh`);
          }
        }
        if (localOwner !== "service" || (await probeGatewayPortOwner(PORT)) === "none") {
          // Port free ≠ lock free: wait for the draining process itself to
          // exit so the replacement is not refused by the singleton lock.
          await waitForIncumbentExit(drainingPids, "drain");
          glog(`drain complete: :${PORT} released — spawning a fresh gateway`);
          return "spawn";
        }
      }
      // The drain is stuck holding the socket past the graceful-stop budget.
      // Spawning now would only hit EADDRINUSE, and evicting is not ours to do
      // (we did not spawn this gateway). Adopt as before — loudly — and let the
      // liveness recovery below handle its eventual death with a bounded wait.
      glog(`drain wait timed out — :${PORT} still held; adopting anyway (recovery will respawn if it dies)`);
      adoptedDraining = true;
    }
    glog(`reusing existing gateway on :${PORT} (${decision.reason}) — bundled backend NOT spawned`);
    // Reuse path — recovery must not kill/respawn a gateway we don't own. A
    // same-family gateway held by a local Kiro Crew process is OURS in spirit
    // even though we didn't spawn it: if it dies, no tunnel will resurrect it,
    // so recovery may respawn after a bounded wait. Anything less positively
    // identified (tunnel, no visible owner, probe failure) keeps the
    // never-respawn external classification ("none").
    gatewayOwnership = classifyAdoptedGateway({ reason: decision.reason, localOwner });
    // A gateway we adopted mid-drain is not a success to celebrate: recovery
    // may immediately retract it. Keep the status neutral for that case.
    sendStatus(adoptedDraining ? "Connecting to the existing gateway…" : "Gateway already running ✓");
    return "reuse";
  }
  if (decision.action === "restart-local") {
    glog(`gateway on :${PORT} is locally owned but unusable (${decision.reason}) — restarting it`);
    const stopped = await forceStopGatewayPort(PORT);
    if (!stopped.freed) {
      glog(`local gateway restart failed: :${PORT} is still occupied`);
      return "abort";
    }
    return "spawn";
  }
  const other = FAMILY_META[decision.otherFamily];
  glog(`gateway on :${PORT} is owned by ${other.appName} (${decision.otherVersion}) — prompting for takeover`);
  const canTakeover = process.platform === "darwin";
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: `${other.displayName} is running`,
    message: `${other.displayName} (${decision.otherVersion}) is already running with your Kiro Crew data.`,
    detail: canTakeover
      ? `Only one Kiro Crew app can use ~/.kiro/crew at a time. Quit ${other.displayName} and continue here?`
      : `Only one Kiro Crew app can use ~/.kiro/crew at a time. Quit ${other.displayName}, then reopen this app.`,
    buttons: canTakeover ? [`Quit ${other.displayName} & Continue`, "Cancel"] : ["OK"],
    defaultId: 0,
    cancelId: canTakeover ? 1 : 0,
  });
  if (!canTakeover || response !== 0) return "abort";
  sendStatus(`Waiting for ${other.displayName} to quit…`);
  await quitOtherApp(other.appName);
  if (!(await waitForPortFree())) {
    glog(`takeover failed: ${other.appName} did not release :${PORT}`);
    await dialog.showMessageBox({
      type: "error",
      message: `${other.displayName} did not quit.`,
      detail: "Quit it manually, then relaunch this app.",
      buttons: ["OK"],
    });
    return "abort";
  }
  glog(`takeover: ${other.appName} released :${PORT} — proceeding to spawn`);
  return "spawn";
}

// Running from a Gatekeeper App Translocation copy, or a read-only disk image,
// is invisible at launch (all writes already redirect to ~/) but makes the
// macOS in-place bundle swap useless — electron-updater delegates the install to
// Squirrel.Mac, whose ShipIt replaces the running .app — so the app would
// download every release and apply none. Surface it once and offer the
// one-click move.
// A /Volumes path alone is NOT enough to condemn: an external disk or network
// share lives there too and is replaceable, so writability decides.
// Returns the classified location so the caller can log it. Never throws — a
// boot-time dialog failure must not reject the whole app.whenReady() chain.
/**
 * Warn when the running bundle cannot be replaced in place and offer the
 * supported macOS relocation. Never rejects: an updater diagnostic cannot
 * strand boot before the app has a window, tray, or gateway.
 */
async function offerRelocationIfUnupdatable() {
  const location = classifyBundleLocation(process.resourcesPath);
  const directory = containingDirForBundle(process.resourcesPath);
  let bundleWritable = true;
  if (directory) {
    try {
      fs.accessSync(directory, fs.constants.W_OK);
    } catch {
      bundleWritable = false;
    }
  }
  glog(
    "bundle location: " + location + " writable=" + bundleWritable
      + " (resourcesPath=" + (process.resourcesPath || "(none)") + ")",
  );
  if (!app.isPackaged || !shouldOfferRelocation(location, { bundleWritable })) {
    return location;
  }

  let response = 1;
  try {
    ({ response } = await dialog.showMessageBox({
      type: "warning",
      title: "Move kirocrew-customapi to Applications?",
      message: describeLocation(location, { bundleWritable }),
      detail: "Move it to your Applications folder to receive updates. "
        + "You can keep using it from here for now, but it will not update itself.",
      buttons: ["Move to Applications", "Continue Anyway"],
      defaultId: 0,
      cancelId: 1,
    }));
  } catch (error) {
    glog("bundle location: relocation prompt failed: " + (error && error.message));
    return location;
  }

  if (response !== 0) {
    glog("bundle location: user declined relocation from " + location);
    return location;
  }

  // moveToApplicationsFolder returns false (rather than throwing) when the
  // authorization prompt is cancelled. False and throw are both non-success.
  let moved = false;
  try {
    moved = app.moveToApplicationsFolder() !== false;
  } catch (error) {
    glog("bundle location: move to /Applications threw: " + (error && error.message));
  }
  if (moved) return location;

  glog("bundle location: move to /Applications did not complete");
  try {
    await dialog.showMessageBox({
      type: "error",
      message: "Could not move Kiro Crew automatically.",
      detail: "Drag Kiro Crew into your Applications folder, then reopen it from there.",
      buttons: ["OK"],
    });
  } catch {
    // Boot continues even when the failure dialog itself is unavailable.
  }
  return location;
}

async function fetchMochiGatewayAuth(backendUrl = BACKEND_URL) {
  // Keep the dashboard established credential order: local secret, explicit
  // SSH host, then a token borrowed from the already-authenticated session.
  const localValue = await gateway.fetchLocalToken(backendUrl);
  if (localValue) return { value: localValue, viaCookie: false };
  const { token: remoteValue } = await gateway.fetchRemoteToken(new URL(backendUrl).port);
  if (remoteValue) return { value: remoteValue, viaCookie: false };
  const borrowed = await borrowSessionToken({
    electronSession: session.defaultSession,
    backendUrl,
  });
  return borrowed ? { value: borrowed, viaCookie: true } : { value: "" };
}

// Last-resort safety net: preserve evidence and keep the process alive so the
// bounded renderer/gateway recovery paths can still run.
process.on("uncaughtException", (error) => {
  try {
    glog("uncaughtException: " + (error && error.stack ? error.stack : error));
  } catch {
    // Logging must never throw from the safety net.
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    glog("unhandledRejection: " + (reason && reason.stack ? reason.stack : reason));
  } catch {
    // Same last-resort rule as uncaughtException.
  }
});

app.whenReady().then(async () => {
  const frameDecision = windows.platform.linuxFrameDecision;
  if (frameDecision) {
    glog(
      "linux frame decision: frameless=" + frameDecision.frameless
        + " reason=" + frameDecision.reason,
    );
  }

  // Debug-only and bounded. A diagnostic aid must never take the app down.
  try {
    desktopMetricsRecorder = createMetricsRecorder({
      dir: path.dirname(gatewayLogPath()),
      getAppMetrics: () => app.getAppMetrics(),
      log: (message) => glog("perf: " + message),
      meta: { electron: process.versions && process.versions.electron },
    });
    desktopMetricsRecorder.start();
  } catch (error) {
  } catch (e) {
    // A diagnostic aid must never take the app down at boot.
    try { glog(`perf: metrics recorder failed to start: ${e && e.message}`); } catch { /* ignore */ }
  }
  try { ensureKirocrewBridgeInstalled(); } catch {}
  // Running from a mounted DMG or a Gatekeeper App Translocation copy looks
  // fine at launch but can NEVER install an update (the macOS install path
  // replaces the running .app in place). Say so once, up front, and offer the
  // one-click move — otherwise the user silently never receives another release.
  await offerRelocationIfUnupdatable();
  // Zoom items are explicit (not `role:`-based) so each zoom change can also
  // recenter the macOS traffic lights in the zoom-scaled header row.
  // Resolve the dashboard WebContents of the focused window. The de-tabbed
  // shell hosts pages in WebContentsViews inside BaseWindows: BaseWindow has
  // no `webContents`, so menu `role:` items (reload/forceReload) and
  // BrowserWindow.getFocusedWindow() lookups silently no-op on main windows.
  // Window-first resolution (focused window -> its content view) is also
  // deterministic when DevTools has focus, where getFocusedWebContents()
  // would return the DevTools page itself.
  const focusedDashboardWC = () => {
    const win = BaseWindow.getFocusedWindow();
    if (win) {
      const views = win.contentView && win.contentView.children;
      if (views && views.length > 0) {
        // First view with a real page loaded is the dashboard (works for
        // localhost AND remote-host connection windows).
        const mainView = views.find((v) => {
          try { return !!(v.webContents && v.webContents.getURL()); }
          catch { return false; }
        });
        if (mainView) return mainView.webContents;
      }
      if (win.webContents) return win.webContents; // plain BrowserWindow (prompts)
    }
    return webContents.getFocusedWebContents();
  };
  const zoomItem = (apply) => () => {
    const wc = webContents.getFocusedWebContents();
    if (!wc) return;
    apply(wc);
    // Chromium applies per-origin zoom to every same-origin window at once,
    // so recenter traffic lights on all shell windows, not just the focused one.
    for (const win of BaseWindow.getAllWindows()) {
      if (win._mcView) positionTrafficLights(win);
    }
  };
  // Menu → dashboard SPA navigation (Settings…, About). Targets the focused
  // dashboard window, falling back to the main window so the items still work
  // from the dock/tray-only state; surfaces the window before navigating.
  // `_mcView` marks every window that hosts a dashboard (setupWindowContents),
  // which skips modal prompt BrowserWindows that have no SPA to navigate.
  // Resolve the dashboard WINDOW (not WebContents): the focused one, falling
  // back to the main window so menu items still work from the dock/tray-only
  // state. `_mcView` marks every window that hosts a dashboard
  // (setupWindowContents), which skips modal prompt BrowserWindows.
  const focusedDashboardWindow = () =>
    [BaseWindow.getFocusedWindow(), mainWindow].find(
      (w) => w && !w.isDestroyed() && w._mcView
    );
  const openSettingsPage = (tab) => {
    const win = focusedDashboardWindow();
    if (!win) return;
    // The window may be mid deferred-hide (still visible, still focusable);
    // opening settings on it is a request to keep it, not lose it 2s later.
    cancelPendingTrayHide(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const wc = win._mcView.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send("navigate", tab ? `/settings/${tab}` : "/settings");
    }
  };
  // View > Keep on Top: flip always-on-top on the focused dashboard window,
  // then reconcile the checkbox with the window's ACTUAL state (read back) so
  // the checkmark cannot drift if the platform refuses or another code path
  // changes it. Persisted so the pinned window survives a relaunch.
  const toggleAlwaysOnTop = () => {
    const win = focusedDashboardWindow();
    if (!win) return;
    try {
      glog("perf: metrics recorder failed to start: " + (error && error.message));
    } catch {
      // Ignore a failure in the failure logger.
    }
  }

  await offerRelocationIfUnupdatable();

  // Security and every non-update bridge are installed before the first
  // dashboard or untrusted browser WebContents can be created.
  ipcRegistrar.registerShell();
  windows.createTray();
  const mainWindow = windows.createMainWindow();

  // The global accelerator needs an existing main window. The updater needs
  // that same window for notifications, but MUST be fully registered before
  // either awaited gateway boot step: preload exposes updateAPI immediately.
  ipcRegistrar.bindGlobalHotkey();
  ipcRegistrar.registerUpdater();

  await gateway.start();
  await gateway.connect(mainWindow);

  // Optional companion surfaces start only after the primary gateway handoff.
  // Both are best-effort and must never block an otherwise usable dashboard.
  initMochi({
    backendUrl: BACKEND_URL,
    fetchGatewayAuth: fetchMochiGatewayAuth,
    glog,
    getMainWindow: () => windows.getMainWindow(),
  });
  try {
    initCrewCompanion({
      backendUrl: BACKEND_URL,
      fetchLocalToken: (...args) => gateway.fetchLocalToken(...args),
      glog,
      getDashboardWindow: () => windows.focusedDashboardWindow() || null,
    });
  } catch (error) {
    glog("crew-companion: init failed — " + (error && error.message));
  }

  // Preserve the historical registration point: activation starts being
  // handled only after boot and optional companion initialization finish.
  app.on("activate", () => {
    windows.activateMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  // Flush the final metrics window before gateway teardown begins.
  try {
    desktopMetricsRecorder?.stop();
  } catch {
    // Best effort during quit.
  }
  // contentTracing writes only when recording is stopped. Do not await or
  // prevent quit for diagnostics, but give an armed capture its chance to land.
  void windows.diagnostics.stopForQuit();
  shutdownMochi();
  try {
    shutdownCrewCompanion();
  } catch {
    // Best effort during quit.
  }
  gateway.stopOnQuit();
});

// Release only the shell summon accelerator. Mochi owns and removes its own
// shortcuts on the before-quit path above.
app.on("will-quit", () => {
  ipcRegistrar.unregisterGlobalHotkey();
});

app.on("window-all-closed", () => {
  // macOS keeps the menu-bar/tray process alive without windows.
  if (process.platform !== "darwin") app.quit();
});
