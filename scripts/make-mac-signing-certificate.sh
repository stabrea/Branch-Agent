#!/bin/bash
# Make the certificate that keeps Branch Agent's macOS permissions across updates.
#
# Branch's Mac download is sealed ad-hoc today, which makes the app's identity a hash of its own
# contents. Every update is therefore a different app to macOS, and the owner has to grant
# microphone, screen recording and accessibility all over again. Signing with a certificate makes the
# identity "this bundle identifier, signed by this certificate", which does not move between builds.
#
# The certificate is made here, not bought: it costs nothing and it fixes the permissions completely.
# It does NOT quieten Gatekeeper. The first-open warning is exactly the same as today's, and only a
# paid Apple Developer ID removes it. See docs/desktop.md.
#
# Run it once, on the owner's Mac:
#
#   bash scripts/make-mac-signing-certificate.sh [output-directory]
#
# It asks for a passphrase for the exported .p12 and never sees it otherwise: the passphrase is typed
# straight into openssl and security, never passed on a command line, never printed, never written to
# a file. The private key file is erased as soon as it is inside the .p12. Nothing is added to the
# login keychain, nothing is trusted, and nothing is uploaded; storing the result is step 5 below and
# is the owner's to do.
set -euo pipefail

OUT="${1:-$HOME/branch-signing}"
NAME="${BRANCH_SIGNING_NAME:-Branch Agent Signing}"
ORG="${BRANCH_SIGNING_ORG:-KeepOak}"
BUNDLE_ID="com.keepoak.branch-agent"

command -v openssl >/dev/null || { echo "openssl is needed and was not found." >&2; exit 1; }
command -v security >/dev/null || { echo "This script only runs on macOS." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/branch-signing.XXXXXX")"
KEYCHAIN="$WORK/verify.keychain-db"
cleanup() {
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
chmod 700 "$WORK"
mkdir -p "$OUT"

# A complete configuration of our own, so this does not depend on which openssl.cnf the Mac has.
# The shape is the one macOS wants from a code-signing certificate: a self-issued root (CA:true) that
# may sign code, valid for twenty years so a signature made today still verifies for a long time.
cat > "$WORK/cert.cnf" <<CONFIG
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3

[dn]
CN = $NAME
O = $ORG

[v3]
basicConstraints = critical,CA:true
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
CONFIG

umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -noenc \
  -keyout "$WORK/signing.key" -out "$WORK/signing.crt" -config "$WORK/cert.cnf" 2>/dev/null ||
  openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
    -keyout "$WORK/signing.key" -out "$WORK/signing.crt" -config "$WORK/cert.cnf"
chmod 600 "$WORK/signing.key"

# OpenSSL 3 writes a PKCS#12 that macOS refuses with "MAC verification failed"; -legacy fixes it.
# LibreSSL (what /usr/bin/openssl is) has no such flag and does not need one.
LEGACY=()
case "$(openssl version)" in OpenSSL\ 3*|OpenSSL\ 4*) LEGACY=(-legacy);; esac

echo "Choose a passphrase for the exported certificate. You will type it three times in all:"
echo "once to set it, once to confirm, and once when it is imported to check it works."
openssl pkcs12 -export "${LEGACY[@]}" -inkey "$WORK/signing.key" -in "$WORK/signing.crt" \
  -name "$NAME" -out "$OUT/branch-signing.p12"
chmod 600 "$OUT/branch-signing.p12"
rm -f "$WORK/signing.key"
cp "$WORK/signing.crt" "$OUT/branch-signing.crt"

# Check the .p12 really imports and really signs, in a keychain that exists for the next few seconds
# only. The login keychain is not touched, the keychain search list is not changed, and no trust
# setting is changed anywhere: an untrusted certificate signs perfectly well when it is named by its
# SHA-1, which is how the build names it.
KEYCHAIN_PASSWORD="$(uuidgen)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$OUT/branch-signing.p12" -k "$KEYCHAIN" -T /usr/bin/codesign -f pkcs12
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1
# `find-identity -v` hides an untrusted certificate, so ask without it.
security find-identity -p codesigning "$KEYCHAIN" | grep -F "$NAME" >/dev/null ||
  { echo "The certificate did not import as a signing identity." >&2; exit 1; }

SHA1="$(openssl x509 -in "$OUT/branch-signing.crt" -noout -fingerprint -sha1 | tr -d ':' | cut -d= -f2)"

cat <<REPORT

The certificate is made and it works.

  certificate   $OUT/branch-signing.crt
  private key   $OUT/branch-signing.p12   (keep this secret)
  SHA-1         $SHA1
  bundle id     $BUNDLE_ID   (never change it: it is half of the app's identity)

Neither the passphrase nor the private key was printed, and the temporary keychain is now gone.

What to do next, in order:

  1. Put the .p12 and its passphrase in Bitwarden. Losing them is not fatal, but making a new
     certificate changes the app's identity, which costs every user one more permission prompt:

       ~/.local/bin/bw-claude create attachment --file "$OUT/branch-signing.p12" --itemid <item-id>
       ~/.local/bin/bw-claude edit item <item-id>     # put the passphrase in the item's password

     (Create the item first with \`bw-claude create item\`, or add the attachment to an existing
     "Branch Agent signing" login item. Nothing here uploads anything for you.)

  2. Add three repository secrets on GitHub (Settings, Secrets and variables, Actions):

       MAC_SIGNING_P12_BASE64     base64 -i "$OUT/branch-signing.p12" | pbcopy
       MAC_SIGNING_P12_PASSWORD   the passphrase you just chose
       MAC_SIGNING_SHA1           $SHA1

  3. Delete the .p12 from this folder once both copies exist, or leave it and keep the folder private.
     It is already readable only by you.

  4. The first release built with it asks every user for microphone, screen recording and
     accessibility one last time. Say so in that release's notes. Every update after it is silent.

  5. macOS still warns the first time the app is opened, exactly as it does today. The way through is
     System Settings, Privacy & Security, scroll to Branch Agent, Open Anyway, Open. Once per
     install, not once per update. Only a paid Apple Developer ID removes that warning.
REPORT
