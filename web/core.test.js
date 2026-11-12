// node web/core.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const HS = require("./core.js");
const td = path.join(__dirname, "..", "testdata");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

const rendered = fs.readFileSync(path.join(td, "rendered.yaml"), "utf8");

t("splitManifest", () => {
  const { docs, notes } = HS.splitManifest("Templating release=x\n" + rendered);
  assert.strictEqual(docs.length, 9);
  assert.deepStrictEqual([...new Set(docs.map((d) => d.kind))], ["Service", "Deployment", "CronJob", "HorizontalPodAutoscaler", "Ingress", "Route", "StatefulSet"]);
  assert.strictEqual(docs[3].source, "web/templates/deployment.yaml");
  assert.deepStrictEqual(notes, ["Templating release=x"]); // non-object chunks become notes
});

t("splitManifest keeps parse errors", () => {
  const { docs } = HS.splitManifest("---\n# Source: a/templates/x.yaml\nkind: [\n");
  assert.strictEqual(docs[0].kind, "ParseError");
  assert.ok(docs[0].error);
});

t("fold drops labels and empties, keeps hooks", () => {
  const o = { metadata: { name: "a", labels: { x: "1" }, annotations: { "helm.sh/hook": "pre-install", y: "2" } }, spec: { resources: {}, selector: { matchLabels: { x: "1" } } } };
  const f = HS.fold(o);
  assert.deepStrictEqual(f, { metadata: { name: "a", annotations: { "helm.sh/hook": "pre-install" } }, spec: { selector: { matchLabels: { x: "1" } } } });
});

t("parseQty / format", () => {
  assert.strictEqual(HS.parseQty("500m"), 0.5);
  assert.strictEqual(HS.parseQty("1.5Gi"), 1.5 * 2 ** 30);
  assert.strictEqual(HS.parseQty("1e3"), 1000);
  assert.strictEqual(HS.parseQty(2), 2);
  assert.ok(Number.isNaN(HS.parseQty("lots")));
  assert.strictEqual(HS.fmtCpu(0.1 * 3), "300m");
  assert.strictEqual(HS.fmtCpu(2), "2");
  assert.strictEqual(HS.fmtCpu(1.25), "1250m");
  assert.strictEqual(HS.fmtBytes(HS.parseQty("1856Mi")), "1.81Gi");
});

t("podRes: init containers, sidecars, request defaults to limit", () => {
  const p = HS.podRes({
    initContainers: [
      { name: "proxy", restartPolicy: "Always", resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "100m", memory: "64Mi" } } },
      { name: "migrate", resources: { requests: { cpu: "1", memory: "1Gi" } } },
    ],
    containers: [{ name: "app", resources: { limits: { cpu: "500m", memory: "256Mi" } } }],
  });
  // app request comes from its limit; init "migrate" runs alongside the earlier sidecar
  assert.strictEqual(p.req.cpu, 1.1);
  assert.strictEqual(p.req.memory, 2 ** 30 + 64 * 2 ** 20);
  assert.deepStrictEqual(p.initDominates.sort(), ["cpu", "memory"]);
  assert.strictEqual(p.containers.find((c) => c.name === "proxy").type, "sidecar");
  assert.deepStrictEqual(p.missing, [{ container: "migrate", type: "init", gaps: ["limits.cpu", "limits.memory"] }]);
  assert.deepStrictEqual(p.unbounded, []);
});

