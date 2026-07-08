const listEl = document.getElementById("items");
const detailEl = document.getElementById("detail");
const countEl = document.getElementById("count");
const wsStateEl = document.getElementById("ws-state");

let captures = [];
let selectedId = null;
let selectedFull = null; // currently displayed full capture

// ---------- formatting ----------
const fmtSize = (n) => {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
};
const fmtTime = (ms) => {
  if (ms == null) return "";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(2) + " s";
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "");

// Robust copy: navigator.clipboard is undefined in non-secure contexts (http via
// non-localhost IPs). Fall back to a hidden textarea + execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  return ok;
}
const escapeHtml = (s) =>
  (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const statusClass = (s) => (!s ? "" : s < 400 ? "ok" : s < 500 ? "warn" : "err");
const safeParse = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

function syntaxHighlight(json) {
  json = escapeHtml(json);
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "key" : "str";
      else if (/true|false/.test(m)) cls = "bool";
      else if (/null/.test(m)) cls = "null";
      return `<span class="${cls}">${m}</span>`;
    },
  );
}

// ---------- list ----------
function renderList() {
  countEl.textContent = "(" + captures.length + ")";
  listEl.innerHTML = "";
  for (const c of captures) {
    const el = document.createElement("div");
    el.className = "item" + (c.id === selectedId ? " active" : "");
    el.innerHTML = `
      <div class="row1">
        <span class="method">${escapeHtml(c.method)}</span>
        <span class="status ${statusClass(c.response_status)}">${c.response_status ?? "…"}</span>
        ${c.is_sse ? '<span class="badge">SSE</span>' : ""}
        ${c.incoming_protocol ? `<span class="proto">in ${escapeHtml(c.incoming_protocol)}</span>` : ""}
        ${c.upstream_protocol ? `<span class="proto">out ${escapeHtml(c.upstream_protocol)}</span>` : ""}
        <span class="time">${fmtDate(c.started_at)}</span>
      </div>
      <div class="path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</div>
      <div class="row2">
        <span>↑${fmtSize(c.request_size)}</span>
        <span>↓${fmtSize(c.response_size)}</span>
        <span>${fmtTime(c.duration_ms)}</span>
      </div>`;
    el.onclick = () => select(c.id);
    listEl.appendChild(el);
  }
}

async function loadList() {
  try {
    const r = await fetch("/dashboard/api/captures?limit=200");
    captures = await r.json();
    renderList();
  } catch (e) {
    console.error(e);
  }
}

// ---------- detail ----------
function renderHeaders(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return '<div class="empty">no headers</div>';
  return (
    '<div class="headers">' +
    keys
      .map(
        (k) => `<div class="hk">${escapeHtml(k)}</div><div class="hv">${escapeHtml(obj[k])}</div>`,
      )
      .join("") +
    "</div>"
  );
}

function renderBody(body, isSse) {
  if (!body) return '<div class="empty">empty body</div>';
  if (body.startsWith("__B64__")) {
    return `<div class="empty">binary data (base64, ${body.length - 6} chars)</div>`;
  }
  if (isSse) return renderSSE(body);
  try {
    const j = JSON.parse(body);
    return `<pre class="json">${syntaxHighlight(JSON.stringify(j, null, 2))}</pre>`;
  } catch {
    return `<pre>${escapeHtml(body)}</pre>`;
  }
}

function renderSSE(body) {
  const events = body.split(/\r?\n\r?\n/).filter((e) => e.trim());
  let html = `<div class="sse-info">${events.length} event(s) · click to expand</div>`;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const dataLines = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.replace(/^data:\s?/, ""));
    const data = dataLines.join("\n");
    const evtName = (ev.match(/^event:\s?(.*)$/m) || [])[1] || "";
    let inner;
    let preview = "";
    try {
      const j = JSON.parse(data);
      inner = `<pre class="json">${syntaxHighlight(JSON.stringify(j, null, 2))}</pre>`;
      preview = extractDelta(j) || "";
    } catch {
      inner = `<pre>${escapeHtml(data)}</pre>`;
      preview = data.slice(0, 60);
    }
    const label = evtName ? `event: ${evtName}` : `#${i + 1}`;
    const prev = preview ? ` <span class="delta">${escapeHtml(preview)}</span>` : "";
    html += `<details class="sse-event"><summary>${label}${prev}</summary>${inner}</details>`;
  }
  return html;
}

