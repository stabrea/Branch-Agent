# A minimal image for Branch's shared Linux desktop (FQ-execution.desktop, docs/configuration.md).
#
#   docker build -t branch-linux-desktop:latest docs/examples/linux-desktop
#
# Branch never pulls or builds this itself: it runs whatever image the Settings card names, with
# `--pull=never`, and supplies its own command (`sh -c "Xvfb :1 ... & sleep 1 && x11vnc ..."`), so
# the image only has to carry sh, Xvfb, x11vnc and xdotool. xterm is here so there is something to
# open. This recipe is an example: it is not built or run by the test suite, which uses a fake Docker.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc xdotool xterm \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/sh desktop
USER desktop
WORKDIR /home/desktop
