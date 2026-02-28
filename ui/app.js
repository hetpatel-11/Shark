const runtimeUrl = window.SHARK_RUNTIME_URL;
const apiBase = window.location.origin;

if (!runtimeUrl) {
  document.getElementById("subtitle").textContent = "No runtime target configured.";
} else {
  loadState();
  setInterval(loadState, 5000);
}

async function loadState() {
  const state = await request("/api/state", "GET");
  if (!state) {
    return;
  }

  document.getElementById("subtitle").textContent = "Connected through Vercel relay";
  document.getElementById("runtimeBadge").textContent = shortRuntime(runtimeUrl);
  document.getElementById("turns").textContent = String(state.recentEvents.length);
  document.getElementById("headline").textContent = state.thesis?.headline || "No startup thesis selected yet";
  document.getElementById("summary").textContent = state.lastSummary || "No summary yet";
  document.getElementById("modeChip").textContent = `Mode: ${state.mode}`;
  document.getElementById("storageChip").textContent = `Storage: ${state.storage}`;

  const loopStatus = document.getElementById("loopStatus");
  loopStatus.textContent = state.isRunning ? "Loop live" : "Loop paused";
  loopStatus.className = `status-pill ${state.isRunning ? "live" : "idle"}`;

  document.getElementById("meta").innerHTML = [
    `Run ID ${escapeHtml(state.runId)}`,
    `Pending ${state.pendingTasks.length}`,
    `Operators queued ${state.queuedCommands.length}`,
    `Last iteration ${formatTimestamp(state.lastIterationAt)}`,
  ].map((line) => `<span class="chip">${line}</span>`).join("");

  document.getElementById("thesis").innerHTML = renderThesis(state.thesis);
  document.getElementById("score").innerHTML = renderScore(state.thesis?.score);

  document.getElementById("tasks").innerHTML = state.pendingTasks.length
    ? state.pendingTasks.map((task) => `
        <article class="task-item">
          <strong>${escapeHtml(task.title)}</strong>
          <div class="task-meta">
            <span>${escapeHtml(task.status)}</span>
            <span>P${task.priority}</span>
          </div>
        </article>`).join("")
    : '<div class="muted">No pending tasks</div>';

  document.getElementById("providers").innerHTML = Object.entries(state.providerHealth)
    .map(([name, health]) => `
      <div class="provider-pill ${health.ok ? "ready" : "blocked"}">
        <span>${escapeHtml(name)}</span>
        <span class="tiny">${escapeHtml(health.message)}</span>
      </div>`).join("");

  document.getElementById("events").innerHTML = state.recentEvents.length
    ? state.recentEvents.slice(0, 20).map((event) => `
        <article class="feed-entry">
          <div class="feed-meta">
            <span class="kind">${escapeHtml(event.kind)}</span>
            <span>${formatTimestamp(event.timestamp)}</span>
          </div>
          <div class="feed-card">
            <strong>Shark</strong>
            <p>${escapeHtml(event.message)}</p>
          </div>
        </article>`).join("")
    : '<div class="muted">No events yet</div>';
}

async function runAction(path) {
  await request(path, "POST", {});
  await loadState();
}

async function sendCommand(event) {
  if (event) {
    event.preventDefault();
  }

  const input = document.getElementById("command");
  const text = input.value.trim();
  if (!text) {
    return;
  }

  await request("/api/command", "POST", { text });
  input.value = "";
  await loadState();
}

async function request(path, method, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

function renderThesis(thesis) {
  if (!thesis) {
    return '<div class="muted">No thesis selected yet</div>';
  }

  return [
    `<strong>${escapeHtml(thesis.headline)}</strong>`,
    `<p class="tiny">${escapeHtml(thesis.targetCustomer)} | score ${thesis.score.composite}/10</p>`,
    `<p class="tiny">${escapeHtml(thesis.problem)}</p>`,
    `<p class="tiny">${escapeHtml(thesis.productShape)}</p>`,
  ].join("");
}

function renderScore(score) {
  if (!score) {
    return '<div class="muted">No score yet</div>';
  }

  return [
    `<div><strong>Market</strong> ${score.marketSize}/10</div>`,
    `<div><strong>Launch</strong> ${score.speedToLaunch}/10</div>`,
    `<div><strong>Defensibility</strong> ${score.defensibility}/10</div>`,
    `<div><strong>AI leverage</strong> ${score.aiLeverage}/10</div>`,
    `<div><strong>Distribution</strong> ${score.distributionPotential}/10</div>`,
    `<div><strong>Composite</strong> ${score.composite}/10</div>`,
  ].join("");
}

function formatTimestamp(value) {
  if (!value) {
    return "waiting";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "waiting";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shortRuntime(url) {
  try {
    const parsed = new URL(url);
    return parsed.host.replace(".vercel.app", "");
  } catch {
    return "runtime";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