t("buildMap: replicas, HPA, surge, totals", () => {
  const { docs } = HS.splitManifest(rendered);
  const m = HS.buildMap(docs, "apps");
  assert.strictEqual(m.namespaces.length, 1);
  const ns = m.namespaces[0];
  assert.strictEqual(ns.name, "apps");
  const w = (n) => ns.workloads.find((x) => x.name === n);
  const web = w("demo-web");
  assert.deepStrictEqual([web.replicas.n, web.replicas.max, web.surge], [2, 5, 2]);
  assert.strictEqual(web.pod.req.cpu, 0.25);
  assert.strictEqual(web.pod.req.memory, 512 * 2 ** 20, "init container wins");
  assert.deepStrictEqual(web.pod.unbounded, ["cpu", "memory"], "metrics sidecar has no limits");
  assert.deepStrictEqual(web.refs.map((r) => r.kind + "/" + r.name), ["ServiceAccount/demo-web", "ConfigMap/demo-web-env", "Secret/web-db-credentials"]);
  assert.ok(web.refs.every((r) => r.doc === -1), "none of them are rendered");
  assert.strictEqual(w("demo-redis").replicas.n, 3);
  assert.ok(w("demo-redis").refs.some((r) => r.name === "data-demo-redis-*"));
  assert.deepStrictEqual([ns.pods, ns.podsMax, ns.podsPeak], [6, 9, 11]);
  assert.strictEqual(HS.fmtCpu(ns.total.req.cpu), "850m");
  assert.strictEqual(HS.fmtCpu(ns.peak.req.cpu), "2100m");
  assert.strictEqual(ns.cards.length, 9, "every manifest gets a card");
  assert.deepStrictEqual([...new Set(ns.cards.map((c) => c.category))], ["Workloads", "Network"]);
  assert.strictEqual(ns.cards.find((c) => c.kind === "Service" && c.name === "demo-web").detail, "ClusterIP · 80→http");
  assert.strictEqual(ns.cards.find((c) => c.kind === "HorizontalPodAutoscaler").detail, "2–5 → Deployment demo-web");
  assert.strictEqual(web.qos, "Burstable");
  assert.ok(web.notes.some((n) => /spec.replicas \(2\) is set while HPA/.test(n.msg)), "HPA vs spec.replicas");
  assert.deepStrictEqual(ns.storage, { claims: 3, bytes: 3 * 8 * 2 ** 30 }, "StatefulSet claim templates × replicas");
});

t("suggestQuota with a suggested LimitRange", () => {
  const { docs } = HS.splitManifest(rendered);
  const ns = HS.buildMap(docs, "apps").namespaces[0];
  assert.deepStrictEqual(ns.suggestedLimitRange.default, { cpu: "500m", memory: "512Mi" });
  assert.deepStrictEqual(ns.withLimitRange.unbounded, [], "defaults bound every container");
  const q = HS.suggestQuota(ns, 20);
  assert.deepStrictEqual(q.hard, {
    pods: "14", "requests.cpu": "3", "requests.memory": "5632Mi",
    "limits.cpu": "10500m", "limits.memory": "8704Mi",
    persistentvolumeclaims: "4", "requests.storage": "29Gi",
  });
  const out = HS.yaml.loadAll(q.yaml);
  assert.deepStrictEqual(out.map((d) => d.kind), ["ResourceQuota", "LimitRange"]);
  assert.strictEqual(out[0].metadata.namespace, "apps");
});

t("suggestQuota leaves limits out when containers are unbounded and a LimitRange exists", () => {
  const { docs } = HS.splitManifest(`---
# Source: x/templates/a.yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: a, namespace: ops}
spec:
  replicas: 4
  strategy: {type: Recreate}
  template:
    spec:
      containers:
        - name: a
          resources: {requests: {cpu: 250m, memory: 256Mi}}
---
# Source: x/templates/b.yaml
apiVersion: v1
kind: LimitRange
metadata: {name: lr, namespace: ops}
spec:
  limits: [{type: Container, defaultRequest: {cpu: 10m}}]
`);
  const ns = HS.buildMap(docs, "default").namespaces.find((n) => n.name === "ops");
  assert.ok(!ns.suggestedLimitRange, "a rendered LimitRange exists, so none is suggested");
  const q = HS.suggestQuota(ns, 0);
  assert.deepStrictEqual(q.hard, { pods: "4", "requests.cpu": "1", "requests.memory": "1Gi" });
  assert.ok(q.notes.some((n) => /limits.cpu left out/.test(n.msg)));
});

