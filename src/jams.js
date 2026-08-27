(function myExtension() {
  if (!Spicetify.Player || !Spicetify.Platform) {
    setTimeout(myExtension, 100);
    return;
  }

  const JAM_SERVER_URL = "https://relay-spotui.root.sx/";
  const JAM_STATE_KEY = "spotui-ext:jam-state";
  const JAM_POLL_MS = 1000;
  const JAM_SEEK_DRIFT_MS = 400;
  const TRANSITION_MS = 220;

  let jamRole = null;
  let jamPin = null;
  let jamToken = null;
  let jamIntervalId = null;
  let jamLastAppliedUri = null;
  let jamButtonEl = null;
  let sidebarEl = null;
  let sidebarOpen = false;
  let renderToken = 0;

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {}
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  async function jamFetch(path, opts) {
    try {
      const res = await fetch(JAM_SERVER_URL + path, opts);
      return await res.json().catch(() => ({}));
    } catch (e) {
      return { error: "network_error" };
    }
  }

  function jamStorageSave() {
    if (!jamRole) {
      storageRemove(JAM_STATE_KEY);
      return;
    }
    storageSet(
      JAM_STATE_KEY,
      JSON.stringify({ role: jamRole, pin: jamPin, token: jamToken })
    );
  }

  function jamStopPolling() {
    if (jamIntervalId) {
      clearInterval(jamIntervalId);
      jamIntervalId = null;
    }
  }

  function jamHostTick() {
    try {
      const item = Spicetify.Player?.data?.item;
      const uri = item?.uri || null;
      const position_ms = Spicetify.Player.getProgress() || 0;
      const is_playing = Spicetify.Player.isPlaying();
      jamFetch(`jam/${jamPin}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: jamToken, uri, position_ms, is_playing }),
      }).catch(() => {});
    } catch (e) {}
  }

  async function jamGuestTick() {
    try {
      const data = await jamFetch(
        `jam/${jamPin}/state?token=${encodeURIComponent(jamToken)}`
      );
      if (data.ended || data.error === "invalid_token") {
        Spicetify.showNotification("Jam ended");
        await jamLeave();
        renderSidebar();
        return;
      }
      const s = data.state;
      if (!s) return;

      const elapsedSinceUpdate = s.is_playing
        ? Math.max(0, (data.server_time - s.updated_at) * 1000)
        : 0;
      const expectedPos = s.position_ms + elapsedSinceUpdate;

      if (s.uri && s.uri !== jamLastAppliedUri) {
        jamLastAppliedUri = s.uri;
        await Spicetify.Player.playUri(s.uri);
        setTimeout(() => {
          try {
            Spicetify.Player.seek(expectedPos);
          } catch (e) {}
        }, 250);
      } else if (s.uri) {
        const currentPos = Spicetify.Player.getProgress() || 0;
        if (Math.abs(currentPos - expectedPos) > JAM_SEEK_DRIFT_MS) {
          try {
            Spicetify.Player.seek(expectedPos);
          } catch (e) {}
        }
      }

      const nowPlaying = Spicetify.Player.isPlaying();
      if (s.is_playing && !nowPlaying) Spicetify.Player.togglePlay();
      if (!s.is_playing && nowPlaying) Spicetify.Player.togglePlay();
    } catch (e) {}
  }

  async function jamCreate(btn) {
    if (jamRole) {
      Spicetify.showNotification("Already in a jam");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Creating…";
    }
    const res = await jamFetch("jam/create", { method: "POST" });
    if (!res.pin) {
      Spicetify.showNotification("Failed to create jam");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Create Jam";
      }
      return;
    }
    jamRole = "host";
    jamPin = res.pin;
    jamToken = res.token;
    jamStorageSave();
    jamStopPolling();
    jamIntervalId = setInterval(jamHostTick, JAM_POLL_MS);
    jamHostTick();
    Spicetify.showNotification(`Jam created - PIN ${jamPin}`);
    renderSidebar();
  }

  async function jamJoin(pin, btn) {
    if (jamRole) {
      Spicetify.showNotification("Already in a jam");
      return;
    }
    if (!pin) {
      Spicetify.showNotification("Enter a PIN");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Joining…";
    }
    const res = await jamFetch(`jam/${pin}/join`, { method: "POST" });
    if (res.error) {
      Spicetify.showNotification("Could not join jam: " + res.error);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Join";
      }
      return;
    }
    jamRole = "guest";
    jamPin = pin;
    jamToken = res.token;
    jamLastAppliedUri = null;
    jamStorageSave();
    jamStopPolling();
    jamIntervalId = setInterval(jamGuestTick, JAM_POLL_MS);
    jamGuestTick();
    Spicetify.showNotification(`Joined jam ${pin}`);
    renderSidebar();
  }

  async function jamLeave() {
    if (!jamRole) {
      Spicetify.showNotification("Not in a jam");
      return;
    }
    try {
      await jamFetch(`jam/${jamPin}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: jamToken }),
      });
    } catch (e) {}
    jamStopPolling();
    jamRole = null;
    jamPin = null;
    jamToken = null;
    jamLastAppliedUri = null;
    jamStorageSave();
    Spicetify.showNotification("Left jam");
    renderSidebar();
  }

  function resumeJamFromStorage() {
    try {
      const raw = storageGet(JAM_STATE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.role || !saved.pin || !saved.token) return;
      jamRole = saved.role;
      jamPin = saved.pin;
      jamToken = saved.token;
      if (jamRole === "guest") {
        jamIntervalId = setInterval(jamGuestTick, JAM_POLL_MS);
        jamGuestTick();
      } else if (jamRole === "host") {
        jamIntervalId = setInterval(jamHostTick, JAM_POLL_MS);
        jamHostTick();
      }
    } catch (e) {}
  }

  function injectStyle() {
    const s = document.createElement("style");
    s.textContent = `
	.spotui-ext-jam-btn{background:transparent;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:8px;color:#b3b3b3;border-radius:50%;transition:color .2s ease,transform .2s ease;}
	.spotui-ext-jam-btn:hover{color:#fff;transform:scale(1.08);}
	.spotui-ext-jam-btn:active{transform:scale(0.94);}
	.spotui-ext-jam-btn.active{color:#1ed760;}
	.spotui-ext-sidebar{position:fixed;top:0;right:0;bottom:0;width:340px;background:#0d0d0d;border-left:1px solid #232323;z-index:99999;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1);font-family:CircularSp,"Helvetica Neue",Helvetica,Arial,sans-serif;color:#fff;overflow:hidden;}
	.spotui-ext-sidebar.open{transform:translateX(0);}
	.spotui-ext-sidebar-header{display:flex;align-items:center;justify-content:space-between;padding:20px 20px 12px;border-bottom:1px solid #1f1f1f;}
	.spotui-ext-sidebar-title{font-size:16px;font-weight:700;letter-spacing:.02em;display:flex;align-items:center;gap:8px;}
	.spotui-ext-jam-btn.active svg{animation:spotui-ext-pulse 2s ease-in-out infinite;}
	.spotui-ext-sidebar-close{background:transparent;border:none;color:#b3b3b3;cursor:pointer;padding:6px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:color .15s ease,background .15s ease,transform .15s ease;}
	.spotui-ext-sidebar-close:hover{color:#fff;background:#1f1f1f;transform:rotate(90deg);}
	.spotui-ext-sidebar-body{flex:1;overflow-y:auto;padding:20px;position:relative;}
	.spotui-ext-sidebar-content{display:flex;flex-direction:column;gap:20px;}
	.spotui-ext-sidebar-footer{padding:14px 20px;border-top:1px solid #1f1f1f;display:flex;justify-content:center;}
	.spotui-ext-sidebar-footer a{font-size:11px;color:#6a6a6a;text-decoration:none;letter-spacing:.03em;transition:color .15s ease;}
	.spotui-ext-sidebar-footer a:hover{color:#1ed760;text-decoration:underline;}
	.spotui-ext-status-card{height:120px;box-sizing:border-box;justify-content:center;background:#151515;border-bottom:1px solid #232323;margin:-20px -20px 0 -20px;padding:18px 20px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;transition:border-color .3s ease,background .3s ease;}
	.spotui-ext-status-card.on{border-color:rgba(30,215,96,.35);background:#12180f;}
	.spotui-ext-status-dot{width:8px;height:8px;border-radius:50%;background:#535353;transition:background .25s ease,box-shadow .25s ease;}
	.spotui-ext-status-dot.on{background:#1ed760;box-shadow:0 0 8px rgba(30,215,96,.6);animation:spotui-ext-dot-pulse 1.8s ease-in-out infinite;}
	.spotui-ext-status-label{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8a8a8a;}
	.spotui-ext-pin{font-size:36px;font-weight:800;letter-spacing:.15em;color:#1ed760;font-variant-numeric:tabular-nums;cursor:pointer;padding:2px 10px;border-radius:8px;transition:background .15s ease,transform .12s ease;}
	.spotui-ext-pin:hover{background:rgba(30,215,96,.1);transform:scale(1.03);}
	.spotui-ext-pin:active{transform:scale(0.97);}
	.spotui-ext-role-tag{font-size:12px;color:#b3b3b3;}
	.spotui-ext-section-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;margin-bottom:10px;}
	.spotui-ext-btn{width:100%;cursor:pointer;padding:12px 16px;border-radius:24px;border:none;background:#1ed760;color:#000;font-size:14px;font-weight:700;transition:transform .12s ease,background .15s ease,box-shadow .15s ease;}
	.spotui-ext-btn:hover{background:#1fdf63;transform:scale(1.015);box-shadow:0 4px 14px rgba(30,215,96,.25);}
	.spotui-ext-btn:active{transform:scale(0.98);}
	.spotui-ext-btn:disabled{background:#2a2a2a;color:#666;cursor:default;transform:none;box-shadow:none;}
	.spotui-ext-btn-outline{width:100%;cursor:pointer;padding:12px 16px;border-radius:24px;border:1px solid #535353;background:transparent;color:#fff;font-size:14px;font-weight:700;transition:border-color .15s ease,background .15s ease,transform .12s ease;}
	.spotui-ext-btn-outline:hover{border-color:#fff;background:#1a1a1a;transform:scale(1.015);}
	.spotui-ext-btn-outline:active{transform:scale(0.98);}
	.spotui-ext-btn-danger{width:100%;cursor:pointer;padding:12px 16px;border-radius:24px;border:1px solid #e91429;background:transparent;color:#e91429;font-size:14px;font-weight:700;transition:background .15s ease,transform .12s ease;}
	.spotui-ext-btn-danger:hover{background:rgba(233,20,41,.1);transform:scale(1.015);}
	.spotui-ext-btn-danger:active{transform:scale(0.98);}
	.spotui-ext-input-row{display:flex;gap:8px;}
	.spotui-ext-input{flex:1;padding:12px 14px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:14px;letter-spacing:.05em;transition:border-color .15s ease,background .15s ease;}
	.spotui-ext-input:focus{outline:none;border-color:#1ed760;background:#1f1f1f;}
	.spotui-ext-note{font-size:12px;color:#8a8a8a;line-height:1.5;}
	.spotui-ext-divider{height:1px;background:#1f1f1f;margin:2px 0;}
	@keyframes spotui-ext-pin-in{0%{opacity:0;transform:scale(.7);}60%{opacity:1;transform:scale(1.06);}100%{opacity:1;transform:scale(1);}}
	@keyframes spotui-ext-dot-pulse{0%,100%{box-shadow:0 0 6px rgba(30,215,96,.5);}50%{box-shadow:0 0 12px rgba(30,215,96,.9);}}
	@keyframes spotui-ext-pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.12);}}
	`;
    document.head.appendChild(s);
  }

  function createSidebarSkeleton() {
    const el = document.createElement("div");
    el.className = "spotui-ext-sidebar";
    el.innerHTML = `
	<div class="spotui-ext-sidebar-header">
	<div class="spotui-ext-sidebar-title">
	<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 00-4.95 11.95l1.06-1.06a5.5 5.5 0 117.78 0l1.06 1.06A7 7 0 008 1zm0 3a4 4 0 00-2.83 6.83l1.06-1.06a2.5 2.5 0 113.54 0l1.06 1.06A4 4 0 008 4zm0 3a1 1 0 100 2 1 1 0 000-2z"/></svg>
	<span>Jam</span>
	</div>
	<button class="spotui-ext-sidebar-close" id="spotui-ext-sidebar-close">
	<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.47 1.47a.75.75 0 011.06 0L8 6.94l5.47-5.47a.75.75 0 111.06 1.06L9.06 8l5.47 5.47a.75.75 0 11-1.06 1.06L8 9.06l-5.47 5.47a.75.75 0 01-1.06-1.06L6.94 8 1.47 2.53a.75.75 0 010-1.06z"/></svg>
	</button>
	</div>
	<div class="spotui-ext-sidebar-body" id="spotui-ext-sidebar-body"></div>
	<div class="spotui-ext-sidebar-footer">
	<a href="https://github.com/SkenSMasteR/SpoTUI" target="_blank" rel="noopener noreferrer">Powered by: SpoTUI</a>
	</div>
	`;
    document.body.appendChild(el);
    el.querySelector("#spotui-ext-sidebar-close").addEventListener(
      "click",
      closeSidebar
    );
    return el;
  }

  function buildContentNode() {
    const wrap = document.createElement("div");
    wrap.className = "spotui-ext-sidebar-content";

    const statusCard = document.createElement("div");
    statusCard.className = "spotui-ext-status-card" + (jamRole ? " on" : "");
    if (jamRole) {
      statusCard.innerHTML = `
	<div class="spotui-ext-status-label"><span class="spotui-ext-status-dot on"></span>&nbsp; ${
    jamRole === "host" ? "Hosting" : "Connected"
  }</div>
	<div class="spotui-ext-pin" id="spotui-ext-pin" title="Click to copy">${jamPin}</div>
	<div class="spotui-ext-role-tag">${
    jamRole === "host" ? "Click PIN to copy and invite others" : "Guest mode"
  }</div>
	`;
    } else {
      statusCard.innerHTML = `
	<div class="spotui-ext-status-label"><span class="spotui-ext-status-dot"></span>&nbsp; Not in a jam</div>
	<div class="spotui-ext-note">Create a jam to invite others, or join one with a PIN.</div>
	`;
    }
    wrap.appendChild(statusCard);

    if (jamRole) {
      const pinEl = statusCard.querySelector("#spotui-ext-pin");
      if (pinEl) {
        pinEl.addEventListener("click", () => {
          navigator.clipboard.writeText(String(jamPin)).catch(() => {});
          Spicetify.showNotification("PIN copied");
        });
      }
    }

    if (!jamRole) {
      const createLabel = document.createElement("div");
      createLabel.className = "spotui-ext-section-label";
      createLabel.textContent = "Start a jam";
      wrap.appendChild(createLabel);

      const createBtn = document.createElement("button");
      createBtn.className = "spotui-ext-btn";
      createBtn.textContent = "Create Jam";
      createBtn.addEventListener("click", () => jamCreate(createBtn));
      wrap.appendChild(createBtn);

      const divider = document.createElement("div");
      divider.className = "spotui-ext-divider";
      wrap.appendChild(divider);

      const joinLabel = document.createElement("div");
      joinLabel.className = "spotui-ext-section-label";
      joinLabel.textContent = "Join a jam";
      wrap.appendChild(joinLabel);

      const joinRow = document.createElement("div");
      joinRow.className = "spotui-ext-input-row";
      const pinInput = document.createElement("input");
      pinInput.className = "spotui-ext-input";
      pinInput.placeholder = "Enter PIN";
      const joinBtn = document.createElement("button");
      joinBtn.className = "spotui-ext-btn-outline";
      joinBtn.style.width = "auto";
      joinBtn.style.padding = "12px 18px";
      joinBtn.textContent = "Join";
      joinBtn.addEventListener("click", () =>
        jamJoin(pinInput.value.trim(), joinBtn)
      );
      pinInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") jamJoin(pinInput.value.trim(), joinBtn);
      });
      joinRow.appendChild(pinInput);
      joinRow.appendChild(joinBtn);
      wrap.appendChild(joinRow);
    } else {
      const divider = document.createElement("div");
      divider.className = "spotui-ext-divider";
      wrap.appendChild(divider);

      const leaveBtn = document.createElement("button");
      leaveBtn.className = "spotui-ext-btn-danger";
      leaveBtn.textContent = "Leave Jam";
      leaveBtn.addEventListener("click", () => jamLeave());
      wrap.appendChild(leaveBtn);
    }

    return wrap;
  }

  function renderSidebar() {
    if (!sidebarEl) return;
    const body = sidebarEl.querySelector("#spotui-ext-sidebar-body");
    body.innerHTML = "";
    body.appendChild(buildContentNode());
    updateJamButtonState();
  }

  function openSidebar() {
    if (!sidebarEl) sidebarEl = createSidebarSkeleton();
    renderSidebar();
    requestAnimationFrame(() => sidebarEl.classList.add("open"));
    sidebarOpen = true;
  }

  function closeSidebar() {
    if (!sidebarEl) return;
    sidebarEl.classList.remove("open");
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) closeSidebar();
    else openSidebar();
  }

  function updateJamButtonState() {
    if (!jamButtonEl) return;
    jamButtonEl.classList.toggle("active", Boolean(jamRole));
    jamButtonEl.title = jamRole
      ? jamRole === "host"
        ? `Hosting jam - PIN ${jamPin}`
        : `In jam ${jamPin}`
      : "Jam";
  }

  function createJamButton() {
    const btn = document.createElement("button");
    btn.className = "spotui-ext-jam-btn";
    btn.title = "Jam";
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 00-4.95 11.95l1.06-1.06a5.5 5.5 0 117.78 0l1.06 1.06A7 7 0 008 1zm0 3a4 4 0 00-2.83 6.83l1.06-1.06a2.5 2.5 0 113.54 0l1.06 1.06A4 4 0 008 4zm0 3a1 1 0 100 2 1 1 0 000-2z"/></svg>`;
    btn.addEventListener("click", toggleSidebar);
    return btn;
  }

  function tryInjectButton() {
    if (document.getElementById("spotui-ext-jam-btn")) return true;
    const container =
      document.querySelector(".main-nowPlayingBar-extraControls") ||
      document.querySelector(".main-nowPlayingBar-right") ||
      document.querySelector(
        '[data-testid="now-playing-bar"] .main-nowPlayingBar-right'
      );
    if (!container) return false;
    const btn = createJamButton();
    btn.id = "spotui-ext-jam-btn";
    container.appendChild(btn);
    jamButtonEl = btn;
    updateJamButtonState();
    return true;
  }

  function watchForPlaybar() {
    if (tryInjectButton()) return;
    const observer = new MutationObserver(() => {
      if (tryInjectButton()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  injectStyle();
  watchForPlaybar();
  resumeJamFromStorage();
})();
