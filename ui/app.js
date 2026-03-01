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
    renderOfflineState();
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
  document.getElementById("checklist").innerHTML = renderChecklist(state);
  document.getElementById("tasks").innerHTML = renderPendingTasks(state.pendingTasks);
  document.getElementById("providers").innerHTML = renderProviders(state.providerHealth);
  document.getElementById("events").innerHTML = renderFeed(state);
}

function renderOfflineState() {
  document.getElementById("subtitle").textContent = "Runtime offline. Waiting for an active Daytona worker.";
  document.getElementById("headline").textContent = "Shark control plane is staged and idle";
  document.getElementById("summary").textContent = "The Vercel UI is live, but the autonomous worker is intentionally stopped right now.";
  document.getElementById("runtimeBadge").textContent = shortRuntime(runtimeUrl);
  document.getElementById("loopStatus").textContent = "Loop paused";
  document.getElementById("loopStatus").className = "status-pill idle";
  document.getElementById("checklist").innerHTML = '<div class="muted">No active run yet</div>';
  document.getElementById("tasks").innerHTML = '<div class="muted">No pending tasks</div>';
  document.getElementById("providers").innerHTML = '<div class="muted">No provider telemetry yet</div>';
  document.getElementById("events").innerHTML = '<div class="muted">No events yet</div>';
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

function renderChecklist(state) {
  const items = [];

  if (state.currentTask) {
    items.push({
      label: `Now executing: ${state.currentTask.title}`,
      done: false,
      meta: state.currentTask.kind,
    });
  }

  for (const task of (state.recentTasks || []).slice(0, 2)) {
    items.push({
      label: `${task.status === "failed" ? "Needs retry" : "Completed"}: ${task.title}`,
      done: task.status === "completed",
      meta: task.status,
    });
  }

  for (const task of state.pendingTasks.slice(0, 4)) {
    items.push({
      label: `Queued next: ${task.title}`,
      done: false,
      meta: `P${task.priority}`,
    });
  }

  if (items.length === 0) {
    return '<div class="muted">Shark is waiting for the next plan.</div>';
  }

  return items.map((item) => `
    <article class="task-item check">
      <span class="check-dot ${item.done ? "done" : ""}">${item.done ? "✓" : ""}</span>
      <div>
        <div class="check-label">${escapeHtml(item.label)}</div>
        <div class="tiny">${escapeHtml(item.meta)}</div>
      </div>
    </article>
  `).join("");
}

function renderPendingTasks(tasks) {
  if (!tasks.length) {
    return '<div class="muted">No pending tasks</div>';
  }

  return tasks.slice(0, 8).map((task) => `
    <article class="task-item">
      <strong>${escapeHtml(task.title)}</strong>
      <div class="tiny">${escapeHtml(task.description)}</div>
      <div class="task-meta">
        <span>${escapeHtml(task.status)}</span>
        <span>P${task.priority}</span>
      </div>
    </article>`).join("");
}

function renderProviders(providerHealth) {
  return Object.entries(providerHealth)
    .map(([name, health]) => `
      <div class="provider-pill ${health.ok ? "ready" : "blocked"}">
        <span>${escapeHtml(name)}</span>
        <span class="tiny">${escapeHtml(health.message)}</span>
      </div>`).join("");
}

function renderFeed(state) {
  const cards = [];

  if (state.currentTask) {
    cards.push(renderActiveCard(state.currentTask, state.lastSummary));
  }

  for (const event of filterReadableEvents(state.recentEvents)) {
    cards.push(renderEventCard(event));
  }

  if (cards.length === 0) {
    return '<div class="muted">No events yet</div>';
  }

  return cards.join("");
}

function renderActiveCard(task, summary) {
  const notes = extractNotes(summary || task.description).slice(0, 3);
  const items = notes.length > 0 ? notes : [task.description || "Working through the current task."];

  return `
    <article class="feed-entry">
      <div class="feed-meta">
        <span class="kind">live build</span>
        <span>${formatTimestamp(task.updatedAt)}</span>
      </div>
      <div class="feed-card">
        <div class="report-title">
          <strong>Shark is working on ${escapeHtml(task.title)}</strong>
          <span class="report-badge">in progress</span>
        </div>
        <ul class="report-list">
          ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </div>
    </article>
  `;
}

function renderTaskReportCard(task) {
  const notes = extractNotes(task.output || task.description);
  const badge = task.status === "failed" ? "blocked" : "done";
  const label = task.status === "failed" ? "Blocked" : "Completed";
  const lead = task.status === "failed"
    ? `I hit a blocker while working on ${task.title}.`
    : `I finished ${task.title}.`;
  const items = [lead, ...notes].slice(0, 4);

  return `
    <article class="feed-entry">
      <div class="feed-meta">
        <span class="kind">${escapeHtml(task.kind)}</span>
        <span>${formatTimestamp(task.updatedAt)}</span>
      </div>
      <div class="feed-card">
        <div class="report-title">
          <strong>${escapeHtml(task.title)}</strong>
          <span class="report-badge ${badge}">${label}</span>
        </div>
        <ul class="report-list">
          ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </div>
    </article>
  `;
}

function renderEventCard(event) {
  const view = describeEvent(event);

  return `
    <article class="feed-entry">
      <div class="feed-meta">
        <span class="kind">${escapeHtml(view.kind)}</span>
        <span>${formatTimestamp(event.timestamp)}</span>
      </div>
      <div class="feed-card">
        <strong>${escapeHtml(view.title)}</strong>
        <p>${escapeHtml(view.body)}</p>
      </div>
    </article>
  `;
}

function filterReadableEvents(events) {
  return events;
}

function describeEvent(event) {
  const message = String(event.message || "");

  if (event.kind === "operator_command") {
    const source = event.metadata?.source === "slack" ? "Slack" : "Dashboard";
    const command = message.replace(/^Operator command received:\s*/i, "").trim();
    return {
      kind: `${source.toLowerCase()} command`,
      title: source === "Slack" ? "You sent Shark a Slack instruction" : "You steered Shark from the dashboard",
      body: command || message,
    };
  }

  if (event.kind === "status_update" && message.startsWith("Slack notified:")) {
    return {
      kind: "sent to slack",
      title: "Shark sent you an update",
      body: message.replace(/^Slack notified:\s*/i, "").trim(),
    };
  }

  if (event.kind === "status_update" && message.startsWith("Slack notification skipped:")) {
    return {
      kind: "slack issue",
      title: "Slack delivery failed",
      body: message.replace(/^Slack notification skipped:\s*/i, "").trim(),
    };
  }

  if (event.kind === "task_started") {
    return {
      kind: "task started",
      title: "Shark picked up a task",
      body: message.replace(/^Started task:\s*/i, "").trim() || message,
    };
  }

  if (event.kind === "task_completed") {
    return {
      kind: "task completed",
      title: "Shark finished a task",
      body: message,
    };
  }

  if (event.kind === "task_failed") {
    return {
      kind: "task blocked",
      title: "Shark hit a blocker",
      body: message,
    };
  }

  if (event.kind === "tool_called") {
    return {
      kind: "tool call",
      title: "Shark used a tool",
      body: message,
    };
  }

  if (event.kind === "mode_changed") {
    return {
      kind: "mode",
      title: "Loop mode updated",
      body: message,
    };
  }

  return {
    kind: event.kind.replaceAll("_", " "),
    title: "Shark update",
    body: message,
  };
}

function extractNotes(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
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
