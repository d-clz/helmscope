/* helmscope UI. Plain DOM, no build step, no network beyond this server. */
(function () {
  "use strict";
  const HS = window.HS;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("hs:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("hs:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const S = {
    info: null,
    mode: store.get("mode", "chart"),
    charts: [], chartFilter: "",
    chart: null,          // chartRef in chart mode
    files: null,          // chartFiles of whatever is open
    helmfiles: [], hfFile: store.get("hfFile", ""), hfEnv: store.get("hfEnv", "default"),
    hf: null,             // { releases, res, error }
    release: null,        // helmfile release
    chartNote: "",
    busy: false,
    res: null, docs: [], notes: [], errors: [],
    layers: [],
    tab: "manifests",
    dsNodes: store.get("dsNodes", 3),
    headroom: store.get("headroom", 20),
    hideCats: store.get("hideCats", []),
    issuesOnly: false,
    nsHide: [],
    invQuery: "",
    invGroup: store.get("invGroup", true),
    invTab: "releases",
    relCache: new Map(),  // "<file>|<env>|<ns>/<release>" -> helmfile template result
    combining: null,      // { done, total } while releases render
    combined: null,       // last merged render: { docs, origin, ... }
    pendingJump: null,
    quotaYaml: {},
    fold: store.get("fold", true),
    docFilter: "",
    valFilter: "", onlyOverridden: false, onlyUnref: false,
    src: null,            // { file, hl: [lines] }
    pickedDoc: -1, pickedLine: -1,
    auto: store.get("auto", true),
    form: { release: "demo", namespace: "default", kubeVersion: "" },
  };

  async function api(path, body) {
    const r = await fetch("api/" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ---- boot ------------------------------------------------------------------

  async function boot() {
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); rerender(); }
    });
    try {
      S.info = await api("info");
      S.form.kubeVersion = S.info.kubeVersion || "";
    } catch (e) { S.info = { root: "?", helm: e.message }; }
    drawTop();
    await Promise.all([loadCharts(), loadHelmfiles()]);
    setMode(S.mode);
  }

  function drawTop() {
    const i = S.info || {};
    $("#root").textContent = i.root || "";
    $("#tools").innerHTML =
      `<span class="pill ${i.helmOK ? "" : "bad"}" title="helm">${esc(i.helmOK ? i.helm : "helm not found")}</span>` +
      `<span class="pill ${i.helmfileOK ? "" : "bad"}" title="helmfile">${esc(i.helmfileOK ? (i.helmfile || "").replace(/^helmfile version /, "helmfile ") : "helmfile not found")}</span>`;
  }

  async function loadCharts() { try { S.charts = await api("charts"); } catch (e) { S.charts = []; } }
  async function loadHelmfiles() {
    try { S.helmfiles = await api("helmfiles"); } catch (e) { S.helmfiles = []; }
    if (!S.helmfiles.some((h) => h.path === S.hfFile)) S.hfFile = S.helmfiles[0] ? S.helmfiles[0].path : "";
  }

  function setMode(m) {
    S.mode = m;
    store.set("mode", m);
    $("#m-chart").classList.toggle("on", m === "chart");
    $("#m-helmfile").classList.toggle("on", m === "helmfile");
    drawSide();
    drawMain();
  }

  // ---- sidebar ---------------------------------------------------------------

  function drawSide() {
    const el = $("#side-body");
    if (S.mode === "chart") {
      const f = S.chartFilter.toLowerCase();
      const items = S.charts.filter((c) => !f || (c.name + " " + c.path).toLowerCase().includes(f));
      el.innerHTML =
        `<div class="field"><input id="chart-filter" placeholder="Filter ${S.charts.length} charts" value="${esc(S.chartFilter)}"></div>` +
        (items.length ? `<ul class="list">${items.map((c) => `
          <li data-action="pick-chart" data-path="${esc(c.path)}" class="${S.chart && S.chart.path === c.path ? "on" : ""}">
            <div class="t">${esc(c.name)} <span class="tag">${esc(c.version || "?")}</span>${c.kind === "tgz" ? '<span class="tag">tgz</span>' : ""}</div>
            <div class="s" title="${esc(c.path)}">${esc(c.path)}</div>
          </li>`).join("")}</ul>` : `<p class="muted">No Chart.yaml found under the root.</p>`);
      return;
    }
    const hf = S.helmfiles.find((h) => h.path === S.hfFile);
    const envs = Array.from(new Set(["default"].concat(hf ? hf.envs : [])));
    let html = S.helmfiles.length ? `
      <div class="field"><label>Helmfile</label>
        <select id="hf-file">${S.helmfiles.map((h) => `<option ${h.path === S.hfFile ? "selected" : ""} value="${esc(h.path)}">${esc(h.path)}</option>`).join("")}</select></div>
      <div class="field"><label>Environment</label>
        <input id="hf-env" list="hf-envs" value="${esc(S.hfEnv)}"><datalist id="hf-envs">${envs.map((e) => `<option value="${esc(e)}">`).join("")}</datalist></div>
      <button class="btn primary" data-action="hf-load" style="width:100%">${S.busy && !S.release ? '<span class="spin"></span> ' : ""}Load releases</button>`
      : `<p class="muted">No helmfile.yaml, helmfile.yaml.gotmpl or helmfile.d/ found under the root.</p>`;
    if (S.hf && S.hf.releases.length) {
      const vis = visibleReleases();
      const nNs = HS.groupByNamespace(S.hf.releases).length;
      const item = (r) => `
        <li data-action="pick-release" data-id="${esc(r.id)}" class="${S.release && S.release.id === r.id ? "on" : ""}">
          <div class="t">${esc(r.name)}${r.installed ? "" : '<span class="tag warn">installed: false</span>'}</div>
          <div class="s">${S.invGroup ? "" : esc(r.namespace || "-") + " · "}${esc(r.chart)}${r.version ? "@" + esc(r.version) : ""}</div>
        </li>`;
      html += `<ul class="list" style="margin-top:10px">
        <li data-action="hf-inventory" class="${S.release ? "" : "on"}"><div class="t">Inventory</div><div class="s">${S.hf.releases.length} releases · ${nNs} namespace${nNs === 1 ? "" : "s"} · ${esc(S.hfEnv)}</div></li>
        ${vis.length < S.hf.releases.length ? `<li class="grp">showing ${vis.length} of ${S.hf.releases.length} <span class="link" data-action="ns-all">show all</span></li>` : ""}
        ${S.invGroup
          ? HS.groupByNamespace(vis).map((g) => `<li class="grp">${esc(nsLabel(g.ns))} <span class="muted">${g.releases.length}</span></li>${g.releases.map(item).join("")}`).join("")
          : vis.map(item).join("")}</ul>`;
    }
    el.innerHTML = html;
  }

  // ---- main ------------------------------------------------------------------

  function drawMain() {
    const el = $("#main");
    if (S.mode === "helmfile" && S.hf && !S.release) return drawInventory(el);
    if ((S.mode === "chart" && !S.chart) || (S.mode === "helmfile" && !S.release)) {
      el.innerHTML = `<div class="empty"><h2>${S.mode === "chart" ? "Pick a chart" : "Load a helmfile"}</h2>
        <p>${S.mode === "chart"
          ? "Edit values on the left, read the rendered manifests, click any line to see which template produced it."
          : "helmfile build --embed-values gives the release inventory; pick a release to render it."}</p>
        ${S.hf && S.hf.error ? `<div class="errbar" style="text-align:left">${esc(S.hf.error)}</div>` : ""}</div>`;
      return;
    }
    el.innerHTML = toolbarHTML() + `<div class="work ${S.src ? "" : "nosrc"}">
      <section class="pane left">${leftHTML()}</section>
      <section class="pane center">${centerHTML()}</section>
      ${S.src ? `<section class="pane source">${sourceHTML()}</section>` : ""}
    </div>`;
    afterDraw();
  }

  function toolbarHTML() {
    const r = S.res;
    const status = S.busy ? `<span class="spin"></span> rendering…`
      : r ? `${r.ok ? "✓" : "✗"} ${r.durationMs} ms · ${esc(r.cmd)}` : "";
    const statusCls = S.busy ? "" : r ? (r.ok ? "good" : "bad") : "";
    if (S.mode === "chart") {
      return `<div class="toolbar">
        <div class="title">${esc(S.chart.name)} <span class="tag">${esc(S.chart.version)}</span></div>
        <div class="field"><label>Release</label><input id="f-release" value="${esc(S.form.release)}" style="width:130px"></div>
        <div class="field"><label>Namespace</label><input id="f-namespace" value="${esc(S.form.namespace)}" style="width:130px"></div>
        <div class="field"><label>Kube version</label><input id="f-kube" value="${esc(S.form.kubeVersion)}" placeholder="helm default" style="width:110px"></div>
        <label class="ctl"><input type="checkbox" id="f-auto" ${S.auto ? "checked" : ""}> auto</label>
        <button class="btn primary" data-action="render" ${S.busy ? "disabled" : ""}>Render</button>
        <span class="status ${statusCls}" title="${esc(r ? r.cmd : "")}">${status}</span>
      </div>`;
    }
    const rel = S.release;
    return `<div class="toolbar">
      <button class="btn" data-action="hf-inventory">← Inventory</button>
      <div class="title">${esc(rel.name)} <span class="tag">${esc(rel.namespace || "-")}</span> <span class="tag">${esc(rel.chart)}${rel.version ? "@" + esc(rel.version) : ""}</span></div>
      <div class="field"><label>Kube version</label><input id="f-kube" value="${esc(S.form.kubeVersion)}" placeholder="helm default" style="width:110px"></div>
      <button class="btn primary" data-action="render" ${S.busy ? "disabled" : ""}>Render</button>
      <span class="status ${statusCls}" title="${esc(r ? r.cmd : "")}">${status}</span>
    </div>`;
  }

  function leftHTML() {
    if (S.mode === "chart") {
      const vals = store.get("values:" + S.chart.path, "");
      const set = store.get("set:" + S.chart.path, "");
      return `<div class="pane-h"><b>Values</b><span class="grow"></span>
          <span class="link" data-action="defaults">copy defaults</span><span class="link" data-action="clear-values">clear</span></div>
        <textarea id="values" spellcheck="false" placeholder="# your overrides, merged over values.yaml&#10;replicaCount: 2">${esc(vals)}</textarea>
        <textarea id="setlines" class="set" spellcheck="false" placeholder="--set lines, one per line&#10;image.tag=1.4.1">${esc(set)}</textarea>`;
    }
    const L = S.layers;
    return `<div class="pane-h"><b>Value layers</b><span class="grow"></span><span class="muted">low → high</span></div>
      <div class="pane-b">${L.map((l, i) => `
        <details class="layer" ${i > 0 && i < 3 ? "open" : ""}><summary>${i + 1}. ${esc(l.name)}</summary>
        <pre>${l.unresolved ? `<span class="muted">not embedded: ${esc(l.unresolved)}</span>` : esc(HS.dump(l.obj || {}))}</pre></details>`).join("")}
        ${S.chartNote ? `<p class="muted" style="padding:0 10px">${esc(S.chartNote)}</p>` : ""}</div>`;
  }

  function centerHTML() {
    const rows = valueRows();
    const topo = S.docs.length ? HS.buildTopology(S.docs, currentNs(), { nodes: S.dsNodes }) : null;
    const nWork = S.docs.filter((d) => d.obj && HS.podSpecOf(d)).length;
    const nIss = topo ? topo.issues.filter((i) => i.sev !== "info").length : 0;
    const tabs = [
      ["manifests", "Manifests", S.docs.length],
      ["map", "Map", nWork || ""],
      ["topology", "Topology", nIss ? `${nIss}!` : ""],
      ["values", "Values", rows.total],
      ["output", "Output", ""],
      ["log", "Log", S.errors.length || ""],
    ];
    const errs = S.errors.length ? `<div class="errbar">${S.errors.map((e) => `<div>${e.file && (e.line || e.renderedLine) ? `<span class="link" data-action="open-src" data-file="${esc(e.file)}" data-line="${e.line}">${esc(e.file)}${e.line ? ":" + e.line : ""}</span> ` : ""}${esc(e.msg)}</div>`).join("")}</div>`
      : S.res && !S.res.ok ? `<div class="errbar">${esc(lastLines(S.res.stderr, 6))}</div>` : "";
    let ctl = "";
    if (S.tab === "manifests") ctl = `<input id="doc-filter" placeholder="filter kind/name" value="${esc(S.docFilter)}" style="width:150px"><label class="ctl"><input type="checkbox" id="fold" ${S.fold ? "checked" : ""}> fold labels</label>`;
    if (S.tab === "values") ctl = `<input id="val-filter" placeholder="filter key" value="${esc(S.valFilter)}" style="width:140px">
      <label class="ctl"><input type="checkbox" id="only-over" ${S.onlyOverridden ? "checked" : ""}> overridden</label>
      <label class="ctl" title="No direct .Values reference found in templates"><input type="checkbox" id="only-unref" ${S.onlyUnref ? "checked" : ""}> unreferenced</label>`;
    return `<div class="pane-h"><div class="tabs">${tabs.map(([k, l, n]) => `<button data-action="tab" data-tab="${k}" class="${S.tab === k ? "on" : ""}">${l}${n !== "" ? `<span class="n ${String(n).endsWith("!") ? "bad" : ""}">${String(n).replace("!", "")}</span>` : ""}</button>`).join("")}</div><span class="grow"></span>${ctl}</div>
      ${errs}<div class="pane-b" id="center-b">${tabBody(rows, topo)}</div>`;
  }

  function tabBody(rows, topo) {
    switch (S.tab) {
      case "manifests": return manifestsHTML();
      case "map": return mapHTML(topo);
      case "topology": return topologyHTML(topo);
      case "values": return valuesHTML(rows);
      case "output": return `<pre class="code" style="padding:10px">${esc(S.res ? S.res.stdout : "")}</pre>`;
      case "log": return logHTML();
    }
    return "";
  }

  // ---- manifests -------------------------------------------------------------

  function docText(d) {
    if (!S.fold || !d.obj) return d.raw.replace(/^# Source: .*\n/m, "");
    return HS.dump(HS.fold(d.obj));
  }

  function yamlLine(l) {
    if (/^\s*#/.test(l)) return `<span class="cm">${esc(l)}</span>`;
    const m = l.match(/^(\s*(?:-\s+)?)([^:#'"\s][^:#]*?|"[^"]*"|'[^']*')(:)(\s|$)(.*)$/);
    if (!m) return esc(l);
    return esc(m[1]) + `<span class="tk">${esc(m[2])}</span>:` + esc(m[4] + m[5]);
  }

  function tplLine(l) {
    return l.split(/(\{\{.*?\}\})/).map((p, i) => (i % 2 ? `<span class="tp">${esc(p)}</span>` : yamlLine(p))).join("");
  }

  function codeHTML(text, hl, extra, fmt) {
    const lines = String(text).replace(/\n$/, "").split("\n");
    return lines.map((l, i) => `<span class="l${hl && hl.includes(i + 1) ? " hl" : ""}${extra && extra.picked === i ? " picked" : ""}" data-line="${i + 1}"${extra ? ` data-doc="${extra.doc}"` : ""}><span class="gut">${i + 1}</span>${fmt(l)}</span>`).join("");
  }

  function manifestsHTML() {
    if (!S.docs.length) return `<div class="empty">${S.busy ? "Rendering…" : S.res && !S.res.ok ? "Render failed. See the error above or the Log tab." : "Nothing rendered yet."}</div>`;
    const f = S.docFilter.toLowerCase();
    const docs = S.docs.filter((d) => !f || `${d.kind} ${d.name} ${d.source}`.toLowerCase().includes(f));
    let out = "";
    let lastSrc = null;
    docs.forEach((d) => {
      if (d.source !== lastSrc) {
        lastSrc = d.source;
        out += `<div class="group-h">${esc(d.source || "(no source)")}</div>`;
      }
      out += `<section class="doc ${S.pickedDoc === d.index ? "sel" : ""}" id="doc-${d.index}">
        <div class="doc-h" data-action="toggle-doc" data-doc="${d.index}">
          <span class="k">${esc(d.kind)}</span><span>${esc(d.name)}</span>
          ${d.namespace ? `<span class="tag">${esc(d.namespace)}</span>` : ""}${d.hook ? `<span class="tag warn">hook: ${esc(d.hook)}</span>` : ""}
          ${d.error ? `<span class="tag warn" title="${esc(d.error)}">YAML error</span>` : ""}
          ${d.source ? `<span class="src link" data-action="open-src" data-file="${esc(d.source)}">${esc(d.source.split("/").pop())}</span>` : ""}
        </div>
        <pre class="code">${codeHTML(docText(d), null, { doc: d.index, picked: S.pickedDoc === d.index ? S.pickedLine : -1 }, yamlLine)}</pre>
      </section>`;
    });
    if (S.notes.length) out += `<div class="group-h">notes</div><pre class="code" style="padding:6px 12px">${esc(S.notes.join("\n"))}</pre>`;
    return out;
  }

  // ---- map: every manifest as a card; resources summarised above ------------------

  const KIND_ABBR = {
    Deployment: "Deploy", StatefulSet: "STS", DaemonSet: "DS", ReplicaSet: "RS", Job: "Job", CronJob: "CJ", Pod: "Pod", DeploymentConfig: "DC", Rollout: "Ro",
    Service: "Svc", Ingress: "Ing", Route: "Route", HTTPRoute: "HTTP", GRPCRoute: "gRPC", NetworkPolicy: "NetP", ConfigMap: "CM", Secret: "Sec",
    PersistentVolumeClaim: "PVC", HorizontalPodAutoscaler: "HPA", PodDisruptionBudget: "PDB", ServiceAccount: "SA", Role: "Role", RoleBinding: "RB",
    ClusterRole: "CR", ClusterRoleBinding: "CRB", ResourceQuota: "RQ", LimitRange: "LR", CustomResourceDefinition: "CRD",
  };
  const abbr = (k) => KIND_ABBR[k] || (k.match(/[A-Z]/g) || [k[0]]).join("").slice(0, 4);
  const currentNs = () => (S.mode === "chart" ? S.form.namespace : S.release.namespace) || "default";
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const RANK = { error: 3, warn: 2, info: 1 };

  function resCell(m, k, unbounded) {
    const req = HS.fmtRes(k, m.req[k]);
    const lim = m.lim[k] == null ? "—" : HS.fmtRes(k, m.lim[k]) + (unbounded ? "+" : "");
    const limCls = m.lim[k] == null || unbounded ? "warnc" : "";
    return `<td><span class="${m.req[k] == null ? "warnc" : ""}">${esc(req)}</span><span class="muted"> / </span><span class="${limCls}" title="${unbounded ? "At least one container has no limit, so the real ceiling is higher" : ""}">${esc(lim)}</span></td>`;
  }

  const resHead = (keys) => keys.map((k) => `<th>${esc(k === "cpu" ? "CPU" : k === "memory" ? "Memory" : k)} <span class="muted">req / lim</span></th>`).join("");

  function totalsRows(t, unb, keys) {
    const rows = [[plural(t.pods, "pod"), t.total, ""]];
    if (t.podsMax !== t.pods) rows.push([`${t.podsMax} at HPA max`, t.max, ""]);
    if (t.podsPeak !== t.podsMax) rows.push([`${t.podsPeak} at rollout peak`, t.peak, "HPA max plus maxSurge pods during a rolling update: what a ResourceQuota has to allow"]);
    return rows.map(([label, res, tip]) => `<tr class="tot"><td title="${esc(tip)}">${esc(label)}</td>${keys.map((k) => resCell(res, k, unb.includes(k))).join("")}</tr>`).join("");
  }

  function podsLabel(w) {
    const r = w.replicas;
    let s = r.perNode ? `${r.n} (1/node)` : r.max != null ? `${r.n}–${r.max}` : String(r.n);
    if (w.surge) s += ` <span class="muted">+${w.surge} surge</span>`;
    return `<span title="${esc(r.note || "")}">${s}</span>`;
  }

  function resourcesPanel(m, keys, opts) {
    opts = opts || {};
    const spaces = m.namespaces.filter((ns) => ns.workloads.length);
    if (!spaces.length) return "";
    const a = m.all;
    const unbAll = keys.filter((k) => spaces.some((ns) => ns.unbounded.includes(k)));
    let html = `<details class="res-panel" ${store.get("resOpen", true) ? "open" : ""} id="res-panel">
      <summary><b>Resources</b> <span class="muted">${plural(a.workloads, "workload")} · ${plural(a.pods, "pod")}${a.podsPeak !== a.pods ? ` (${a.podsPeak} at peak)` : ""} · requests ${esc(HS.fmtCpu(a.total.req.cpu))} CPU, ${esc(HS.fmtBytes(a.total.req.memory))} memory</span></summary>
      <div class="res-body">`;
    if (spaces.length > 1) {
      html += `<table class="rt res-all"><thead><tr><th>All namespaces</th>${resHead(keys)}</tr></thead><tbody>${totalsRows(a, unbAll, keys)}</tbody></table>`;
    }
    spaces.forEach((ns) => {
      const notes = ns.workloads.flatMap((w) => w.notes.map((n) => Object.assign({ w }, n))).sort((x, y) => RANK[y.sev] - RANK[x.sev]);
      const q = HS.suggestQuota(ns, S.headroom);
      S.quotaYaml[ns.name] = q.yaml;
      html += `<section class="res-ns">
        <h4><span class="muted">Namespace</span> ${esc(ns.name || "cluster-scoped")}${ns.limitRange ? ` <span class="tag">LimitRange ${esc(ns.limitRange)}</span>` : ""}</h4>
        <div class="tbl-scroll"><table class="rt res-tbl"><thead><tr><th>Workload</th><th>QoS</th><th>Pods</th><th class="grp" colspan="${keys.length}">Per pod</th><th class="grp" colspan="${keys.length}">× replicas</th></tr>
          <tr><th></th><th></th><th></th>${resHead(keys)}${resHead(keys)}</tr></thead><tbody>
          ${ns.workloads.map((w) => `<tr data-action="jump-doc" data-doc="${w.doc}" class="wrow">
            <td>${esc(w.name)}<span class="kindt">${esc(w.kind)}${w.release ? " · " + esc(w.release) : ""}</span>${w.notes.some((n) => n.sev !== "info") ? ' <span class="dot warn" title="see notes below">!</span>' : ""}</td>
            <td><span class="qos q-${w.qos}">${w.qos}</span></td><td>${podsLabel(w)}</td>
            ${keys.map((k) => resCell(w.pod, k, w.pod.unbounded.includes(k))).join("")}
            ${keys.map((k) => resCell(w.total, k, w.pod.unbounded.includes(k))).join("")}</tr>`).join("")}
          </tbody></table></div>
        <table class="rt res-tot"><thead><tr><th>Namespace total</th>${resHead(keys)}</tr></thead><tbody>${totalsRows(ns, ns.unbounded, keys)}
          ${ns.storage.claims ? `<tr class="tot"><td>${plural(ns.storage.claims, "PVC")}</td><td colspan="${keys.length}">${esc(HS.fmtBytes(ns.storage.bytes))} storage requested${ns.workloads.some((w) => w.kind === "StatefulSet") ? " <span class=\"muted\">(StatefulSet claims × replicas)</span>" : ""}</td></tr>` : ""}</tbody></table>
        ${notes.length ? `<div class="notes"><div class="sub">Notes</div>${notes.map((n) => `<div class="note ${n.sev}" data-action="jump-doc" data-doc="${n.w.doc}"><b>${esc(n.w.name)}</b> ${esc(n.msg)}</div>`).join("")}</div>` : ""}
        ${!opts.quota ? `<div class="note info">ResourceQuota covers the whole namespace, so it's sized across every release in it, not this one alone.
          <span class="link" data-action="inv-map" data-ns="${esc(ns.name)}">Open the Map for namespace ${esc(ns.name)}</span></div>` : ""}
        ${opts.quota && ns.quotas.length ? `<div class="sub">Rendered ResourceQuota vs rollout peak</div><div class="quotas">${ns.quotas.map((qq) => {
          const pct = qq.hard ? Math.min(100, (qq.used / qq.hard) * 100) : 100;
          const f = (v) => (qq.count ? String(v) : HS.fmtRes(qq.res, v));
          return `<div class="q ${qq.over ? "over" : ""}" title="ResourceQuota ${esc(qq.quota)}"><span class="mono">${esc(qq.key)}</span><span class="bar"><i style="width:${pct}%"></i></span><span class="mono">${esc(f(qq.used))} / ${esc(f(qq.hard))}</span></div>`;
        }).join("")}</div>` : ""}
        ${opts.quota ? `<div class="suggest">
          <div class="sub">Suggested ResourceQuota${ns.suggestedLimitRange ? " + LimitRange" : ""}
            <label class="ctl">headroom <input class="headroom" id="headroom" type="number" min="0" max="300" step="5" value="${S.headroom}" style="width:62px">%</label>
            <button class="btn sm" data-action="copy-quota" data-ns="${esc(ns.name)}">Copy YAML</button></div>
          ${q.notes.map((n) => `<div class="note ${n.sev}">${esc(n.msg)}</div>`).join("")}
          <pre class="code yaml-out">${esc(q.yaml)}</pre>
        </div>` : ""}
      </section>`;
    });
    return html + `<p class="muted small">Effective pod request = max(app containers + sidecars, largest init container); a missing request falls back to the limit. A trailing <b>+</b> means a container has no limit. CronJob/Job pods count while running.</p></div></details>`;
  }

  function issuesByDoc(m, topo) {
    const out = new Map();
    const add = (doc, sev, msg) => {
      if (doc == null || doc < 0) return;
      const e = out.get(doc) || { sev: "info", msgs: [] };
      if (RANK[sev] > RANK[e.sev]) e.sev = sev;
      e.msgs.push(msg);
      out.set(doc, e);
    };
    m.namespaces.forEach((ns) => ns.workloads.forEach((w) => w.notes.forEach((n) => add(w.doc, n.sev, n.msg))));
    if (topo) topo.issues.forEach((i) => add(i.doc, i.sev, i.msg));
    return out;
  }

  function mapCard(c, iss) {
    const w = c.workload;
    const r = w && w.replicas;
    const stack = w && (r.max ?? r.n) > 1;
    const badgeText = !w ? "" : r.perNode ? `${r.n}<small>/node</small>` : r.max != null ? `${r.n}–${r.max}` : String(r.n);
    const status = iss && iss.sev !== "info" ? `<span class="mc-st ${iss.sev}" title="${esc(iss.msgs.join("\n"))}">${iss.sev === "error" ? "✗" : "!"}</span>` : "";
    return `<div class="mc ${stack ? "stack" : ""}" data-action="jump-doc" data-doc="${c.doc}" title="${esc(c.kind + " " + c.name + (c.detail ? "\n" + c.detail : ""))}">
      <span class="kic cat-${esc(c.category)}">${esc(abbr(c.kind))}</span>
      <div class="mc-t"><div class="mc-k">${esc(c.kind)}${c.release ? ` <span class="tag rel" title="release">${esc(c.release)}</span>` : ""}${c.hook ? ` <span class="tag warn">hook</span>` : ""}</div>
        <div class="mc-n">${esc(c.name)}</div>${c.detail ? `<div class="mc-d">${esc(c.detail)}</div>` : ""}</div>
      ${w ? `<span class="badge ${r.max != null ? "wide" : ""}" title="${esc(r.note || "replicas")}">${badgeText}</span>` : ""}${status}
    </div>`;
  }

  // mapHTML draws the Map tab. quota: show the ResourceQuota suggestion, which
  // only makes sense for a whole namespace (chart mode, helmfile inventory).
  function mapHTML(topo, docs, defaultNs, opts) {
    docs = docs || S.docs;
    opts = opts || { quota: S.mode === "chart" };
    if (!docs.length) return `<div class="empty">Nothing rendered yet.</div>`;
    const m = HS.buildMap(docs, defaultNs || currentNs(), { nodes: S.dsNodes });
    const extra = new Set();
    m.namespaces.forEach((ns) => ns.workloads.forEach((w) => [w.pod.req, w.pod.lim].forEach((x) => Object.keys(x).forEach((k) => k !== "cpu" && k !== "memory" && extra.add(k)))));
    const keys = ["cpu", "memory", ...extra];
    const iss = issuesByDoc(m, topo);
    const hasDS = m.namespaces.some((ns) => ns.workloads.some((w) => w.replicas.perNode));
    const counts = {};
    m.namespaces.forEach((ns) => ns.cards.forEach((c) => (counts[c.category] = (counts[c.category] || 0) + 1)));
    const nIss = [...iss.values()].filter((e) => e.sev !== "info").length;
    const show = (c) => !S.hideCats.includes(c.category) && (!S.issuesOnly || (iss.get(c.doc) && iss.get(c.doc).sev !== "info"));

    let out = `<div class="map">${resourcesPanel(m, keys, opts)}
      <div class="map-bar">${HS.CATEGORIES.filter((c) => counts[c]).map((c) => `<button class="fchip ${S.hideCats.includes(c) ? "" : "on"}" data-action="toggle-cat" data-cat="${c}"><span class="sw cat-${c}"></span>${c} <span class="muted">${counts[c]}</span></button>`).join("")}
        <button class="fchip ${S.issuesOnly ? "on" : ""}" data-action="toggle-issues" ${nIss ? "" : "disabled"}>Status: warning or error <span class="muted">${nIss}</span></button>
        ${hasDS ? `<label class="ctl">DaemonSet nodes <input id="ds-nodes" type="number" min="1" value="${S.dsNodes}" style="width:60px"></label>` : ""}
      </div>`;
    m.namespaces.forEach((ns) => {
      const cards = ns.cards.filter(show);
      if (!cards.length) return;
      out += `<section class="ns"><div class="ns-h">${ns.name ? `Namespace <b>${esc(ns.name)}</b>` : "<b>Cluster-scoped</b>"} <span class="muted small">${plural(ns.cards.length, "manifest")}</span></div>
        <div class="mc-grid">${cards.map((c) => mapCard(c, iss.get(c.doc))).join("")}</div></section>`;
    });
    return out + `</div>`;
  }

  // ---- topology: how traffic gets from the edge to pods ------------------------------

  function topologyHTML(t) {
    if (!t) return `<div class="empty">Nothing rendered yet.</div>`;
    const iss = t.issues.length ? `<div class="issues">${t.issues.map((i) => `<div class="iss ${i.sev}" ${i.doc >= 0 ? `data-action="jump-doc" data-doc="${i.doc}"` : ""}><b>${i.sev === "error" ? "broken" : i.sev === "warn" ? "check" : "note"}</b> ${esc(i.msg)}</div>`).join("")}</div>` : "";
    const unexp = t.unexposed.length ? `<p class="muted" style="margin:10px 0 0">Not behind any Service: ${t.unexposed.map((u) => `<span class="chip" data-action="jump-doc" data-doc="${u.doc}">${esc(u.kind)} ${esc(u.name)}</span>`).join(" ")}</p>` : "";
    if (!t.nodes.length) return `<div class="graph-wrap">${iss}<div class="empty">No Services, Ingresses, Routes or HTTPRoutes in this render.</div>${unexp}</div>`;

    const used = [...new Set(t.nodes.map((n) => n.col))].sort((x, y) => x - y);
    const cx = new Map(used.map((c, i) => [c, i]));
    const W = 206, H = 66, GX = 140, GY = 16, TOP = 26;
    const pos = new Map(t.nodes.map((n) => [n.id, { x: cx.get(n.col) * (W + GX), y: TOP + n.row * (H + GY) }]));
    const rows = Math.max(1, ...t.nodes.map((n) => n.row + 1));
    const width = used.length * (W + GX) - GX + 2, height = TOP + rows * (H + GY);
    const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    const colors = ["--c6", "--c0", "--c1", "--c2"];
    const byId = new Map(t.nodes.map((n) => [n.id, n]));

    let labels = "";
    const edges = t.edges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return "";
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, dx = Math.max(40, (x2 - x1) / 2);
      const text = e.labels.join(" · ");
      const bad = text.includes("✗");
      const ghost = byId.get(e.to) && byId.get(e.to).ghost;
      if (text) labels += `<text class="elabel ${bad ? "bad" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle"><title>${esc(text)}</title>${esc(clip(text, 30))}</text>`;
      return `<path class="edge ${bad ? "bad" : ""} ${ghost ? "dash" : ""}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#arr)"></path>`;
    }).join("");

    const nodes = t.nodes.map((n) => {
      const p = pos.get(n.id);
      const color = `var(${colors[n.col] || "--c6"})`;
      const kind = n.kind === "Host" ? (n.tls ? "HTTPS" : "HTTP") : n.kind;
      const detail = n.lines.concat(n.internal ? ["cluster-internal"] : []).join(" · ");
      const tip = [`${n.kind} ${n.name}`].concat(n.lines, n.ghost ? ["Referenced but not rendered by this chart"] : [], n.doc >= 0 ? ["Click to open the manifest"] : []).join("\n");
      return `<g class="node ${n.ghost ? "ghost" : ""}" data-id="${esc(n.id)}" ${n.doc >= 0 ? `data-action="jump-doc" data-doc="${n.doc}"` : ""} transform="translate(${p.x},${p.y})">
        <title>${esc(tip)}</title><rect width="${W}" height="${H}" style="stroke:${color}"></rect>
        <rect width="4" height="${H}" style="fill:${color};stroke:none" rx="2"></rect>
        <text class="kind" x="12" y="16">${esc(kind)}${n.tls ? " 🔒" : ""}${n.ghost ? " · not rendered" : ""}</text>
        <text x="12" y="34">${esc(clip(n.name, 27))}</text>
        <text class="detail" x="12" y="52">${esc(clip(detail, 32))}</text></g>`;
    }).join("");
    const heads = used.map((c) => `<text class="colh" x="${cx.get(c) * (W + GX)}" y="12">${esc(t.columns[c])}</text>`).join("");
    return `<div class="graph-wrap">${iss}
      <p class="muted" style="margin:8px 0">Left to right: where a request enters, which router matches it, the Service port it hits, and the container port it lands on. Hover to trace a path; click to open the manifest.</p>
      <div class="svg-scroll"><svg class="graph fit" id="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"></path></marker></defs>
      ${heads}${edges}${nodes}${labels}</svg></div>${unexp}</div>`;
  }

  // ---- values ----------------------------------------------------------------

  function valueRows() {
    if (!S.layers.length) return { rows: [], removed: [], total: 0 };
    const p = HS.provenance(S.layers);
    const refs = S.files ? HS.valueRefs(S.files.files, S.files.root) : null;
    p.rows.forEach((r) => (r.ref = refs ? HS.isReferenced(refs, r.parts) : true));
    return { rows: p.rows, removed: p.removed, total: p.rows.length };
  }

  const short = (v) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? "" : s.length > 160 ? s.slice(0, 159) + "…" : s;
  };

  function valuesHTML(all) {
    const f = S.valFilter.toLowerCase();
    const rows = all.rows.filter((r) => (!f || r.path.toLowerCase().includes(f)) && (!S.onlyOverridden || r.overridden) && (!S.onlyUnref || !r.ref));
    if (!all.rows.length) return `<div class="empty">No values.</div>`;
    return `<table class="vals"><thead><tr><th>Key</th><th>Value</th><th>Set by</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="k">${esc(r.path)}${r.ref ? "" : ' <span class="tag warn" title="No direct .Values reference in templates. It may still be read through with/range/tpl.">unreferenced?</span>'}</td>
        <td class="v">${r.history.slice(0, -1).map((h) => `<span class="old" title="${esc(h.layer)}">${esc(short(h.value))}</span>`).join("")}${esc(short(r.value))}</td>
        <td><span class="by">${esc(r.setBy)}</span></td></tr>`).join("")}
      </tbody></table>
      ${all.removed.length ? `<p class="muted" style="padding:0 10px">Removed with null: ${all.removed.map((x) => `<span class="mono">${esc(x.path)}</span> (${esc(x.layer)})`).join(", ")}</p>` : ""}
      <p class="muted" style="padding:0 10px">${rows.length} of ${all.rows.length} keys. Lists are replaced, not merged, as in Helm.</p>`;
  }

  // ---- log -------------------------------------------------------------------

  function logHTML() {
    const r = S.res;
    if (!r) return `<div class="empty">No run yet.</div>`;
    return `<div style="padding:10px">
      <div class="mono" style="margin-bottom:8px">$ ${esc(r.cmd)}</div>
      <div class="muted">exit ${r.ok ? "0" : "non-zero"} · ${r.durationMs} ms</div>
      <pre class="code" style="padding:8px 0;white-space:pre-wrap">${esc(r.stderr || "(no stderr)")}</pre>
      ${S.chartNote ? `<p class="muted">${esc(S.chartNote)}</p>` : ""}</div>`;
  }

  function lastLines(s, n) { return String(s || "").trim().split("\n").slice(-n).join("\n"); }

  // ---- source pane -----------------------------------------------------------

  function sourceHTML() {
    const files = S.files ? S.files.files : {};
    const names = Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const file = S.src.file;
    const text = files[file];
    const defs = HS.defines(files);
    const helpers = text != null ? HS.helpersClosure(text, defs, files) : [];
    return `<div class="pane-h"><select id="src-file" style="flex:1">${(names.includes(file) ? names : [file].concat(names)).map((n) => `<option ${n === file ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <button class="btn" data-action="close-src" title="Close">✕</button></div>
      ${helpers.length ? `<div class="helpers"><span class="muted">helpers:</span>${helpers.map((h) => h.def
        ? `<span class="link" data-action="open-src" data-file="${esc(h.def.file)}" data-line="${h.def.line}">${esc(h.name)}</span>`
        : `<span class="muted mono" title="define not found in chart files">${esc(h.name)}</span>`).join("")}</div>` : ""}
      <div class="pane-b" id="src-b">${text == null
        ? `<div class="empty">${S.files ? "This file is not in the chart files." : "Chart source isn't available for this release."}<br><span class="mono">${esc(file)}</span></div>`
        : `<pre class="code src-pre">${codeHTML(text, S.src.hl, null, tplLine)}</pre>`}</div>`;
  }

  function rank(n) {
    if (/\/templates\/[^/]+$/.test(n) && !n.includes("/charts/")) return 0;
    if (/\/templates\//.test(n) && !n.includes("/charts/")) return 1;
    if (!n.includes("/charts/")) return 2;
    return 3;
  }

  function openSrc(file, hl) {
    S.src = { file, hl: hl || [] };
    drawMain();
  }

  // ---- after draw ------------------------------------------------------------

  function afterDraw() {
    if (S.src && S.src.hl.length) {
      const el = $(`#src-b .l[data-line="${S.src.hl[0]}"]`);
      if (el) el.scrollIntoView({ block: "center" });
    }
    const g = $("#graph");
    if (g) {
      // hover traces every path through the node: all upstream and downstream hops
      const E = [...g.querySelectorAll(".edge")].map((p) => [p.dataset.from, p.dataset.to]);
      const reach = (start, fwd) => {
        const seen = new Set([start]);
        const q = [start];
        while (q.length) {
          const x = q.pop();
          E.forEach(([f, t]) => {
            const [a, b] = fwd ? [f, t] : [t, f];
            if (a === x && !seen.has(b)) { seen.add(b); q.push(b); }
          });
        }
        return seen;
      };
      g.addEventListener("mouseover", (e) => {
        const n = e.target.closest(".node");
        if (!n) return;
        const down = reach(n.dataset.id, true), up = reach(n.dataset.id, false);
        g.classList.add("focus");
        g.querySelectorAll(".near").forEach((x) => x.classList.remove("near"));
        g.querySelectorAll(".node").forEach((m) => (down.has(m.dataset.id) || up.has(m.dataset.id)) && m.classList.add("near"));
        g.querySelectorAll(".edge, .elabel").forEach((p) => {
          const f = p.dataset.from, t = p.dataset.to;
          if ((down.has(f) && down.has(t)) || (up.has(f) && up.has(t))) p.classList.add("near");
        });
      });
      g.addEventListener("mouseleave", () => g.classList.remove("focus"));
    }
  }

  document.addEventListener("toggle", (e) => { if (e.target.id === "res-panel") store.set("resOpen", e.target.open); }, true);

  function copyText(text, btn) {
    const done = (ok) => { btn.textContent = ok ? "Copied" : "Select and copy"; setTimeout(() => (btn.textContent = "Copy YAML"), 1500); };
    try {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(selectPre(btn)));
    } catch (e) { done(selectPre(btn)); }
  }
  function selectPre(btn) {
    const pre = btn.closest(".suggest").querySelector("pre");
    const r = document.createRange();
    r.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return false;
  }

  function redrawKeepScroll() {
    const c = $("#center-b");
    const top = c ? c.scrollTop : 0;
    drawMain();
    const c2 = $("#center-b");
    if (c2) c2.scrollTop = top;
  }

  // ---- events ----------------------------------------------------------------

  function onClick(e) {
    if (e.target.closest("summary")) return; // let <details> toggle
    const t = e.target.closest("[data-action]");
    const line = e.target.closest(".code .l[data-doc]");
    if (line && !t) return pickLine(+line.dataset.doc, +line.dataset.line);
    if (!t) return;
    const a = t.dataset.action;
    switch (a) {
      case "mode": return setMode(t.dataset.mode);
      case "pick-chart": return pickChart(t.dataset.path);
      case "render": return rerender(true);
      case "tab": S.tab = t.dataset.tab; return drawMain();
      case "open-src": e.stopPropagation(); return openSrc(t.dataset.file, t.dataset.line && +t.dataset.line ? [+t.dataset.line] : []);
      case "close-src": S.src = null; return drawMain();
      case "toggle-doc": return t.parentElement.classList.toggle("collapsed");
      case "defaults": {
        const ta = $("#values");
        ta.value = S.files ? S.files.values : "";
        store.set("values:" + S.chart.path, ta.value);
        return rerender(true);
      }
      case "clear-values": $("#values").value = ""; store.set("values:" + S.chart.path, ""); return rerender(true);
      case "hf-load": return hfLoad();
      case "hf-inventory": S.release = null; S.src = null; drawSide(); return drawMain();
      case "pick-release": return pickRelease(t.dataset.id);
      case "toggle-cat": {
        const c = t.dataset.cat;
        S.hideCats = S.hideCats.includes(c) ? S.hideCats.filter((x) => x !== c) : S.hideCats.concat(c);
        store.set("hideCats", S.hideCats);
        return redrawKeepScroll();
      }
      case "toggle-issues": S.issuesOnly = !S.issuesOnly; return redrawKeepScroll();
      case "copy-quota": return copyText(S.quotaYaml[t.dataset.ns] || "", t);
      case "ns-toggle": {
        const ns = t.dataset.ns;
        const names = HS.groupByNamespace(S.hf.releases).map((g) => g.ns);
        if (e.shiftKey) return setNsHide(names.filter((n) => n !== ns));
        return setNsHide(S.nsHide.includes(ns) ? S.nsHide.filter((n) => n !== ns) : S.nsHide.concat(ns));
      }
      case "ns-only": {
        const ns = t.dataset.ns;
        return setNsHide(HS.groupByNamespace(S.hf.releases).map((g) => g.ns).filter((n) => n !== ns));
      }
      case "ns-all": return setNsHide([]);
      case "inv-tab": S.invTab = t.dataset.tab; return drawMain();
      case "comb-refresh":
        visibleReleases().forEach((r) => S.relCache.delete(relKey(r)));
        return drawMain();
      case "inv-map": {
        const ns = t.dataset.ns;
        S.release = null; S.src = null; S.invTab = "map";
        return setNsHide(HS.groupByNamespace(S.hf.releases).map((g) => g.ns).filter((n) => n !== ns));
      }
      case "jump-doc": {
        const d = +t.dataset.doc;
        if (d < 0) return;
        if (S.mode === "helmfile" && !S.release && S.combined && S.combined.origin[d]) {
          const o = S.combined.origin[d];
          S.pendingJump = o.idx;
          return pickRelease(o.rel);
        }
        S.tab = "manifests";
        S.pickedDoc = d; S.pickedLine = -1;
        drawMain();
        const el = $("#doc-" + d);
        if (el) el.scrollIntoView({ block: "start" });
        return;
      }
    }
  }

  function pickLine(docIdx, lineNo) {
    const d = S.docs[docIdx];
    if (!d) return;
    const text = docText(d).split("\n")[lineNo - 1] || "";
    S.pickedDoc = docIdx; S.pickedLine = lineNo - 1;
    const tpl = S.files && S.files.files[d.source];
    S.src = { file: d.source, hl: tpl ? HS.mapLine(text, tpl) : [] };
    redrawKeepScroll();
  }

  let debounce = 0;
  function onInput(e) {
    // text fields act on "input"; checkboxes and selects act on "change"
    const toggle = e.target.type === "checkbox" || e.target.type === "number" || e.target.tagName === "SELECT";
    if (toggle !== (e.type === "change")) return;
    const id = e.target.id;
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    switch (id) {
      case "chart-filter": S.chartFilter = v; drawSide(); { const f = $("#chart-filter"); f.focus(); f.setSelectionRange(v.length, v.length); } return;
      case "hf-file": S.hfFile = v; store.set("hfFile", v); S.hf = null; S.release = null; drawSide(); return drawMain();
      case "hf-env": S.hfEnv = v; store.set("hfEnv", v); return;
      case "f-release": S.form.release = v; return schedule();
      case "f-namespace": S.form.namespace = v; return schedule();
      case "f-kube": S.form.kubeVersion = v; return schedule();
      case "f-auto": S.auto = v; store.set("auto", v); return;
      case "values": store.set("values:" + S.chart.path, v); return schedule();
      case "setlines": store.set("set:" + S.chart.path, v); return schedule();
      case "fold": S.fold = v; store.set("fold", v); return redrawKeepScroll();
      case "only-over": S.onlyOverridden = v; return drawMain();
      case "only-unref": S.onlyUnref = v; return drawMain();
      case "inv-group": S.invGroup = v; store.set("invGroup", v); drawSide(); return drawMain();
      case "inv-q": {
        S.invQuery = v;
        drawSide();
        drawMain();
        const el = $("#inv-q");
        if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
        return;
      }
      case "headroom": S.headroom = Math.max(0, parseInt(v, 10) || 0); store.set("headroom", S.headroom); return redrawKeepScroll();
      case "ds-nodes": S.dsNodes = Math.max(1, parseInt(v, 10) || 1); store.set("dsNodes", S.dsNodes); return redrawKeepScroll();
      case "src-file": return openSrc(v, []);
      case "doc-filter": case "val-filter": {
        if (id === "doc-filter") S.docFilter = v; else S.valFilter = v;
        drawMain();
        const el = $("#" + id);
        if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
        return;
      }
    }
  }

  function schedule() {
    if (!S.auto || S.mode !== "chart") return;
    clearTimeout(debounce);
    debounce = setTimeout(() => rerender(false), 700);
  }

  // ---- chart mode ------------------------------------------------------------

  async function pickChart(path) {
    S.chart = S.charts.find((c) => c.path === path);
    S.files = null; S.src = null; S.res = null; S.docs = []; S.errors = []; S.notes = []; S.pickedDoc = -1;
    S.chartNote = "";
    drawSide();
    drawMain();
    try {
      S.files = await api("chart/files?path=" + encodeURIComponent(path));
    } catch (e) {
      S.chartNote = e.message;
    }
    rerender(true);
  }

  function chartLayers() {
    const L = [];
    const files = S.files ? S.files.files : {};
    const root = S.files ? S.files.root : "";
    // Subchart defaults sit under the subchart's key, below the parent's values.
    Object.keys(files).filter((f) => /\/charts\/[^/]+\/values\.yaml$/.test(f) && f.startsWith(root + "/charts/")).forEach((f) => {
      const parts = f.slice(root.length + 1).split("/");
      if (parts.length !== 3) return; // first-level subcharts only
      const sub = parts[1];
      const obj = safeLoad(files[f]);
      if (HS.isObj(obj)) L.push({ name: `${sub} values.yaml`, obj: { [sub]: obj } });
    });
    L.push({ name: "chart values.yaml", obj: safeLoad(S.files ? S.files.values : "") || {} });
    return L;
  }

  function safeLoad(t) { try { return HS.yaml.load(t || "") || {}; } catch (e) { return null; } }

  async function rerender(force) {
    if (S.mode === "helmfile") return S.release && renderRelease(false, true);
    if (!S.chart) return;
    if (S.busy) { S.pending = true; return; }
    const valuesText = $("#values") ? $("#values").value : store.get("values:" + S.chart.path, "");
    const setText = $("#setlines") ? $("#setlines").value : store.get("set:" + S.chart.path, "");
    const setLines = setText.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    S.busy = true;
    refreshToolbar();
    let res;
    try {
      res = await api("render", { chart: S.chart.path, release: S.form.release, namespace: S.form.namespace, values: valuesText, set: setLines, kubeVersion: S.form.kubeVersion });
    } catch (e) {
      res = { ok: false, stdout: "", stderr: e.message, cmd: "", durationMs: 0 };
    }
    S.busy = false;
    const user = safeLoad(valuesText);
    S.layers = chartLayers().concat([{ name: "your values", obj: user || {} }, { name: "--set", obj: HS.parseSet(setLines) }]);
    if (user === null) res.stderr = "values editor: YAML does not parse\n" + res.stderr;
    applyResult(res);
    if (S.pending) { S.pending = false; rerender(true); }
  }

  function refreshToolbar() {
    const tb = $(".toolbar");
    if (!tb) return drawMain();
    const tmp = document.createElement("div");
    tmp.innerHTML = toolbarHTML();
    // keep focused inputs alive: only swap the status and button
    tb.querySelector(".status").replaceWith(tmp.querySelector(".status"));
    tb.querySelector('[data-action="render"]').replaceWith(tmp.querySelector('[data-action="render"]'));
  }

  function applyResult(res) {
    S.res = res;
    const sp = HS.splitManifest(res.stdout);
    S.docs = sp.docs;
    S.notes = sp.notes;
    S.errors = HS.parseErrors(res.stderr);
    if (S.pickedDoc >= S.docs.length) S.pickedDoc = -1;
    // keep the editor focused while auto-rendering
    const active = document.activeElement;
    const id = active && active.id;
    const sel = active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
    const leftScroll = $("#values") ? $("#values").scrollTop : 0;
    redrawKeepScroll();
    if (id && $("#" + id)) {
      const el = $("#" + id);
      el.focus();
      if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ }
    }
    if ($("#values")) $("#values").scrollTop = leftScroll;
  }

  // ---- helmfile mode -----------------------------------------------------------

  async function hfLoad() {
    if (!S.hfFile) return;
    S.busy = true; S.release = null; S.hf = null; S.relCache = new Map(); S.combined = null;
    drawSide(); drawMain();
    let res;
    try {
      res = await api("helmfile/build", { file: S.hfFile, env: S.hfEnv });
    } catch (e) {
      res = { ok: false, stdout: "", stderr: e.message };
    }
    S.busy = false;
    const st = HS.parseHelmfileState(res.stdout);
    S.hf = { releases: st.releases, res, error: res.ok ? st.error : lastLines(res.stderr, 12) || st.error };
    const known = new Set(st.releases.map((r) => r.namespace || ""));
    S.nsHide = store.get(nsStoreKey(), []).filter((n) => known.has(n));
    drawSide(); drawMain();
  }

  // ---- helmfile inventory: namespace filter + grouping -------------------------

  const nsLabel = (ns) => ns || "(no namespace)";
  const nsStoreKey = () => `nsHide:${S.hfFile}:${S.hfEnv}`;

  function visibleReleases() {
    if (!S.hf) return [];
    const q = S.invQuery.trim().toLowerCase();
    return S.hf.releases.filter((r) => !S.nsHide.includes(r.namespace || "") && (!q || `${r.name} ${r.chart} ${r.namespace}`.toLowerCase().includes(q)));
  }

  function setNsHide(list) {
    S.nsHide = list;
    store.set(nsStoreKey(), list);
    drawSide();
    drawMain();
  }

  function invGraphHTML(R, depth) {
    const grouped = S.invGroup;
    const W = 200, H = 42, GX = 70, GY = 12, TOP = 22, PAD = grouped ? 14 : 0, HEAD = grouped ? 28 : 0;
    const ids = new Set(R.map((r) => r.id));
    const all = new Set(S.hf.releases.map((r) => r.id));
    const maxD = Math.max(0, ...R.map((r) => depth.get(r.id) || 0));
    const pos = new Map();
    const bands = [];
    let y = TOP;
    (grouped ? HS.groupByNamespace(R) : [{ ns: null, releases: R }]).forEach((g) => {
      const cols = Array.from({ length: maxD + 1 }, () => []);
      g.releases.forEach((r) => cols[depth.get(r.id) || 0].push(r));
      const rows = Math.max(1, ...cols.map((c) => c.length));
      cols.forEach((c, i) => c.forEach((r, j) => pos.set(r.id, { x: PAD + i * (W + GX), y: y + HEAD + j * (H + GY) })));
      const h = HEAD + rows * (H + GY) - GY + (grouped ? 12 : GY);
      if (grouped) bands.push({ ns: g.ns, y, h, n: g.releases.length });
      y += h + (grouped ? 14 : 0);
    });
    const width = 2 * PAD + (maxD + 1) * (W + GX) - GX + 2;
    const height = y;
    const bandsSvg = bands.map((b) => `<g class="band" data-action="ns-only" data-ns="${esc(b.ns)}"><title>Show only ${esc(nsLabel(b.ns))}</title>
      <rect x="1" y="${b.y}" width="${width - 2}" height="${b.h}" rx="10"></rect>
      <text x="${PAD}" y="${b.y + 18}"><tspan class="bl">namespace</tspan> ${esc(nsLabel(b.ns))} <tspan class="bl">· ${b.n}</tspan></text></g>`).join("");
    const edges = R.flatMap((r) => r.needs.filter((n) => ids.has(n)).map((n) => {
      const a = pos.get(n), b = pos.get(r.id);
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, dx = Math.max(30, Math.abs(x2 - x1) / 2);
      return `<path class="edge" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#arr2)"></path>`;
    })).join("");
    const nodes = R.map((r) => {
      const p = pos.get(r.id);
      const hidden = r.needs.filter((n) => all.has(n) && !ids.has(n));
      const sub = grouped ? r.chart : r.namespace || "-";
      return `<g class="node ${r.installed ? "" : "ghost"}" data-action="pick-release" data-id="${esc(r.id)}" transform="translate(${p.x},${p.y})">
        <title>${esc(r.id)}\n${esc(r.chart)}${r.version ? "@" + esc(r.version) : ""}${hidden.length ? "\nneeds (filtered out): " + esc(hidden.join(", ")) : ""}</title>
        <rect width="${W}" height="${H}" style="stroke:var(--c${(depth.get(r.id) || 0) % 6})"></rect>
        <text class="kind" x="10" y="15">${esc(sub.length > 26 ? sub.slice(0, 25) + "…" : sub)}${hidden.length ? ` · +${hidden.length} hidden need${hidden.length > 1 ? "s" : ""}` : ""}</text>
        <text x="10" y="31">${esc(r.name)}</text></g>`;
    }).join("");
    const heads = Array.from({ length: maxD + 1 }, (_, i) => `<text class="colh" x="${PAD + i * (W + GX)}" y="12">${i === 0 ? "no needs" : "needs depth " + i}</text>`).join("");
    return `<svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><marker id="arr2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"></path></marker></defs>
      ${bandsSvg}${heads}${edges}${nodes}</svg>`;
  }

  function drawInventory(el) {
    const ALL = S.hf.releases;
    const R = visibleReleases();
    const { depth, cycles, missing } = HS.needsLayers(ALL);
    const groups = HS.groupByNamespace(ALL);
    const grouped = S.invGroup;
    const row = (r) => `<tr class="r ${r.installed ? "" : "off"}" data-action="pick-release" data-id="${esc(r.id)}">
      <td><b>${esc(r.name)}</b>${r.installed ? "" : ' <span class="tag warn">installed: false</span>'}${r.condition ? ` <span class="tag" title="condition">${esc(r.condition)}</span>` : ""}</td>
      ${grouped ? "" : `<td class="mono">${esc(r.namespace || "-")}</td>`}<td class="mono">${esc(r.chart)}</td><td class="mono">${esc(r.version || "")}</td>
      <td class="mono">${r.needs.map((n) => esc(n)).join("<br>")}</td>
      <td class="mono">${Object.entries(r.labels).map(([k, v]) => esc(k + "=" + v)).join("<br>")}</td>
      <td>${r.values.length} file${r.values.length === 1 ? "" : "s"}${r.set.length ? ` · ${r.set.length} set` : ""}</td></tr>`;
    const ncols = grouped ? 6 : 7;
    const body = !R.length
      ? `<tr><td colspan="${ncols}" class="muted">No releases match the filter.</td></tr>`
      : grouped
        ? HS.groupByNamespace(R).map((g) => `<tr class="nsrow"><td colspan="${ncols}"><span class="muted">namespace</span> <b>${esc(nsLabel(g.ns))}</b> <span class="muted">· ${g.releases.length}</span>
            <span class="link" data-action="ns-only" data-ns="${esc(g.ns)}">only this</span></td></tr>${g.releases.map(row).join("")}`).join("")
        : R.map(row).join("");
    const chips = groups.map((g) => `<button class="fchip ${S.nsHide.includes(g.ns) ? "" : "on"}" data-action="ns-toggle" data-ns="${esc(g.ns)}" title="Click to toggle · Shift+click to show only this namespace">${esc(nsLabel(g.ns))} <span class="muted">${g.releases.length}</span></button>`).join("");
    el.innerHTML = `<div class="toolbar"><div class="title">${esc(S.hfFile)}</div><span class="tag">env: ${esc(S.hfEnv)}</span>
        <span class="grow"></span><span class="status ${S.hf.res.ok ? "good" : "bad"}" title="${esc(S.hf.res.cmd || "")}">${S.hf.res.ok ? "✓" : "✗"} ${esc(S.hf.res.cmd || "")}</span></div>
      ${S.hf.error ? `<div class="errbar">${esc(S.hf.error)}</div>` : ""}
      <div class="inv">
        <div class="inv-bar">
          <input id="inv-q" placeholder="filter releases or charts" value="${esc(S.invQuery)}" style="width:200px">
          <span class="sub">Namespaces</span>${chips}
          ${S.nsHide.length ? `<button class="fchip" data-action="ns-all">show all</button>` : ""}
          <span class="grow"></span>
          <label class="ctl"><input type="checkbox" id="inv-group" ${grouped ? "checked" : ""}> group by namespace</label>
        </div>
        <div class="tabs inv-tabs">${[["releases", "Releases"], ["map", "Map"], ["topology", "Topology"]].map(([k, l]) => `<button data-action="inv-tab" data-tab="${k}" class="${S.invTab === k ? "on" : ""}">${l}</button>`).join("")}
          <span class="muted small">${S.invTab === "releases" ? "" : `all ${plural(R.filter((r) => r.installed).length, "release")} in the filter, rendered together`}</span></div>
        ${S.invTab !== "releases" ? combinedHTML() : `
        <div class="card"><h3>Releases <span class="muted">(${R.length === ALL.length ? ALL.length : `${R.length} of ${ALL.length}`})</span></h3>
        <table><thead><tr><th>Release</th>${grouped ? "" : "<th>Namespace</th>"}<th>Chart</th><th>Version</th><th>Needs</th><th>Labels</th><th>Values</th></tr></thead><tbody>
        ${body}
        </tbody></table></div>
        <div class="card"><h3>Dependency order <span class="muted">(needs)</span></h3>
          ${cycles.length ? `<div class="errbar">Cycle through: ${cycles.map(esc).join(", ")}</div>` : ""}
          ${missing.length ? `<div class="errbar">Missing needs: ${missing.map((m) => `${esc(m.from)} → ${esc(m.to)}`).join(", ")}</div>` : ""}
          <div class="graph-wrap">${R.length ? invGraphHTML(R, depth) : `<p class="muted">No releases match the filter.</p>`}</div></div>`}
      </div>`;
  }

  // ---- combined render: every release in the filter, merged ---------------------

  const relKey = (r) => `${S.hfFile}|${S.hfEnv}|${r.id}`;
  const inflight = new Set();
  let redrawTimer = 0;

  // redrawInventory repaints without losing focus in the filter box.
  function redrawInventory() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (S.mode !== "helmfile" || S.release || !S.hf) return;
      const a = document.activeElement;
      const id = a && a.id;
      const sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
      const b = $("#main .inv");
      const top = b ? b.scrollTop : 0;
      drawMain();
      const b2 = $("#main .inv");
      if (b2) b2.scrollTop = top;
      if (id && $("#" + id)) {
        $("#" + id).focus();
        if (sel) try { $("#" + id).setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ }
      }
    }, 60);
  }

  function ensureCombined(releases) {
    const todo = releases.filter((r) => !S.relCache.has(relKey(r)) && !inflight.has(relKey(r)));
    if (!todo.length) return;
    todo.forEach((r) => inflight.add(relKey(r)));
    S.combining = S.combining || { done: 0, total: 0 };
    S.combining.total += todo.length;
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        const key = relKey(r);
        let res;
        try {
          res = await api("helmfile/template", { file: S.hfFile, env: S.hfEnv, release: r.name, namespace: r.namespace, kubeVersion: S.form.kubeVersion });
        } catch (e) {
          res = { ok: false, stdout: "", stderr: e.message, cmd: "", durationMs: 0 };
        }
        inflight.delete(key);
        if (!key.startsWith(`${S.hfFile}|${S.hfEnv}|`)) continue; // helmfile/env changed meanwhile
        S.relCache.set(key, res);
        if (S.combining) S.combining.done++;
        if (!inflight.size) S.combining = null;
        redrawInventory();
      }
    };
    Array.from({ length: Math.min(4, todo.length) }, worker);
  }

  function combinedDocs(releases) {
    const docs = [], origin = [], failed = [], pending = [];
    releases.forEach((r) => {
      const res = S.relCache.get(relKey(r));
      if (!res) return pending.push(r);
      if (!res.ok) failed.push({ r, res });
      HS.splitManifest(res.stdout).docs.forEach((d, i) => {
        origin.push({ rel: r.id, idx: i });
        // helm template leaves metadata.namespace out unless the chart sets it;
        // the release's namespace is where the object will land
        docs.push(Object.assign({}, d, { index: docs.length, namespace: d.namespace || r.namespace || "", release: r.name }));
      });
    });
    return { docs, origin, failed, pending };
  }

  function combinedHTML() {
    const vis = visibleReleases();
    const R = vis.filter((r) => r.installed);
    const skipped = vis.filter((r) => !r.installed);
    ensureCombined(R);
    const c = combinedDocs(R);
    S.combined = c;
    const nNs = HS.groupByNamespace(R).length;
    const head = `<div class="comb-h">
        ${S.combining ? `<span class="status"><span class="spin"></span> rendering ${S.combining.done}/${S.combining.total} releases…</span>` : `<span class="muted small">${plural(R.length - c.pending.length, "release")} · ${plural(nNs, "namespace")} · ${plural(c.docs.length, "manifest")}</span>`}
        <span class="grow"></span><button class="btn sm" data-action="comb-refresh" ${S.combining ? "disabled" : ""}>Re-render</button></div>
      ${c.failed.length ? `<div class="errbar">${c.failed.map((f) => `<div><span class="link" data-action="pick-release" data-id="${esc(f.r.id)}">${esc(f.r.id)}</span> failed to render: ${esc(lastLines(f.res.stderr, 2))}</div>`).join("")}</div>` : ""}
      ${skipped.length ? `<p class="muted small">Left out (installed: false): ${skipped.map((r) => esc(r.id)).join(", ")}</p>` : ""}`;
    if (!R.length) return head + `<div class="empty">No releases match the filter.</div>`;
    if (!c.docs.length) return head + `<div class="empty">${c.pending.length ? "Rendering releases…" : "The releases rendered no manifests."}</div>`;
    const topo = HS.buildTopology(c.docs, "default", { nodes: S.dsNodes });
    return head + (S.invTab === "map" ? mapHTML(topo, c.docs, "default", { quota: true }) : `<div class="comb-topo">${topologyHTML(topo)}</div>`);
  }

  async function pickRelease(id) {
    const rel = S.hf && S.hf.releases.find((r) => r.id === id);
    if (!rel) return;
    S.release = rel;
    S.files = null; S.src = null; S.res = null; S.docs = []; S.errors = []; S.notes = []; S.pickedDoc = -1; S.chartNote = "";
    S.layers = HS.releaseLayers(rel, {});
    drawSide();
    renderRelease(true, false);
  }

  async function renderRelease(withChart, force) {
    const rel = S.release;
    S.busy = true;
    drawMain();
    const base = { file: S.hfFile, env: S.hfEnv, release: rel.name, namespace: rel.namespace };
    const cached = !force && S.relCache.get(relKey(rel));
    const tpl = cached ? Promise.resolve(cached) : api("helmfile/template", Object.assign({ kubeVersion: S.form.kubeVersion }, base)).catch((e) => ({ ok: false, stdout: "", stderr: e.message, cmd: "", durationMs: 0 }));
    const ch = withChart || !S.files ? api("helmfile/chart", Object.assign({ chart: rel.chart }, base)).catch((e) => ({ error: e.message })) : null;
    const [res, chart] = await Promise.all([tpl, ch]);
    if (S.release !== rel) return; // user moved on
    S.busy = false;
    if (chart) {
      if (chart.chart) {
        S.files = chart.chart;
        S.chartNote = chart.source === "fetch" ? "Chart source fetched into the local cache with helmfile fetch." : "";
      } else {
        S.chartNote = "Chart source unavailable: " + (chart.error || (chart.fetch ? lastLines(chart.fetch.stderr, 4) : "fetch produced no chart"));
      }
    }
    // chart + subchart defaults, then the release's own layers
    S.layers = chartLayers().concat(HS.releaseLayers(rel, {}).slice(1));
    S.relCache.set(relKey(rel), res);
    applyResult(res);
    if (S.pendingJump != null) {
      const j = S.pendingJump;
      S.pendingJump = null;
      if (j < S.docs.length) {
        S.tab = "manifests"; S.pickedDoc = j; S.pickedLine = -1;
        drawMain();
        const el = $("#doc-" + j);
        if (el) el.scrollIntoView({ block: "start" });
      }
    }
  }

  boot();
})();
