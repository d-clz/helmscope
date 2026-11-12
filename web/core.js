// helmscope core: pure functions, no DOM. Runs in the browser (window.HS)
// and under node for tests (module.exports).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/js-yaml.min.js"));
  } else {
    root.HS = factory(root.jsyaml);
  }
})(typeof self !== "undefined" ? self : this, function (jsyaml) {
  "use strict";

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const get = (o, path) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);

  // ---- manifest splitting ---------------------------------------------------

  // splitManifest turns "helm template" output into documents. Docs that are
  // not Kubernetes objects (helmfile progress lines, empty renders) go to
  // `notes` instead of failing the whole view.
  function splitManifest(text) {
    const docs = [];
    const notes = [];
    const chunks = String(text || "").split(/^---[ \t]*$/m);
    chunks.forEach((raw) => {
      const m = raw.match(/^# Source: (.+)$/m);
      const source = m ? m[1].trim() : "";
      const body = raw.replace(/^\s*\n/, "");
      if (!body.trim() || /^(\s*#.*\n?)*\s*$/.test(body)) return;
      let obj = null;
      let error = "";
      try {
        obj = jsyaml.load(body);
      } catch (e) {
        error = e.message;
      }
      if (!error && !isObj(obj)) {
        if (!source) {
          notes.push(body.trim());
          return;
        }
        if (obj == null) return; // template rendered to nothing
      }
      const meta = (obj && obj.metadata) || {};
      const ann = meta.annotations || {};
      docs.push({
        index: docs.length,
        source,
        raw: body.replace(/\s+$/, "") + "\n",
        obj: isObj(obj) ? obj : null,
        error,
        apiVersion: (obj && obj.apiVersion) || "",
        kind: (obj && obj.kind) || (error ? "ParseError" : "Unknown"),
        name: meta.name || "",
        namespace: meta.namespace || "",
        hook: ann["helm.sh/hook"] || "",
      });
    });
    return { docs, notes };
  }

  // ---- noise folding --------------------------------------------------------

  const NOISY = ["labels", "annotations"];
  const KEEP_ANN = /^helm\.sh\/(hook|resource-policy)/;

  function fold(obj, opts) {
    opts = Object.assign({ labels: true, empty: true }, opts || {});
    const walk = (v, key, parentKey) => {
      if (Array.isArray(v)) {
        const out = v.map((x) => walk(x)).filter((x) => x !== undefined);
        return opts.empty && out.length === 0 ? undefined : out;
      }
      if (isObj(v)) {
        const out = {};
        for (const k of Object.keys(v)) {
          if (opts.labels && key === "metadata" && NOISY.includes(k)) {
            if (k === "annotations") {
              const keep = {};
              for (const a of Object.keys(v[k] || {})) if (KEEP_ANN.test(a)) keep[a] = v[k][a];
              if (Object.keys(keep).length) out[k] = keep;
            }
            continue;
          }
          const w = walk(v[k], k, key);
          if (w !== undefined) out[k] = w;
        }
        return opts.empty && Object.keys(out).length === 0 && key !== undefined ? undefined : out;
      }
      if (opts.empty && (v === null || v === "")) return undefined;
      return v;
    };
    return walk(obj);
  }

  function dump(obj) {
    return jsyaml.dump(obj, { lineWidth: -1, noRefs: true, sortKeys: false });
  }

  // ---- workloads ------------------------------------------------------------

  const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "DeploymentConfig", "Rollout"]);
  const CLUSTER_SCOPED = new Set(["ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "Namespace", "PersistentVolume", "StorageClass", "PriorityClass", "MutatingWebhookConfiguration", "ValidatingWebhookConfiguration", "IngressClass", "APIService"]);

  function podSpecOf(doc) {
    const o = doc.obj;
    if (!o) return null;
    if (o.kind === "Pod") return { spec: o.spec || {}, labels: (o.metadata && o.metadata.labels) || {} };
    if (o.kind === "CronJob") {
      const t = get(o, ["spec", "jobTemplate", "spec", "template"]);
      return t ? { spec: t.spec || {}, labels: get(t, ["metadata", "labels"]) || {} } : null;
    }
    if (WORKLOADS.has(o.kind)) {
      const t = get(o, ["spec", "template"]);
      return t ? { spec: t.spec || {}, labels: get(t, ["metadata", "labels"]) || {} } : null;
    }
    return null;
  }

  const selects = (sel, labels) =>
    isObj(sel) && Object.keys(sel).length > 0 && Object.keys(sel).every((k) => labels && String(labels[k]) === String(sel[k]));

  const nsOfDoc = (d, defaultNs) => (CLUSTER_SCOPED.has(d.kind) ? "" : d.namespace || defaultNs || "default");

  // ---- quantities -------------------------------------------------------------

  const QTY = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };

  // parseQty reads a Kubernetes quantity ("500m", "1.5Gi", "1e3") into a number:
  // cores for cpu, bytes for memory.
  function parseQty(v) {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "number") return v;
    const m = String(v).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/);
    return m ? parseFloat(m[1]) * (m[2] ? QTY[m[2]] : 1) : NaN;
  }

  function fmtCpu(c) {
    if (c == null) return "—";
    if (Number.isNaN(c)) return "?";
    const milli = Math.round(c * 1000);
    return milli % 1000 === 0 ? String(milli / 1000) : `${milli}m`;
  }

  function fmtBytes(b) {
    if (b == null) return "—";
    if (Number.isNaN(b)) return "?";
    for (const [u, f] of [["Ti", 2 ** 40], ["Gi", 2 ** 30], ["Mi", 2 ** 20], ["Ki", 2 ** 10]]) {
      if (Math.abs(b) >= f) return `${+(b / f).toFixed(2)}${u}`;
    }
    return String(Math.round(b));
  }

  function fmtRes(key, v) {
    if (key === "cpu") return fmtCpu(v);
    if (key === "memory" || key === "ephemeral-storage" || key.startsWith("hugepages-")) return fmtBytes(v);
    if (v == null) return "—";
    return String(+v.toFixed(3));
  }

  const CORE = ["cpu", "memory"];

  // containerRes applies what admission does: LimitRange defaults first, then
  // request = limit when only the limit is set.
  function containerRes(c, lr) {
    const r = (c && c.resources) || {};
    const req = {}, lim = {}, src = {};
    Object.keys(r.limits || {}).forEach((k) => (lim[k] = parseQty(r.limits[k])));
    Object.keys(r.requests || {}).forEach((k) => (req[k] = parseQty(r.requests[k])));
    if (lr) {
      Object.keys(lr.default || {}).forEach((k) => { if (lim[k] == null) { lim[k] = parseQty(lr.default[k]); src["limits." + k] = "LimitRange"; } });
      Object.keys(lr.defaultRequest || {}).forEach((k) => { if (req[k] == null) { req[k] = parseQty(lr.defaultRequest[k]); src["requests." + k] = "LimitRange"; } });
    }
    Object.keys(lim).forEach((k) => { if (req[k] == null) { req[k] = lim[k]; src["requests." + k] = src["requests." + k] || "limit"; } });
    return { req, lim, src };
  }

  // podRes computes the pod's effective request/limit the way the scheduler
  // does: max(sum of app containers + sidecars, largest init container).
  function podRes(spec, lr) {
    spec = spec || {};
    const mk = (c, type) => Object.assign({ name: (c && c.name) || "?", image: (c && c.image) || "", type, ports: (c && c.ports) || [] }, containerRes(c, lr));
    const apps = (spec.containers || []).filter(Boolean).map((c) => mk(c, "app"));
    const inits = (spec.initContainers || []).filter(Boolean).map((c) => mk(c, c.restartPolicy === "Always" ? "sidecar" : "init"));
    const containers = apps.concat(inits);
    const keys = new Set(CORE);
    containers.forEach((c) => [c.req, c.lim].forEach((m) => Object.keys(m).forEach((k) => keys.add(k))));
    const initDominates = [];
    const eff = (field) => {
      const out = {};
      keys.forEach((k) => {
        let sidecars = 0, initMax = 0, run = 0, any = false;
        inits.forEach((c) => {
          const v = c[field][k];
          if (v == null) return;
          any = true;
          if (c.type === "sidecar") sidecars += v;
          else initMax = Math.max(initMax, v + sidecars);
        });
        apps.forEach((c) => { const v = c[field][k]; if (v != null) { run += v; any = true; } });
        run += sidecars;
        if (!any) return;
        out[k] = Math.max(run, initMax);
        if (field === "req" && initMax > run) initDominates.push(k);
      });
      return out;
    };
    const missing = [];
    containers.forEach((c) => {
      const gaps = [];
      CORE.forEach((k) => { if (c.req[k] == null) gaps.push("requests." + k); });
      CORE.forEach((k) => { if (c.lim[k] == null) gaps.push("limits." + k); });
      if (gaps.length) missing.push({ container: c.name, type: c.type, gaps });
    });
    // a pod limit is only real when every container that runs alongside has one
    const unbounded = CORE.filter((k) => apps.concat(inits.filter((c) => c.type === "sidecar")).some((c) => c.lim[k] == null));
    const fromLR = [...new Set(containers.flatMap((c) => Object.keys(c.src).filter((s) => c.src[s] === "LimitRange")))];
    return { containers, req: eff("req"), lim: eff("lim"), missing, unbounded, initDominates, fromLR };
  }

  const scaleMap = (m, n) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v * n]));
  const addMap = (a, b) => { Object.keys(b).forEach((k) => (a[k] = (a[k] || 0) + b[k])); return a; };
  const zeroRes = () => ({ req: {}, lim: {} });
  const addRes = (a, pod, n) => { addMap(a.req, scaleMap(pod.req, n)); addMap(a.lim, scaleMap(pod.lim, n)); return a; };

  function replicasOf(d, hpa, opts) {
    const s = d.obj.spec || {};
    switch (d.kind) {
      case "DaemonSet": return { n: opts.nodes, note: `1 per node · ${opts.nodes} node${opts.nodes === 1 ? "" : "s"} assumed`, perNode: true };
      case "Job": return { n: s.parallelism ?? 1, note: `parallelism ${s.parallelism ?? 1}, completions ${s.completions ?? 1}` };
      case "CronJob": return { n: get(s, ["jobTemplate", "spec", "parallelism"]) ?? 1, note: `per run · ${s.schedule || "?"}` };
      case "Pod": return { n: 1, note: "bare pod" };
      default: {
        if (hpa) return { n: hpa.min, max: hpa.max, note: `HPA ${hpa.name}: ${hpa.min}–${hpa.max}` + (s.replicas != null ? ` (manifest says ${s.replicas})` : ""), hpa: hpa.name };
        return { n: s.replicas ?? 1, note: s.replicas == null ? "replicas unset, defaults to 1" : "" };
      }
    }
  }

  // surgeOf is how many extra pods a rolling update adds on top of n.
  function surgeOf(d, n) {
    const s = d.obj.spec || {};
    let ms;
    if (d.kind === "Deployment") {
      if (get(s, ["strategy", "type"]) === "Recreate") return 0;
      ms = get(s, ["strategy", "rollingUpdate", "maxSurge"]) ?? "25%";
    } else if (d.kind === "DeploymentConfig") {
      if (get(s, ["strategy", "type"]) === "Recreate") return 0;
      ms = get(s, ["strategy", "rollingParams", "maxSurge"]) ?? "25%";
    } else if (d.kind === "DaemonSet") {
      ms = get(s, ["updateStrategy", "rollingUpdate", "maxSurge"]) ?? 0;
    } else return 0;
    if (typeof ms === "string" && ms.endsWith("%")) return Math.ceil((n * parseFloat(ms)) / 100);
    return +ms || 0;
  }

  function podRefs(spec) {
    const out = [];
    const add = (kind, name, how) => {
      if (name && typeof name === "string" && !out.some((r) => r.kind === kind && r.name === name)) out.push({ kind, name, how });
    };
    const s = spec || {};
    add("ServiceAccount", s.serviceAccountName || s.serviceAccount, "runs as");
    (s.volumes || []).forEach((v) => {
      if (!v) return;
      if (v.configMap) add("ConfigMap", v.configMap.name, "volume");
      if (v.secret) add("Secret", v.secret.secretName, "volume");
      if (v.persistentVolumeClaim) add("PersistentVolumeClaim", v.persistentVolumeClaim.claimName, "volume");
      ((v.projected && v.projected.sources) || []).forEach((p) => {
        if (p && p.configMap) add("ConfigMap", p.configMap.name, "volume");
        if (p && p.secret) add("Secret", p.secret.name, "volume");
      });
    });
    [].concat(s.containers || [], s.initContainers || []).forEach((c) => {
      if (!c) return;
      (c.envFrom || []).forEach((e) => {
        if (e && e.configMapRef) add("ConfigMap", e.configMapRef.name, "envFrom");
        if (e && e.secretRef) add("Secret", e.secretRef.name, "envFrom");
      });
      (c.env || []).forEach((e) => {
        const vf = e && e.valueFrom;
        if (vf && vf.configMapKeyRef) add("ConfigMap", vf.configMapKeyRef.name, "env");
        if (vf && vf.secretKeyRef) add("Secret", vf.secretKeyRef.name, "env");
      });
    });
    (s.imagePullSecrets || []).forEach((x) => add("Secret", x && x.name, "pull secret"));
    return out;
  }

  function hpaFor(d, hpas, ns, defaultNs) {
    const h = hpas.find((x) => {
      const t = get(x.obj, ["spec", "scaleTargetRef"]) || {};
      return t.kind === d.kind && t.name === d.name && nsOfDoc(x, defaultNs) === ns;
    });
    return h && { name: h.name, min: get(h.obj, ["spec", "minReplicas"]) ?? 1, max: get(h.obj, ["spec", "maxReplicas"]) ?? 1 };
  }

  // ---- map: namespaces → workloads → resources ---------------------------------

  function buildMap(docs, defaultNs, opts) {
    opts = Object.assign({ nodes: 1 }, opts || {});
    const objs = docs.filter((d) => d.obj && d.name);
    const nsOf = (d) => nsOfDoc(d, defaultNs);
    const hpas = objs.filter((d) => d.kind === "HorizontalPodAutoscaler");
    const index = new Map(objs.map((d) => [`${d.kind}/${nsOf(d)}/${d.name}`, d.index]));
    const lrByNs = {};
    objs.filter((d) => d.kind === "LimitRange").forEach((d) => {
      const c = (get(d.obj, ["spec", "limits"]) || []).find((l) => l && l.type === "Container");
      if (c) lrByNs[nsOf(d)] = Object.assign({ name: d.name }, c);
    });

    const spaces = new Map();
    const space = (ns) => {
      if (!spaces.has(ns)) spaces.set(ns, { name: ns, workloads: [], others: {}, pods: 0, podsMax: 0, podsPeak: 0, total: zeroRes(), max: zeroRes(), peak: zeroRes(), quotas: [], limitRange: lrByNs[ns] ? lrByNs[ns].name : "" });
      return spaces.get(ns);
    };
    const all = { pods: 0, podsMax: 0, podsPeak: 0, total: zeroRes(), max: zeroRes(), peak: zeroRes(), workloads: 0 };

    objs.forEach((d) => {
      const ns = nsOf(d);
      const sp = space(ns);
      const ps = WORKLOADS.has(d.kind) ? podSpecOf(d) : null;
      if (!ps) {
        sp.others[d.kind] = (sp.others[d.kind] || 0) + 1;
        return;
      }
      const rep = replicasOf(d, hpaFor(d, hpas, ns, defaultNs), opts);
      const hi = rep.max ?? rep.n;
      const surge = surgeOf(d, hi);
      const pod = podRes(ps.spec, lrByNs[ns]);
      const refs = podRefs(ps.spec).map((r) => Object.assign(r, { doc: index.has(`${r.kind}/${ns}/${r.name}`) ? index.get(`${r.kind}/${ns}/${r.name}`) : -1 }));
      if (d.kind === "StatefulSet") {
        (get(d.obj, ["spec", "volumeClaimTemplates"]) || []).forEach((t) => {
          const nm = t && t.metadata && t.metadata.name;
          if (nm) refs.push({ kind: "PersistentVolumeClaim", name: `${nm}-${d.name}-*`, how: "claim template " + (get(t, ["spec", "resources", "requests", "storage"]) || ""), doc: d.index, generated: true });
        });
      }
      const w = {
        doc: d.index, kind: d.kind, name: d.name, ns, replicas: rep, surge, pod, refs,
        total: addRes(zeroRes(), pod, rep.n),
        max: addRes(zeroRes(), pod, hi),
        peak: addRes(zeroRes(), pod, hi + surge),
      };
      sp.workloads.push(w);
      [sp, all].forEach((t) => {
        t.pods += rep.n; t.podsMax += hi; t.podsPeak += hi + surge;
        addRes(t.total, pod, rep.n); addRes(t.max, pod, hi); addRes(t.peak, pod, hi + surge);
      });
      all.workloads++;
    });

    objs.filter((d) => d.kind === "ResourceQuota").forEach((d) => {
      const sp = space(nsOf(d));
      const hard = get(d.obj, ["spec", "hard"]) || {};
      Object.keys(hard).forEach((k) => {
        let used = null;
        const m = k.match(/^(requests|limits)\.(.+)$/);
        if (m) used = sp.peak[m[1] === "requests" ? "req" : "lim"][m[2]] || 0;
        else if (CORE.includes(k)) used = sp.peak.req[k] || 0;
        else if (k === "pods") used = sp.podsPeak;
        if (used === null) return;
        const res = m ? m[2] : k;
        const h = k === "pods" ? +hard[k] : parseQty(hard[k]);
        sp.quotas.push({ quota: d.name, key: k, res, hard: h, used, over: used > h });
      });
    });

    const list = [...spaces.values()].sort((a, b) => (a.name === "") - (b.name === "") || a.name.localeCompare(b.name));
    const ORDER = ["Deployment", "DeploymentConfig", "Rollout", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod", "Job", "CronJob"];
    list.forEach((s) => s.workloads.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name)));
    return { namespaces: list, all };
  }

  // ---- topology: entry → router → service → pods ---------------------------------

  const TOPO_COLUMNS = ["Entry", "Router", "Service", "Pods"];

  function containerPorts(spec) {
    const s = spec || {};
    return [].concat(s.containers || [], (s.initContainers || []).filter((c) => c && c.restartPolicy === "Always"))
      .filter(Boolean)
      .flatMap((c) => (c.ports || []).filter(Boolean).map((p) => ({ container: c.name, port: p.containerPort, name: p.name || "", protocol: p.protocol || "TCP" })));
  }

  function resolveTarget(ports, tp) {
    if (typeof tp === "string" && /^\d+$/.test(tp)) tp = +tp;
    return ports.find((p) => (typeof tp === "string" ? p.name === tp : p.port === tp)) || null;
  }

  function buildTopology(docs, defaultNs, opts) {
    opts = Object.assign({ nodes: 1 }, opts || {});
    const objs = docs.filter((d) => d.obj && d.name);
    const nsOf = (d) => nsOfDoc(d, defaultNs);
    const nodes = new Map();
    const edges = [];
    const issues = [];
    const hpas = objs.filter((d) => d.kind === "HorizontalPodAutoscaler");
    const node = (id, props) => {
      if (!nodes.has(id)) nodes.set(id, Object.assign({ id, ghost: false, doc: -1, lines: [] }, props));
      return nodes.get(id);
    };
    const edge = (from, to, label) => {
      let e = edges.find((x) => x.from === from && x.to === to);
      if (!e) edges.push((e = { from, to, labels: [] }));
      if (label && !e.labels.includes(label)) e.labels.push(label);
    };
    const issue = (sev, msg, doc) => {
      if (!issues.some((i) => i.msg === msg)) issues.push({ sev, msg, doc });
    };
    const hostNode = (host, tls) => {
      const n = node("host/" + host, { col: 0, kind: "Host", name: host, tls: false });
      n.tls = n.tls || !!tls;
      return n;
    };

    const workloads = objs.filter((d) => WORKLOADS.has(d.kind)).map((d) => ({ d, ps: podSpecOf(d) })).filter((w) => w.ps);
    const policies = objs.filter((d) => d.kind === "NetworkPolicy");
    const svcId = (ns, name) => `Service/${ns}/${name}`;
    const svcDocs = new Map(objs.filter((d) => d.kind === "Service").map((d) => [svcId(nsOf(d), d.name), d]));
    const reached = new Set();

    // services and the pods behind them
    svcDocs.forEach((d, id) => {
      const ns = nsOf(d);
      const s = d.obj.spec || {};
      const type = s.type || "ClusterIP";
      const ports = (s.ports || []).filter(Boolean);
      const sn = node(id, {
        col: 2, kind: "Service", name: d.name, ns, doc: d.index,
        lines: [type + (s.clusterIP === "None" ? " · headless" : ""), ports.map((p) => `${p.name ? p.name + " " : ""}${p.port}→${p.targetPort ?? p.port}${p.protocol && p.protocol !== "TCP" ? "/" + p.protocol : ""}`).join(", ")],
      });
      if (type === "ExternalName") {
        sn.lines = ["ExternalName", s.externalName || "?"];
        return;
      }
      if (type === "LoadBalancer" || type === "NodePort") {
        const en = node(`expose/${ns}/${d.name}`, { col: 0, kind: type, name: type === "NodePort" ? "any node IP" : s.loadBalancerIP || "external load balancer", lines: [] });
        edge(en.id, sn.id, ports.map((p) => (type === "NodePort" || p.nodePort ? `:${p.nodePort || "auto"}→${p.port}` : `:${p.port}`)).join(" "));
      }
      if (!isObj(s.selector) || !Object.keys(s.selector).length) {
        issue("info", `Service ${d.name} has no selector, so its endpoints are managed outside this chart`, d.index);
        return;
      }
      const sel = Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(",");
      const matched = workloads.filter((w) => nsOf(w.d) === ns && selects(s.selector, w.ps.labels));
      if (!matched.length) {
        const g = node(`pods/${ns}/${sel}`, { col: 3, kind: "Pods", name: sel, ns, ghost: true, lines: ["no workload in this render matches"] });
        edge(sn.id, g.id, ports.map((p) => String(p.targetPort ?? p.port)).join(", "));
        issue("warn", `Service ${d.name} selects ${sel}, which matches no workload in this render`, d.index);
        return;
      }
      if (matched.length > 1) issue("warn", `Service ${d.name} selects pods from ${matched.length} workloads (${matched.map((w) => w.d.name).join(", ")}); traffic is split across all of them`, d.index);
      matched.forEach((w) => {
        const wid = `${w.d.kind}/${ns}/${w.d.name}`;
        reached.add(wid);
        const cps = containerPorts(w.ps.spec);
        const rep = replicasOf(w.d, hpaFor(w.d, hpas, ns, defaultNs), opts);
        const pols = policies.filter((p) => nsOf(p) === ns && (Object.keys(get(p.obj, ["spec", "podSelector", "matchLabels"]) || {}).length === 0 || selects(get(p.obj, ["spec", "podSelector", "matchLabels"]), w.ps.labels)));
        node(wid, {
          col: 3, kind: w.d.kind, name: w.d.name, ns, doc: w.d.index,
          lines: [(rep.perNode ? "1 per node" : rep.max != null ? `${rep.n}–${rep.max} pods` : `${rep.n} pod${rep.n === 1 ? "" : "s"}`) + (pols.length ? ` · netpol: ${pols.map((p) => p.name).join(", ")}` : ""),
            cps.map((p) => `${p.container}:${p.port}${p.name ? " (" + p.name + ")" : ""}`).join(", ") || "no containerPorts declared"],
        });
        const labels = ports.map((p) => {
          const tp = p.targetPort ?? p.port;
          const hit = resolveTarget(cps, tp);
          if (hit) return `${p.port}→${hit.container}:${hit.port}`;
          if (typeof tp === "string" && !/^\d+$/.test(tp)) {
            issue("error", `Service ${d.name} port ${p.port} targets "${tp}", but ${w.d.kind} ${w.d.name} has no container port named "${tp}". No traffic reaches it.`, d.index);
            return `${p.port}→"${tp}" ✗`;
          }
          issue("info", `Service ${d.name} targets port ${tp}, which ${w.d.kind} ${w.d.name} doesn't declare as a containerPort (fine if the app listens on it)`, d.index);
          return `${p.port}→${tp}?`;
        });
        edge(sn.id, wid, labels.join(", "));
      });
    });

    // linkService draws router → service and checks the port reference.
    const linkService = (ns, name, port, match, from, who, doc, extra) => {
      if (!name) return;
      const id = svcId(ns, name);
      const sd = svcDocs.get(id);
      let label = port != null ? `:${port}` : "";
      if (!sd) {
        node(id, { col: 2, kind: "Service", name, ns, ghost: true, lines: ["not in this render"] });
        issue("warn", `${who} routes to Service ${name}, which isn't in this render`, doc);
      } else if (port != null) {
        const sp = (get(sd.obj, ["spec", "ports"]) || []).filter(Boolean).find(match);
        if (!sp) {
          issue("error", `${who} routes to ${name}:${port}, but Service ${name} has no matching port. No traffic gets through.`, doc);
          label += " ✗";
        } else if (sp.port !== port) label = `:${port} (${sp.port})`;
      }
      edge(from.id, id, [label, extra].filter(Boolean).join(" "));
    };

    objs.filter((d) => d.kind === "Ingress").forEach((d) => {
      const ns = nsOf(d);
      const s = d.obj.spec || {};
      const tls = (s.tls || []).filter(Boolean);
      const tlsHosts = new Set(tls.flatMap((t) => t.hosts || []));
      const cls = s.ingressClassName || get(d.obj, ["metadata", "annotations", "kubernetes.io/ingress.class"]) || "";
      const rn = node(`Ingress/${ns}/${d.name}`, {
        col: 1, kind: "Ingress", name: d.name, ns, doc: d.index,
        lines: [cls ? "class " + cls : "default class", tls.length ? "tls: " + tls.map((t) => t.secretName || "default cert").join(", ") : "no tls"],
      });
      const backend = (b) => {
        if (!b) return;
        if (b.resource) return issue("info", `Ingress ${d.name} has a resource backend (${b.resource.kind} ${b.resource.name})`, d.index);
        const name = b.service ? b.service.name : b.serviceName;
        const port = b.service ? b.service.port && (b.service.port.number ?? b.service.port.name) : b.servicePort;
        linkService(ns, name, port, (p) => p.port === port || (p.name && p.name === port), rn, `Ingress ${d.name}`, d.index);
      };
      (s.rules || []).filter(Boolean).forEach((r) => {
        const host = r.host || "*";
        const hn = hostNode(host, tlsHosts.has(host) || (tls.length && !tlsHosts.size));
        if (r.host && tls.length && !tlsHosts.has(r.host) && tlsHosts.size) issue("warn", `Ingress ${d.name}: host ${r.host} has no tls entry, so it's served over plain http`, d.index);
        ((r.http && r.http.paths) || []).filter(Boolean).forEach((p) => {
          edge(hn.id, rn.id, (p.path || "/") + (p.pathType && p.pathType !== "Prefix" ? ` (${p.pathType})` : ""));
          backend(p.backend);
        });
      });
      const def = s.defaultBackend || s.backend;
      if (def) {
        edge(hostNode("*", false).id, rn.id, "default backend");
        backend(def);
      }
    });

    objs.filter((d) => d.kind === "Route").forEach((d) => {
      const ns = nsOf(d);
      const s = d.obj.spec || {};
      const term = s.tls && s.tls.termination;
      const rn = node(`Route/${ns}/${d.name}`, {
        col: 1, kind: "Route", name: d.name, ns, doc: d.index,
        lines: [term ? `tls ${term}` + (s.tls.insecureEdgeTerminationPolicy ? ` · http: ${s.tls.insecureEdgeTerminationPolicy}` : "") : "no tls", s.wildcardPolicy && s.wildcardPolicy !== "None" ? "wildcard " + s.wildcardPolicy : ""],
      });
      edge(hostNode(s.host || "(router-generated host)", !!term).id, rn.id, s.path || "/");
      const tp = s.port && s.port.targetPort;
      const backs = [].concat(s.to ? [s.to] : [], s.alternateBackends || []).filter(Boolean);
      backs.forEach((b) => {
        if ((b.kind || "Service") !== "Service") return;
        const w = backs.length > 1 && b.weight != null ? `weight ${b.weight}` : "";
        linkService(ns, b.name, tp ?? null, (p) => p.name === tp || p.targetPort === tp || p.port === tp, rn, `Route ${d.name}`, d.index, w);
      });
    });

    objs.filter((d) => d.kind === "HTTPRoute" || d.kind === "GRPCRoute").forEach((d) => {
      const ns = nsOf(d);
      const s = d.obj.spec || {};
      const parents = (s.parentRefs || []).filter(Boolean).map((p) => p.name);
      const rn = node(`${d.kind}/${ns}/${d.name}`, { col: 1, kind: d.kind, name: d.name, ns, doc: d.index, lines: [parents.length ? "gateway " + parents.join(", ") : "no parentRefs", "tls set on the Gateway"] });
      const hosts = (s.hostnames || []).length ? s.hostnames : ["*"];
      (s.rules || []).filter(Boolean).forEach((r) => {
        const paths = (r.matches || []).filter(Boolean).map((m) => (m.path ? m.path.value : m.method ? `${m.method.service || ""}/${m.method.method || ""}` : "")).filter(Boolean);
        hosts.forEach((h) => edge(hostNode(h, false).id, rn.id, paths.join(" ") || "/"));
        (r.backendRefs || []).filter(Boolean).forEach((b) => {
          if ((b.kind || "Service") !== "Service") return;
          linkService(b.namespace || ns, b.name, b.port ?? null, (p) => p.port === b.port, rn, `${d.kind} ${d.name}`, d.index, b.weight != null && r.backendRefs.length > 1 ? `weight ${b.weight}` : "");
        });
      });
    });

    const list = [...nodes.values()];
    list.forEach((n) => {
      n.lines = n.lines.filter(Boolean);
      if (n.kind === "Service" && !n.ghost && !edges.some((e) => e.to === n.id)) n.internal = true;
    });
    orderColumns(list, edges);
    const unexposed = workloads.filter((w) => !reached.has(`${w.d.kind}/${nsOf(w.d)}/${w.d.name}`)).map((w) => ({ kind: w.d.kind, name: w.d.name, ns: nsOf(w.d), doc: w.d.index }));
    const rank = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => rank[a.sev] - rank[b.sev]);
    return { nodes: list, edges, issues, unexposed, columns: TOPO_COLUMNS };
  }

  // orderColumns assigns n.row with barycentre sweeps to cut crossings.
  function orderColumns(nodes, edges) {
    const cols = new Map();
    nodes.forEach((n) => {
      if (!cols.has(n.col)) cols.set(n.col, []);
      cols.get(n.col).push(n);
    });
    cols.forEach((c) => c.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).forEach((n, i) => (n.row = i)));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const nbrs = new Map(nodes.map((n) => [n.id, []]));
    edges.forEach((e) => {
      nbrs.get(e.from) && nbrs.get(e.from).push(e.to);
      nbrs.get(e.to) && nbrs.get(e.to).push(e.from);
    });
    const keys = [...cols.keys()].sort((a, b) => a - b);
    for (let pass = 0; pass < 4; pass++) {
      const order = pass % 2 ? [...keys].reverse() : keys;
      order.forEach((k) => {
        const c = cols.get(k);
        c.forEach((n) => {
          const ns = nbrs.get(n.id).map((id) => byId.get(id)).filter((m) => m && m.col !== n.col);
          n._bc = ns.length ? ns.reduce((a, m) => a + m.row, 0) / ns.length : n.row;
        });
        c.sort((a, b) => a._bc - b._bc).forEach((n, i) => (n.row = i));
      });
    }
    nodes.forEach((n) => delete n._bc);
  }

  // ---- values provenance ----------------------------------------------------

  // flatten returns leaf paths. Arrays are leaves because Helm replaces them
  // wholesale instead of merging.
  function flatten(obj, prefix, out) {
    out = out || [];
    prefix = prefix || [];
    if (isObj(obj) && Object.keys(obj).length) {
      Object.keys(obj).forEach((k) => flatten(obj[k], prefix.concat(k), out));
    } else if (prefix.length) {
      out.push({ path: prefix, value: obj });
    }
    return out;
  }

  // coalesce mirrors Helm: maps merge, null deletes, anything else replaces.
  function coalesce(base, over) {
    if (!isObj(over)) return over;
    const out = isObj(base) ? Object.assign({}, base) : {};
    Object.keys(over).forEach((k) => {
      if (over[k] === null) delete out[k];
      else if (isObj(over[k]) && isObj(out[k])) out[k] = coalesce(out[k], over[k]);
      else out[k] = over[k];
    });
    return out;
  }

  const pathKey = (p) => p.map((k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))).join(".");

  // provenance takes layers lowest precedence first: [{name, obj}].
  function provenance(layers) {
    let merged = {};
    const history = new Map();
    const removed = [];
    layers.forEach((layer) => {
      if (!isObj(layer.obj)) return;
      flatten(layer.obj).forEach(({ path, value }) => {
        const k = pathKey(path);
        if (!history.has(k)) history.set(k, []);
        history.get(k).push({ layer: layer.name, value });
        if (value === null) removed.push({ path: k, layer: layer.name });
      });
      merged = coalesce(merged, layer.obj);
    });
    const rows = flatten(merged).map(({ path, value }) => {
      const k = pathKey(path);
      const h = history.get(k) || [];
      const last = h.length ? h[h.length - 1].layer : "";
      return { path: k, parts: path, value, setBy: last, history: h, overridden: h.length > 1 };
    });
    rows.sort((a, b) => a.path.localeCompare(b.path));
    return { merged, rows, removed };
  }

  // parseSet turns "a.b=1" / "a\.b.c=x" into an object, close to --set.
  function parseSet(lines) {
    const out = {};
    (lines || []).forEach((line) => {
      line = String(line).trim();
      if (!line || line.startsWith("#")) return;
      const eq = line.indexOf("=");
      if (eq < 0) return;
      const path = line.slice(0, eq).split(/(?<!\\)\./).map((p) => p.replace(/\\\./g, "."));
      setPath(out, path, scalar(line.slice(eq + 1)));
    });
    return out;
  }

  function scalar(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null") return null;
    if (/^-?\d+$/.test(v) && v.length < 16) return parseInt(v, 10);
    return v;
  }

  function setPath(obj, path, value) {
    let cur = obj;
    path.forEach((k, i) => {
      if (i === path.length - 1) cur[k] = value;
      else {
        if (!isObj(cur[k])) cur[k] = {};
        cur = cur[k];
      }
    });
    return obj;
  }

  // valueRefs collects ".Values.x.y" prefixes per chart. Subchart templates
  // read their own .Values, which the parent sees under the subchart's name.
  function valueRefs(files, root) {
    const refs = new Set();
    const re = /\.Values((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g;
    Object.keys(files || {}).forEach((f) => {
      // Chart.yaml dependency conditions ("redis.enabled") are read by Helm itself
      if (/(^|\/)Chart\.yaml$/.test(f)) {
        const sub = f.slice(root.length + 1).split("/").filter((_, i, a) => a[i - 1] === "charts");
        (files[f].match(/^\s*condition:\s*(.+)$/gm) || []).forEach((c) =>
          c.replace(/^\s*condition:\s*/, "").replace(/["']/g, "").split(",").forEach((x) => x.trim() && refs.add(sub.concat(x.trim()).join("."))));
        return;
      }
      if (!/\.(ya?ml|tpl|txt|gotmpl)$/.test(f) || !/\/templates\//.test(f)) return;
      const rel = f.slice(root.length + 1);
      const subs = [];
      const m = rel.split("/");
      for (let i = 0; i + 1 < m.length && m[i] === "charts"; i += 2) subs.push(m[i + 1]);
      if (subs.length) refs.add(subs.concat("enabled").join("."));
      let x;
      const text = files[f];
      while ((x = re.exec(text))) {
        const p = x[1].slice(1).split(".");
        refs.add(subs.concat(p).join("."));
        if (p[0] === "global") refs.add(p.join("."));
      }
    });
    return refs;
  }

  // isReferenced: a value is "used" when a template reads it or any parent.
  function isReferenced(refs, parts) {
    for (let i = parts.length; i > 0; i--) if (refs.has(parts.slice(0, i).join("."))) return true;
    for (const r of refs) if (r.startsWith(parts.join(".") + ".")) return true;
    return false;
  }

  // ---- source mapping -------------------------------------------------------

  function parseErrors(stderr) {
    const out = [];
    const seen = new Set();
    const text = String(stderr || "");
    const re = /([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:ya?ml|tpl|txt|gotmpl)):(\d+)(?::(\d+))?/g;
    let m;
    while ((m = re.exec(text))) {
      const k = m[1] + ":" + m[2];
      if (seen.has(k)) continue;
      seen.add(k);
      const lineEnd = text.indexOf("\n", m.index);
      out.push({ file: m[1], line: +m[2], col: m[3] ? +m[3] : 0, msg: text.slice(m.index, lineEnd < 0 ? undefined : lineEnd).trim() });
    }
    const yre = /YAML parse error on ([^\s:]+):[^\n]*?line (\d+)/g;
    while ((m = yre.exec(text))) {
      out.push({ file: m[1], line: 0, renderedLine: +m[2], col: 0, msg: m[0] });
    }
    return out;
  }

  const DEFINE_RE = /\{\{-?\s*define\s+"([^"]+)"\s*-?\}\}/g;

  function defines(files) {
    const out = {};
    Object.keys(files || {}).forEach((f) => {
      const text = files[f];
      let m;
      DEFINE_RE.lastIndex = 0;
      while ((m = DEFINE_RE.exec(text))) {
        out[m[1]] = { file: f, line: text.slice(0, m.index).split("\n").length };
      }
    });
    return out;
  }

  function includes(text) {
    const out = [];
    const re = /\b(?:include|template)\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(String(text || "")))) if (!out.includes(m[1])) out.push(m[1]);
    return out;
  }

  // helpersClosure follows include chains so "app.labels" -> "app.selectorLabels" shows too.
  function helpersClosure(text, defs, files) {
    const seen = [];
    const queue = includes(text);
    while (queue.length) {
      const name = queue.shift();
      if (seen.includes(name)) continue;
      seen.push(name);
      const d = defs[name];
      if (!d) continue;
      const body = defineBody(files[d.file], d.line);
      includes(body).forEach((n) => !seen.includes(n) && queue.push(n));
    }
    return seen.map((name) => ({ name, def: defs[name] || null }));
  }

  function defineBody(text, line) {
    const lines = String(text || "").split("\n");
    let depth = 0;
    const out = [];
    for (let i = line - 1; i < lines.length; i++) {
      const l = lines[i];
      out.push(l);
      depth += (l.match(/\{\{-?\s*(define|if|range|with|block)\b/g) || []).length;
      depth -= (l.match(/\{\{-?\s*end\s*-?\}\}/g) || []).length;
      if (depth <= 0 && i >= line - 1) break;
    }
    return out.join("\n");
  }

  // mapLine guesses which template lines produced a rendered line. It is a
  // reading aid, not a source map: Go templates do not emit one.
  function mapLine(rendered, templateText) {
    const t = String(rendered || "").trim().replace(/^-\s+/, "");
    if (!t) return [];
    const lines = String(templateText || "").split("\n");
    const hits = [];
    const km = t.match(/^["']?([A-Za-z0-9_.\-/]+)["']?\s*:/);
    if (km) {
      const k = km[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|\\s|-\\s)["']?${k}["']?\\s*:`);
      lines.forEach((l, i) => re.test(l) && hits.push(i + 1));
    }
    if (!hits.length && t.length > 2) {
      const val = km ? t.slice(km[0].length).trim() : t;
      if (val && val.length > 2) lines.forEach((l, i) => l.includes(val) && hits.push(i + 1));
    }
    return hits.slice(0, 20);
  }

  // ---- helmfile -------------------------------------------------------------

  function parseHelmfileState(text) {
    const releases = [];
    const docs = [];
    try {
      jsyaml.loadAll(String(text || ""), (d) => isObj(d) && docs.push(d));
    } catch (e) {
      return { releases, error: e.message };
    }
    docs.forEach((d) => {
      (d.releases || []).forEach((r) => {
        if (!isObj(r) || !r.name) return;
        const ns = r.namespace || "";
        releases.push({
          id: `${ns}/${r.name}`,
          name: r.name,
          namespace: ns,
          chart: r.chart || "",
          version: r.version || "",
          installed: r.installed !== false,
          labels: r.labels || {},
          needs: (r.needs || []).map((n) => normNeed(n, ns)),
          values: r.values || [],
          set: r.set || [],
          setString: r.setString || [],
          condition: r.condition || "",
        });
      });
    });
    return { releases, error: "" };
  }

  function normNeed(n, ns) {
    const p = String(n).split("/");
    if (p.length === 1) return `${ns}/${p[0]}`;
    return `${p[p.length - 2]}/${p[p.length - 1]}`;
  }

  // releaseLayers turns a built release into provenance layers. With
  // --embed-values every values entry is an inline map.
  function releaseLayers(rel, chartDefaults) {
    const layers = [{ name: "chart values.yaml", obj: chartDefaults || {} }];
    (rel.values || []).forEach((v, i) => {
      if (isObj(v)) layers.push({ name: `values[${i}]`, obj: v });
      else layers.push({ name: `values[${i}] ${v}`, obj: null, unresolved: String(v) });
    });
    const set = {};
    [].concat(rel.set || [], rel.setString || []).forEach((s) => {
      if (!isObj(s) || !s.name) return;
      const path = String(s.name).split(/(?<!\\)\./).map((p) => p.replace(/\\\./g, "."));
      const v = s.value !== undefined ? s.value : s.values !== undefined ? s.values : s.file ? `<file:${s.file}>` : null;
      setPath(set, path, v);
    });
    if (Object.keys(set).length) layers.push({ name: "set", obj: set });
    return layers;
  }

  // needsLayers ranks releases by dependency depth for the inventory DAG.
  function needsLayers(releases) {
    const byId = new Map(releases.map((r) => [r.id, r]));
    const depth = new Map();
    const visiting = new Set();
    const cycles = [];
    const visit = (id) => {
      if (depth.has(id)) return depth.get(id);
      if (visiting.has(id)) {
        cycles.push(id);
        return 0;
      }
      visiting.add(id);
      const r = byId.get(id);
      const d = r ? Math.max(-1, ...r.needs.filter((n) => byId.has(n)).map(visit)) + 1 : 0;
      visiting.delete(id);
      depth.set(id, d);
      return d;
    };
    releases.forEach((r) => visit(r.id));
    const missing = [];
    releases.forEach((r) => r.needs.forEach((n) => !byId.has(n) && missing.push({ from: r.id, to: n })));
    return { depth, cycles, missing };
  }

  return {
    splitManifest, fold, dump, podSpecOf,
    parseQty, fmtCpu, fmtBytes, fmtRes, podRes, buildMap, buildTopology,
    flatten, coalesce, provenance, parseSet, setPath, valueRefs, isReferenced, pathKey,
    parseErrors, defines, includes, helpersClosure, mapLine,
    parseHelmfileState, releaseLayers, needsLayers,
    isObj, yaml: jsyaml,
  };
});