function extractDelta(j) {
  // OpenAI / Anthropic style content delta preview.
  try {
    const choices = j.choices || j.delta;
    if (Array.isArray(choices)) {
      const d = choices[0]?.delta?.content || choices[0]?.text;
      if (d != null) return JSON.stringify(d);
    }
    if (j.delta?.text) return JSON.stringify(j.delta.text);
    if (j.type) return j.type;
  } catch {}
  return "";
}

function renderDetail(c) {
  selectedFull = c;
  const reqH = safeParse(c.request_headers);
  const resH = safeParse(c.response_headers);
  const tabs = `
    <div class="tabs">
      <button data-tab="res-body" class="active">Response Body</button>
      <button data-tab="req-body">Request Body</button>
      <button data-tab="req-headers">Req Headers</button>
      <button data-tab="res-headers">Res Headers</button>
    </div>`;
  const bodies = `
    <div class="tab-body" id="res-body">${renderBody(c.response_body, c.is_sse)}</div>
    <div class="tab-body hidden" id="req-body">${renderBody(c.request_body, false)}</div>
    <div class="tab-body hidden" id="req-headers">${renderHeaders(reqH)}</div>
    <div class="tab-body hidden" id="res-headers">${renderHeaders(resH)}</div>`;
  detailEl.innerHTML = `
    <header>
      <h2>${escapeHtml(c.method)} ${escapeHtml(c.path)}</h2>
      <div class="meta">
        <span class="status ${statusClass(c.response_status)}">${c.response_status ?? "streaming"}</span>
        ${c.is_sse ? '<span class="badge">SSE</span>' : ""}
        <span>↑${fmtSize(c.request_size)} ↓${fmtSize(c.response_size)}</span>
        <span>${fmtTime(c.duration_ms)}</span>
        ${c.incoming_protocol ? `<span class="proto">in ${escapeHtml(c.incoming_protocol)}</span>` : ""}
        ${c.upstream_protocol ? `<span class="proto">out ${escapeHtml(c.upstream_protocol)}</span>` : ""}
        <span>${fmtDate(c.started_at)}</span>
        ${c.state === "streaming" ? '<span class="badge">live</span>' : ""}
      </div>
      <div class="url">${escapeHtml(c.url)}</div>
    </header>
    ${tabs}
    ${bodies}
    <button class="copy">Copy</button>`;

  detailEl.querySelectorAll(".tabs button").forEach((btn) => {
    btn.onclick = () => {
      detailEl.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      detailEl.querySelectorAll(".tab-body").forEach((t) => t.classList.add("hidden"));
      detailEl.querySelector("#" + btn.dataset.tab).classList.remove("hidden");
    };
  });
  const copyBtn = detailEl.querySelector(".copy");
  copyBtn.onclick = async () => {
    const active = detailEl.querySelector(".tabs button.active").dataset.tab;
    const map = {
      "res-body": c.response_body,
      "req-body": c.request_body,
      "req-headers": c.request_headers,
      "res-headers": c.response_headers,
    };
    const ok = await copyText(map[active] || "");
    copyBtn.textContent = ok ? "Copied!" : "Failed";
    setTimeout(() => {
      copyBtn.textContent = "Copy";
    }, 1200);
  };
}

async function select(id) {
  selectedId = id;
  renderList();
  try {
    const r = await fetch(`/dashboard/api/captures/${id}`);
    const c = await r.json();
    renderDetail(c);
  } catch (e) {
    console.error(e);
  }
}

// ---------- WebSocket ----------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/dashboard/ws`);
  } catch {
    wsStateEl.textContent = "websocket unavailable";
    wsStateEl.className = "ws-state down";
    return;
  }
  ws.onopen = () => {
    wsStateEl.textContent = "live";
    wsStateEl.className = "ws-state live";
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "clear") {
      captures = [];
      renderList();
      return;
    }
    if (msg.type === "new" || msg.type === "update") {
      const c = msg.capture;
      const i = captures.findIndex((x) => x.id === c.id);
      if (i >= 0) captures[i] = c;
      else captures.unshift(c);
      captures.sort((a, b) => b.id - a.id);
      renderList();
      // If the selected capture just finished streaming, refresh its detail.
      if (
        msg.type === "update" &&
        c.id === selectedId &&
        c.state === "done" &&
        selectedFull?.state === "streaming"
      ) {
        select(selectedId);
      }
    }
  };
  ws.onclose = () => {
    wsStateEl.textContent = "reconnecting…";
    wsStateEl.className = "ws-state down";
    setTimeout(connectWS, 1000);
  };
  ws.onerror = () => ws.close();
}

document.getElementById("clear").onclick = async () => {
  if (!confirm("Delete all captured requests?")) return;
  await fetch("/dashboard/api/clear", { method: "POST" });
};

connectWS();
loadList();