t("buildMap: DaemonSet nodes, LimitRange, ResourceQuota", () => {
  const { docs } = HS.splitManifest(`---
# Source: x/templates/a.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata: {name: agent, namespace: ops}
spec:
  template:
    spec:
      containers:
        - name: agent
---
# Source: x/templates/b.yaml
apiVersion: v1
kind: LimitRange
metadata: {name: defaults, namespace: ops}
spec:
  limits:
    - type: Container
      default: {cpu: 200m, memory: 128Mi}
      defaultRequest: {cpu: 50m}
---
# Source: x/templates/c.yaml
apiVersion: v1
kind: ResourceQuota
metadata: {name: q, namespace: ops}
spec:
  hard: {requests.cpu: 100m, limits.memory: 1Gi, pods: "10"}
`);
  const m = HS.buildMap(docs, "default", { nodes: 3 });
  const ns = m.namespaces.find((n) => n.name === "ops");
  const ds = ns.workloads[0];
  assert.ok(ds.replicas.perNode);
  assert.strictEqual(ds.pod.req.cpu, 0.05, "defaultRequest");
  assert.strictEqual(ds.pod.req.memory, 128 * 2 ** 20, "request falls back to defaulted limit");
  assert.deepStrictEqual(ds.pod.fromLR.sort(), ["limits.cpu", "limits.memory", "requests.cpu"]);
  assert.strictEqual(ns.pods, 3);
  const q = (k) => ns.quotas.find((x) => x.key === k);
  assert.ok(q("requests.cpu").over, "150m > 100m");
  assert.ok(!q("limits.memory").over);
  assert.strictEqual(q("pods").used, 3);
});

t("buildTopology: flows, ports, issues", () => {
  const { docs } = HS.splitManifest(rendered);
  const t = HS.buildTopology(docs, "apps");
  const e = (from, to) => t.edges.find((x) => x.from === from && x.to === to);
  assert.deepStrictEqual(e("host/web.tpb.vn", "Ingress/apps/demo-web").labels, ["/", "/api"]);
  assert.deepStrictEqual(e("Ingress/apps/demo-web", "Service/apps/demo-web").labels, [":80", ":http (80)"]);
  assert.deepStrictEqual(e("Route/apps/demo-web-admin", "Service/apps/demo-web").labels, [":http (80)"]);
  assert.deepStrictEqual(e("Service/apps/demo-web", "Deployment/apps/demo-web").labels, ["80→web:8080"]);
  assert.deepStrictEqual(e("Service/apps/demo-redis", "StatefulSet/apps/demo-redis").labels, ["6379→redis:6379"]);
  const host = t.nodes.find((n) => n.id === "host/web.tpb.vn");
  assert.ok(host.tls && host.col === 0);
  assert.ok(t.nodes.find((n) => n.id === "Service/apps/demo-redis").internal);
  assert.ok(t.nodes.find((n) => n.id.startsWith("pods/apps/")).ghost);
  assert.deepStrictEqual(t.issues.map((i) => i.sev), ["warn"]);
  assert.deepStrictEqual(t.unexposed.map((u) => u.name), ["demo-web-cleanup"]);
});

t("buildTopology: broken port references", () => {
  const { docs } = HS.splitManifest(`---
# Source: x/templates/a.yaml
apiVersion: v1
kind: Service
metadata: {name: api}
spec:
  type: NodePort
  selector: {app: api}
  ports: [{port: 80, targetPort: http, nodePort: 30080}]
---
# Source: x/templates/b.yaml
apiVersion: apps/v1
kind: Deployment
metadata: {name: api}
spec:
  template:
    metadata: {labels: {app: api}}
    spec:
      containers: [{name: api, ports: [{name: web, containerPort: 8080}]}]
---
# Source: x/templates/c.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: api}
spec:
  rules:
    - host: api.local
      http:
        paths:
          - path: /
            backend: {service: {name: api, port: {number: 8080}}}
          - path: /legacy
            backend: {service: {name: gone, port: {number: 80}}}
`);
  const t = HS.buildTopology(docs, "default");
  const sev = (s) => t.issues.filter((i) => i.sev === s).map((i) => i.msg);
  assert.strictEqual(sev("error").length, 2);
  assert.ok(sev("error").some((m) => /no container port named "http"/.test(m)));
  assert.ok(sev("error").some((m) => /api:8080, but Service api has no matching port/.test(m)));
  assert.ok(sev("warn").some((m) => /Service gone/.test(m)));
  assert.ok(t.nodes.find((n) => n.id === "expose/default/api" && n.kind === "NodePort"));
  assert.ok(t.edges.find((x) => x.from === "expose/default/api").labels[0] === ":30080→80");
  assert.ok(!t.nodes.find((n) => n.id === "host/api.local").tls);
});

