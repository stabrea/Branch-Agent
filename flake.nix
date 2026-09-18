# Branch Agent as a Nix flake. Written by src/install/container-files.ts; do not edit by hand.
#   nix run github:stabrea/Branch-Agent -- start
#   nix develop        (a shell with Node 24, whose newest patch is above Branch's floor of 24.14.0)
{
  description = "Branch Agent, a local, inspectable personal assistant";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in {
      packages = forAll (pkgs: {
        default = pkgs.buildNpmPackage {
          pname = "branch-agent";
          inherit version;
          src = self;
          nodejs = pkgs.nodejs_24;
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
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/branch --add-flags $out/lib/branch-agent/dist/cli.js
            runHook postInstall
          '';
          meta = { description = "Branch Agent"; license = pkgs.lib.licenses.mit; mainProgram = "branch"; };
        };
      });
      apps = forAll (pkgs: {
        default = { type = "app"; program = "${self.packages.${pkgs.system}.default}/bin/branch"; };
      });
      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_24 pkgs.git ]; };
      });
    };
}
