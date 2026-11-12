# helmscope

A local, read-only viewer that makes `helm template` output easy to read.
Point it at a folder of charts or helmfiles and it shows:

- **Manifests** grouped by the template that produced them, with labels and
  annotations folded away. Click any line to see the template lines that likely
  produced it.
- **Source** for the template, with every `include`/`template` helper it uses
  (followed transitively) linked to its `define`.
- **Map**: namespaces → workloads (Deployment, StatefulSet, DaemonSet, Job,
  CronJob, …) with a replica badge and requests/limits per pod, × replicas,
  at HPA max, and at the rollout peak. Also shows the ConfigMaps/Secrets/PVCs
  each workload uses and checks any ResourceQuota in the render.
- **Topology**: how a request travels: host → Ingress/Route/HTTPRoute →
  Service port → container port. Broken references (named targetPort with no
  matching container port, backend port missing on the Service, Service that
  selects nothing) are listed above the diagram.
- **Values provenance**: the final value of every key, which layer set it, and
  the values it overrode. Keys that no template reads directly are flagged.
- **Helmfile inventory**: releases for an environment with chart, version,
  `needs`, labels, and a dependency-order graph. Pick a release to render it.

It never talks to a cluster. It runs your own `helm` and `helmfile` binaries,
so the output is exactly what they produce.

## Run

```bash
make build
./bin/helmscope ~/repos/platform-charts      # then open http://127.0.0.1:8088
```

Or grab a prebuilt binary from Nexus:
`$NEXUS_RAW_URL/helmscope/<tag>/helmscope-<os>-<arch>`.

| Flag | Default | Meaning |
|---|---|---|
| `-root` / first arg | `.` | Folder scanned for `Chart.yaml`, `*.tgz`, `helmfile.yaml(.gotmpl)` and `helmfile.d/` |
| `-addr` | `127.0.0.1:8088` | Listen address. There is no auth, so keep it on loopback |
| `-helm` | `helm` (`$HELMSCOPE_HELM`) | helm binary |
| `-helmfile` | `helmfile` (`$HELMSCOPE_HELMFILE`) | helmfile binary |
| `-kube-version` | helm's default (`$HELMSCOPE_KUBE_VERSION`) | Default `--kube-version` for `.Capabilities`, e.g. `1.30.0` for OCP 4.17 |
| `-timeout` | `90s` | Per helm/helmfile call |
| `-cache` | user cache dir | Where `helmfile fetch` puts remote charts |

`helm` and `helmfile` inherit your environment, so `HELM_REPOSITORY_CONFIG`,
`HELM_REGISTRY_CONFIG`, and Nexus credentials work as they do in your shell.

## What it runs

| View | Command |
|---|---|
| Chart render | `helm template <release> <chart> --namespace <ns> -f <your values> --set … --kube-version … --include-crds --debug` |
| Helmfile inventory | `helmfile --file <f> --environment <env> build --embed-values` |
| Release render | `helmfile … --selector name=<r>,namespace=<ns> template --skip-deps [--args --kube-version=…]` |
| Release source | local chart path read in place; otherwise `helmfile … fetch --output-dir <cache>` once, then cached |

The exact command line is shown in the toolbar and the Log tab.

## How to read the results

- **Line mapping is a best guess.** Go templates don't emit a source map, so a
  click matches the rendered key (`containerPort:`) or value against the
  template text. Helpers are listed so you can follow `include` chains.
- **Template errors are exact.** `template: web/templates/x.yaml:12:20` errors
  become links that open the file at that line.
- **Provenance follows Helm's merge rules.** Maps merge, lists replace, and
  `null` deletes a key. The chart layers are subchart `values.yaml` files, then
  the chart's `values.yaml`, then your values, then `--set`. For helmfile it's
  chart defaults, then each `values:` entry in order, then `set:`.
- **"unreferenced?" is a hint.** It means no template has a direct
  `.Values.<path>` (or a parent path). Values read through `with`, `range`,
  `tpl` or `index` show up as unreferenced too. Subchart `enabled` keys and
  `Chart.yaml` `condition:` keys count as referenced.
- **Map numbers follow scheduler rules.** A pod's effective request is
  max(app containers + sidecars, largest init container), so a big migration
  init container can set it. A missing request falls back to the limit, and a
  rendered LimitRange fills in defaults. A trailing `+` on a limit means some
  container has none, so the real ceiling is higher.
- **Replicas** come from `spec.replicas` (default 1) or an HPA targeting the
  workload (min–max). DaemonSets multiply by the node count you set.
  Deployments add `maxSurge` (default 25%) for the rollout peak, which is the
  number a ResourceQuota has to allow.
- **Topology uses the rendered YAML only.** Service → workload comes from
  selector labels against pod template labels. Ports are resolved by name or
  number. Anything referenced but not rendered shows as a dashed node.
- **Secrets from `helm-secrets`/sops** are whatever helmfile renders. Use it on
  environments where that's acceptable, or render without the secrets layer.

## Layout

```text
main.go         flags, embedded UI, server
server.go       path guard, process runner, chart render API
charts.go       chart discovery; loads dir or .tgz charts (nested subchart .tgz too)
helmfile.go     helmfile discovery, build/template/fetch API
web/core.js     pure logic: manifest split, fold, map/resources, topology, provenance, mapping
web/app.js      UI
web/vendor/     js-yaml 4 (MIT), embedded
testdata/       sample chart, fake helm/helmfile used by tests
```

## Test

```bash
make test      # Go: vet + handler tests against fake helm/helmfile
make test-ui   # Node: core.js logic
```

## Status

Tested against the fake `helm`/`helmfile` in `testdata/bin` and in headless
Chrome; not yet against a real helmfile repo. The helmfile flags it uses
(`build --embed-values`, `fetch --output-dir`, global `--skip-deps`,
`--args`) are in helmfile v1's CLI. On helmfile 0.x, check `build --embed-values`
first: without it, values files show as unresolved paths in the layer list.
