/**
 * R17-082: three more ways to get Branch — a container image, a Nix flake, and Termux on Android.
 * This file is the one place their text is written; the copies in the repository
 * (`packaging/docker/Dockerfile`, `.dockerignore`, `flake.nix`,
 * `packaging/termux/install-branch-termux.sh`) must match it, and a test checks that they do.
 *
 * Nothing here builds or runs anything. They sit beside bucket 22's installers
 * (src/install/unix-bootstrap.ts) and keep the same rules: the program is started as `node
 * dist/cli.js`, the data folder and workspace are named by BRANCH_DATA_DIR and BRANCH_WORKSPACE, no
 * browser or Electron download happens, and nothing runs as root.
 *
 * The engine listens on 127.0.0.1 unless it is told otherwise (mac7/bind, src/listen-address.ts), and
 * the image does not tell it otherwise: nothing here sets BRANCH_LISTEN, so an image built and run as
 * it comes behaves exactly as Branch always has. The run line shows how to ask for the wider door,
 * because a container with no window is the one place the setting cannot be reached from a screen;
 * asking for it still has to get past every refusal in src/listen-address.ts.
 *
 * The ideas are Hermes Agent's Termux, Nix and Docker guides (MIT); these files are written for Branch.
 */
import { nodeFloor, nodeFloor25, nodeFloorMajor } from "../node-floor.js";

export const dockerfilePath = "packaging/docker/Dockerfile";
export const dockerignorePath = ".dockerignore";
export const flakePath = "flake.nix";
export const termuxScriptPath = "packaging/termux/install-branch-termux.sh";

/**
 * The Node major the image and the flake use. `node:24-bookworm-slim` and `pkgs.nodejs_24` both
 * give the newest 24.x, which is above the floor in src/node-floor.ts; the Termux script, which
 * takes whatever Node the phone already has, checks the floor exactly.
 */
export const nodeMajor = nodeFloorMajor;

export function dockerfileText(): string {
  return [
    "# syntax=docker/dockerfile:1",
    "# Branch Agent's container image. Written by src/install/container-files.ts; do not edit by hand.",
    "#   docker build -f packaging/docker/Dockerfile -t branch-agent .",
    "#   docker run -e BRANCH_LISTEN=private-network -p 3210:3210 \\",
    "#     -v branch-data:/data -v branch-work:/workspace branch-agent",
    "# Branch listens on 127.0.0.1 unless you ask for more, and inside a container that address is the",
    "# container's own, so a published port reaches nothing until you do. BRANCH_LISTEN=private-network",
    "# asks for every address the container answers on, which is what makes -p work. It is refused if",
    "# the container can be reached at a public address. Whoever reaches Branch still needs the local",
    "# session token, printed on the first start. See docs/configuration.md before you use it.",
    `FROM node:${nodeMajor}-bookworm-slim AS build`,
    "ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "WORKDIR /src",
    "COPY package.json package-lock.json ./",
    "RUN npm ci --no-audit --no-fund --ignore-scripts",
    "COPY tsconfig.json ./",
    "COPY src ./src",
    "COPY scripts ./scripts",
    "COPY data ./data",
    "COPY docs/handbook ./docs/handbook",
    "COPY public ./public",
    "RUN npm run build && npm prune --omit=dev --ignore-scripts",
    "",
    `FROM node:${nodeMajor}-bookworm-slim`,
    "ENV NODE_ENV=production BRANCH_DATA_DIR=/data BRANCH_WORKSPACE=/workspace \\",
    "    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "RUN groupadd --system branch \\",
    " && useradd --system --gid branch --home-dir /data --shell /usr/sbin/nologin branch \\",
    " && mkdir -p /data /workspace && chown branch:branch /data /workspace",
    "WORKDIR /app",
    "COPY --from=build /src/package.json ./package.json",
    "COPY --from=build /src/node_modules ./node_modules",
    "COPY --from=build /src/dist ./dist",
    "COPY --from=build /src/public ./public",
    "COPY LICENSE README.md THIRD_PARTY_NOTICES.md ./",
    "USER branch",
    'VOLUME ["/data", "/workspace"]',
    "EXPOSE 3210",
    "HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \\",
    `  CMD ["node", "-e", "fetch('http://127.0.0.1:3210/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`,
    'ENTRYPOINT ["node", "dist/cli.js"]',
    'CMD ["start"]',
    "",
  ].join("\n");
}

export function dockerignoreText(): string {
  return [
    "# Written by src/install/container-files.ts. Nothing private or built goes into the image's build.",
    ".git", "node_modules", "dist", "coverage", ".env", ".env.*", ".branch", "workspace",
    "*.log", ".DS_Store", ".claude", "apps", "experiments", "tests", "",
  ].join("\n");
}