t("provenance", () => {
  const p = HS.provenance([
    { name: "chart", obj: { a: 1, b: { c: 2, d: 3 }, list: [1, 2] } },
    { name: "env", obj: { b: { c: 20 }, list: [9] } },
    { name: "set", obj: { b: { d: null }, e: "x" } },
  ]);
  const row = (k) => p.rows.find((r) => r.path === k);
  assert.strictEqual(row("b.c").value, 20);
  assert.strictEqual(row("b.c").setBy, "env");
  assert.ok(row("b.c").overridden);
  assert.deepStrictEqual(row("list").value, [9]);
  assert.strictEqual(row("b.d"), undefined);
  assert.deepStrictEqual(p.removed, [{ path: "b.d", layer: "set" }]);
  assert.strictEqual(row("e").setBy, "set");
});

t("parseSet", () => {
  assert.deepStrictEqual(HS.parseSet(["a.b=1", "c=true", "d\\.e=x", "# no"]), { a: { b: 1 }, c: true, "d.e": "x" });
});

const chartFiles = {};
(function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, prefix + e.name + "/");
    else chartFiles["web/" + prefix + e.name] = fs.readFileSync(p, "utf8");
  }
})(path.join(td, "charts/web"), "");

t("valueRefs and isReferenced", () => {
  const refs = HS.valueRefs(chartFiles, "web");
  assert.ok(HS.isReferenced(refs, ["image", "tag"]));
  assert.ok(HS.isReferenced(refs, ["resources", "limits", "cpu"]), "toYaml parent counts");
  assert.ok(HS.isReferenced(refs, ["redis", "port"]), "subchart values are prefixed");
  assert.ok(HS.isReferenced(refs, ["migrate", "resources", "requests", "cpu"]));
  assert.ok(!HS.isReferenced(refs, ["unusedKnob"]));
  assert.ok(HS.isReferenced(refs, ["redis", "enabled"]), "subchart toggle");
  const r2 = HS.valueRefs({ "a/Chart.yaml": "dependencies:\n  - name: pg\n    condition: db.enabled,pg.enabled\n" }, "a");
  assert.ok(r2.has("db.enabled") && r2.has("pg.enabled"), "Chart.yaml conditions");
});

t("defines / helpersClosure", () => {
  const defs = HS.defines(chartFiles);
  assert.strictEqual(defs["web.labels"].file, "web/templates/_helpers.tpl");
  const hs = HS.helpersClosure(chartFiles["web/templates/deployment.yaml"], defs, chartFiles).map((h) => h.name);
  assert.deepStrictEqual(hs, ["web.fullname", "web.labels", "web.selectorLabels"]);
});

t("mapLine", () => {
  const tpl = chartFiles["web/templates/deployment.yaml"];
  const lines = tpl.split("\n");
  const hits = HS.mapLine("            - containerPort: 8080", tpl);
  assert.ok(hits.length && lines[hits[0] - 1].includes("containerPort"));
  assert.ok(HS.mapLine("  replicas: 1", tpl).length === 1);
});

t("parseErrors", () => {
  const e = HS.parseErrors('Error: template: web/templates/deployment.yaml:12:20: executing "web/templates/deployment.yaml" at <.Values.x.y>: nil pointer\n');
  assert.strictEqual(e[0].file, "web/templates/deployment.yaml");
  assert.strictEqual(e[0].line, 12);
  const y = HS.parseErrors("Error: YAML parse error on web/templates/svc.yaml: error converting YAML to JSON: yaml: line 7: did not find expected key");
  assert.strictEqual(y[0].file, "web/templates/svc.yaml");
  assert.strictEqual(y[0].renderedLine, 7);
});

t("helmfile state + layers + needs", () => {
  const st = HS.parseHelmfileState(fs.readFileSync(path.join(td, "helmfile-build.yaml"), "utf8"));
  assert.strictEqual(st.error, "");
  assert.strictEqual(st.releases.length, 3);
  const web = st.releases.find((r) => r.name === "web");
  assert.deepStrictEqual(web.needs, ["platform/redis-shared"]);
  const L = HS.releaseLayers(web, { replicaCount: 1, image: { tag: "1.4.0" } });
  const p = HS.provenance(L);
  assert.strictEqual(p.rows.find((r) => r.path === "replicaCount").setBy, "values[1]");
  assert.strictEqual(p.rows.find((r) => r.path === "image.tag").setBy, "set");
  const { depth, missing } = HS.needsLayers(st.releases);
  assert.strictEqual(depth.get("apps/web"), 1);
  assert.deepStrictEqual(missing, [{ from: "apps/worker", to: "apps/queue" }]);
});

console.log(`\n${n} passed`);
