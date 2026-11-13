# helmscope

A local, read-only viewer that makes `helm template` output easy to read.
Point it at a folder of charts or helmfiles and it shows:

- **Manifests** grouped by the template that produced them, with labels and
  annotations folded away. Click any line to see the template lines that likely
  produced it.
- **Source** for the template, with every `include`/`template` helper it uses
  (followed transitively) linked to its `define`.
- **Map**: every rendered manifest as a card, grouped by namespace, like
  Headlamp's map: kind, name, a one-line summary (Service ports, Ingress hosts,
  PVC size, HPA range…), a replica badge on workloads, and a status dot when
  something needs a look. Filter by category or by status. Above the cards, a
  **Resources** panel shows:
  - per-workload QoS, pods, and requests/limits per pod and × replicas
  - namespace totals at current replicas, HPA max, and the rollout peak, plus
    PVC storage
  - notes (missing requests/limits, BestEffort pods, init containers that set
    the pod request, `spec.replicas` fighting an HPA)
  - a suggested ResourceQuota (rollout peak + adjustable headroom) and, when
    containers rely on defaults, a suggested LimitRange, ready to copy
- **Topology**: how a request travels: host → Ingress/Route/HTTPRoute →
  Service port → container port. Broken references (named targetPort with no
  matching container port, backend port missing on the Service, Service that
  selects nothing) are listed above the diagram.
- **Values provenance**: the final value of every key, which layer set it, and
  the values it overrode. Keys that no template reads directly are flagged.
- **Helmfile inventory**: releases for an environment with chart, version,
  `needs`, labels, and a dependency-order graph. Filter by namespace (click a
  chip to toggle, Shift+click or a namespace band to show only that one) or by
  name, and group the table, graph and sidebar by namespace. The filter is
  remembered per helmfile and environment. Pick a release to render it.
  The inventory's **Map** and **Topology** tabs render every release in the
  filter and merge the results, so totals, the ResourceQuota suggestion and
  Service → pod links cover a whole namespace, not one release. A single
  release's Map shows its own share and links to the namespace view for the
  quota. `installed: false` releases are left out.

It never talks to a cluster. It runs your own `helm` and `helmfile` binaries,
so the output is exactly what they produce.

## Run

```bash
make build
./bin/helmscope ~/repos/platform-charts      # then open http://127.0.0.1:8088
```

Or grab a prebuilt release from GitHub Releases or Nexus
(`$NEXUS_RAW_URL/helmscope/<tag>/`): one archive each for Linux, macOS
(universal: Intel and Apple Silicon) and Windows. See [Releases](#releases).

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
- **Quota suggestion** = rollout peak × (1 + headroom), rounded up. `limits.*`
  is left out while any container lacks a limit, because that quota would make
  the API reject those pods. If no LimitRange is rendered and containers lack
  values, a LimitRange is suggested (largest limits and smallest requests
  already in the namespace) and the quota is sized as if it were applied.
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
tools/lipo/     merges darwin amd64 + arm64 into one universal binary
scripts/        winres (exe metadata), sign-windows, package, verify-windows.ps1
build/windows/  exe manifest and icon
ci/Dockerfile   builder image for the GitLab pipeline
```

## Test

```bash
make test      # Go: vet + handler tests against fake helm/helmfile
make test-ui   # Node: core.js logic
```

## Releases

`make release VERSION=v1.2.3` builds three portable archives in `dist/`, with
no downloads (`GOPROXY=off`), and the output is reproducible:

| Archive | Contents |
|---|---|
| `helmscope_<v>_linux_amd64.tar.gz` | static binary |
| `helmscope_<v>_darwin_universal.tar.gz` | one binary for Intel and Apple Silicon, merged by `tools/lipo` (no Mac needed) |
| `helmscope_<v>_windows_amd64.zip` | `helmscope.exe` with version info, manifest and icon; Authenticode-signed when a certificate is configured |
| `SHA256SUMS` | hashes of the archives **and** the bare binaries |

Build needs: Go, `zip`, `x86_64-w64-mingw32-windres` (`binutils-mingw-w64-x86-64`),
and `osslsigncode` for signing. `ci/Dockerfile` bakes them into a builder image.

CI runs the same make targets:
- **GitHub** (`.github/workflows/release.yml`): test → build → verify on Linux,
  macOS and Windows (Windows: version info, Authenticode status, a run, and a
  Microsoft Defender scan) → on a `v*` tag, a GitHub release with build
  provenance attestations.
- **GitLab** (`.gitlab-ci.yml`): test → build → optional verify on your own
  Windows runner → on a tag, upload to Nexus raw.

### Getting `helmscope.exe` past corporate security tools

Unsigned Go executables get flagged by AV/EDR heuristics fairly often. The build
does what it can on its own; the rest needs your security team.

What the build does:
- **Version info, manifest and icon** (`scripts/winres.sh`): publisher,
  description and version show in Properties, and the manifest declares
  `asInvoker`, so it never asks for elevation. A bare exe with no metadata
  scores worse.
- **No packing or obfuscation**: no UPX or garble, both of which are classic
  malware traits. The Windows binary also keeps its symbol table (no `-s -w`).
- **Console app on loopback**: it listens on `127.0.0.1` by default, so no
  firewall prompt, and it only starts the `helm`/`helmfile` you already have.
- **Reproducible builds and hashes**: `SHA256SUMS` lists the exe's own hash,
  and anyone can rebuild the tag and get the same bytes.
- **Defender scan in CI**: `scripts/verify-windows.ps1` fails the build if
  Defender flags the release.

What actually gets it through, in order of effect:
1. **Sign it** with a certificate your endpoints trust: your enterprise CA's
   code-signing certificate, or a public one (EV or OV). Set:
   - GitHub: secrets `WINDOWS_SIGN_PFX_BASE64` (`base64 -w0 cert.pfx`) and
     `WINDOWS_SIGN_PFX_PASSWORD`; variable `WINDOWS_SIGN_TIMESTAMP_URL`
   - GitLab: File variable `WINDOWS_SIGN_PFX_FILE`, plus
     `WINDOWS_SIGN_PFX_PASSWORD` and `WINDOWS_SIGN_TIMESTAMP_URL` (use an
     internal TSA behind the air gap)

   Always timestamp, or the signature stops validating when the certificate
   expires. Set `WIN_COMPANY` to the certificate's organisation so the
   publisher and CompanyName match. Set `REQUIRE_WINDOWS_SIGNING=true` once
   the certificate is in place, so a tag can't ship unsigned.
2. **Allowlist** the signing certificate (better: it covers every future
   release) or the exe's SHA-256 from `SHA256SUMS` in your EDR.
3. **Test on a managed machine** before announcing a release: set
   `WINDOWS_RUNNER_TAG` in GitLab to run `verify:windows` on a corporate
   Windows runner, or run `scripts/verify-windows.ps1 -Zip <zip>` on a laptop.
4. If Defender itself flags it, submit the file as a false positive at
   https://www.microsoft.com/wdsi/filesubmission.

macOS: the binary is ad-hoc signed by the Go linker but not notarized, so a
browser download is quarantined. Run `xattr -d com.apple.quarantine helmscope`
once, or download it with `curl`. Notarizing needs an Apple Developer account.

## Status

Tested against the fake `helm`/`helmfile` in `testdata/bin` and in headless
Chrome; not yet against a real helmfile repo. The helmfile flags it uses
(`build --embed-values`, `fetch --output-dir`, global `--skip-deps`,
`--args`) are in helmfile v1's CLI. On helmfile 0.x, check `build --embed-values`
first: without it, values files show as unresolved paths in the layer list.