export function flakeText(): string {
  return `# Branch Agent as a Nix flake. Written by src/install/container-files.ts; do not edit by hand.
#   nix run github:stabrea/Branch-Agent -- start
#   nix develop        (a shell with Node ${nodeMajor}, whose newest patch is above Branch's floor of ${nodeFloor})
{
  description = "Branch Agent, a local, inspectable personal assistant";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.\${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in {
      packages = forAll (pkgs: {
        default = pkgs.buildNpmPackage {
          pname = "branch-agent";
          inherit version;
          src = self;
          nodejs = pkgs.nodejs_${nodeMajor};
          # The dependency list is read straight from package-lock.json, so no hash has to be kept here.
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmFlags = [ "--ignore-scripts" ];
          env = { ELECTRON_SKIP_BINARY_DOWNLOAD = "1"; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            npm prune --omit=dev --ignore-scripts
            mkdir -p $out/lib/branch-agent $out/bin
            cp -r package.json dist public node_modules LICENSE README.md THIRD_PARTY_NOTICES.md $out/lib/branch-agent/
            makeWrapper \${pkgs.nodejs_${nodeMajor}}/bin/node $out/bin/branch --add-flags $out/lib/branch-agent/dist/cli.js
            runHook postInstall
          '';
          meta = { description = "Branch Agent"; license = pkgs.lib.licenses.mit; mainProgram = "branch"; };
        };
      });
      apps = forAll (pkgs: {
        default = { type = "app"; program = "\${self.packages.\${pkgs.system}.default}/bin/branch"; };
      });
      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_${nodeMajor} pkgs.git ]; };
      });
    };
}
`;
}

/** The Termux lines: checks, Node, the checked package, and what to do next. */
export function termuxScript(): string {
  return [
    "#!/data/data/com.termux/files/usr/bin/sh",
    "# Branch Agent on Android, through Termux. Written by src/install/container-files.ts.",
    "#   sh install-branch-termux.sh <branch-agent-<version>.tgz>     (the file from the release, with its .sha256 beside it)",
    "#   sh install-branch-termux.sh --uninstall",
    "# Conversations and files stay in the folders you started Branch in; nothing else is removed.",
    "set -eu",
    "say() { printf '%s\\n' \"$*\"; }",
    "fail() { printf 'Branch Agent: %s\\n' \"$*\" >&2; exit 1; }",
    'case "${PREFIX:-}" in */com.termux/*) ;; *) fail "This script is for Termux on Android." ;; esac',
    'if [ "${1:-}" = --uninstall ]; then npm uninstall -g branch-agent; say "Branch Agent is removed."; exit 0; fi',
    'PACKAGE="${1:-}"',
    '[ -n "$PACKAGE" ] || fail "Name the branch-agent-<version>.tgz file from the release."',
    'case "$PACKAGE" in *.tgz) ;; *) fail "That is not a branch-agent .tgz file." ;; esac',
    '[ -f "$PACKAGE" ] || fail "$PACKAGE is not here."',
    '[ -f "$PACKAGE.sha256" ] || fail "$PACKAGE.sha256 is missing, so the file cannot be checked. Download it from the same release."',
    'EXPECTED="$(cut -d " " -f 1 < "$PACKAGE.sha256")"',
    'ACTUAL="$(sha256sum "$PACKAGE" | cut -d " " -f 1)"',
    '[ "$EXPECTED" = "$ACTUAL" ] || fail "$PACKAGE does not match its .sha256, so nothing was installed."',
    'if ! command -v node >/dev/null 2>&1; then say "Installing Node.js from Termux..."; pkg install -y nodejs; fi',
    `VERSION="$(node -p 'process.versions.node')"`,
    // The floor is a patch, not a major (see src/node-floor.ts), so the major alone cannot answer it.
    `NEW_ENOUGH="$(node -p '(() => { const [a, b] = process.versions.node.split(".").map(Number);`
      + ` if (a > 25) return "yes"; if (a === 25) return b >= ${Number(nodeFloor25.split(".")[1])} ? "yes" : "no";`
      + ` return a === ${nodeFloorMajor} && b >= ${Number(nodeFloor.split(".")[1])} ? "yes" : "no"; })()')"`,
    `[ "$NEW_ENOUGH" = "yes" ] || fail "Branch needs Node.js ${nodeFloor} or newer (on the Node 25 line, ${nodeFloor25} or newer);`
      + ` this phone has $VERSION. Without it a proxy cannot be used at all. Run: pkg upgrade nodejs"`,
    "ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \\",
    '  npm install -g --omit=dev --ignore-scripts --no-audit --no-fund "$PACKAGE"',
    'say "Branch Agent is installed. Start it with:  cd ~ && branch start"',
    'say "Then open http://127.0.0.1:3210 in a browser on this phone. To keep it running with the screen off: termux-wake-lock"',
    'say "The browser tools and the desktop app are not available on Android; chat apps, the window and schedules are."',
    "",
  ].join("\n");
}

/** Every file, by where it lives in the repository. */
export const containerFiles = (): Record<string, string> => ({
  [dockerfilePath]: dockerfileText(),
  [dockerignorePath]: dockerignoreText(),
  [flakePath]: flakeText(),
  [termuxScriptPath]: termuxScript(),
});
