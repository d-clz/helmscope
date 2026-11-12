#!/usr/bin/env bash
# Authenticode-signs a Windows binary in place with osslsigncode.
#
# A trusted signature is what corporate AV/EDR and SmartScreen weigh most.
# Use a certificate your organisation trusts: a public code-signing CA, or
# the internal enterprise CA that endpoints already trust.
#
# usage: scripts/sign-windows.sh <file.exe>
# env:   WINDOWS_SIGN_PFX_FILE       path to the .pfx/.p12 (GitLab "File" variable), or
#        WINDOWS_SIGN_PFX_BASE64     the .pfx base64-encoded (GitHub secret)
#        WINDOWS_SIGN_PFX_PASSWORD   its password
#        WINDOWS_SIGN_TIMESTAMP_URL  RFC 3161 TSA. Without one the signature
#                                    stops validating when the cert expires.
#        WINDOWS_SIGN_CA_FILE        optional CA bundle to verify the chain
#        REQUIRE_SIGNING=1           fail instead of skipping when no cert is set
set -euo pipefail

file="${1:?usage: sign-windows.sh <file.exe>}"
[[ -f "$file" ]] || { echo "sign: $file not found" >&2; exit 1; }

if [[ -z "${WINDOWS_SIGN_PFX_FILE:-}" && -z "${WINDOWS_SIGN_PFX_BASE64:-}" ]]; then
  if [[ "${REQUIRE_SIGNING:-0}" == 1 ]]; then
    echo "sign: REQUIRE_SIGNING=1 but no certificate was provided" >&2
    exit 1
  fi
  echo "sign: WARNING no certificate configured; $file stays unsigned" >&2
  exit 0
fi
command -v osslsigncode >/dev/null || { echo "sign: osslsigncode not installed" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pfx="${WINDOWS_SIGN_PFX_FILE:-}"
if [[ -z "$pfx" ]]; then
  pfx="$work/cert.pfx"
  printf '%s' "$WINDOWS_SIGN_PFX_BASE64" | base64 -d > "$pfx"
fi
# password via file so it never shows up in the process list
umask 077
printf '%s' "${WINDOWS_SIGN_PFX_PASSWORD:-}" > "$work/pass"

args=(sign -pkcs12 "$pfx" -readpass "$work/pass" -h sha256
      -n "helmscope" -i "${WINDOWS_SIGN_INFO_URL:-https://github.com/d-clz/helmscope}"
      -in "$file" -out "$work/signed.exe")
if [[ -n "${WINDOWS_SIGN_TIMESTAMP_URL:-}" ]]; then
  args+=(-ts "$WINDOWS_SIGN_TIMESTAMP_URL")
else
  echo "sign: WARNING no WINDOWS_SIGN_TIMESTAMP_URL; signature will stop validating when the certificate expires" >&2
fi
osslsigncode "${args[@]}" >/dev/null
mv "$work/signed.exe" "$file"

if [[ -n "${WINDOWS_SIGN_CA_FILE:-}" ]]; then
  osslsigncode verify -in "$file" -CAfile "$WINDOWS_SIGN_CA_FILE"
else
  # Without the CA bundle the chain can't be checked here; confirm the
  # signature is present and report who signed it.
  osslsigncode extract-signature -in "$file" -out "$work/sig.der" >/dev/null
  openssl pkcs7 -inform DER -in "$work/sig.der" -print_certs -noout 2>/dev/null | grep -m1 '^subject' || true
fi
echo "sign: signed $file"
