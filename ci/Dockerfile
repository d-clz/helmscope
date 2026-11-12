# Builder image for .gitlab-ci.yml: Go plus the tools the Windows release needs.
#   docker build -t nexus.tpb.vn:5000/platform/helmscope-builder:go1.24 -f ci/Dockerfile .
#   docker push  nexus.tpb.vn:5000/platform/helmscope-builder:go1.24
# Behind the air gap, point GO_IMAGE at your Nexus mirror and make apt use your
# Debian proxy (e.g. --build-arg APT_MIRROR=http://nexus.tpb.vn/repository/debian).
ARG GO_IMAGE=golang:1.24-bookworm
FROM ${GO_IMAGE}
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends binutils-mingw-w64-x86-64 osslsigncode zip \
 && rm -rf /var/lib/apt/lists/* \
 && x86_64-w64-mingw32-windres --version | head -1 \
 && osslsigncode --version | head -1
ENV CGO_ENABLED=0 GOPROXY=off GOFLAGS=-trimpath
