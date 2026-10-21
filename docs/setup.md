# Setting it up

- [Docker](#docker)
- [Compose and Portainer](#compose-and-portainer)
- [Proxmox VE](#proxmox-ve)
- [Updating](#updating)
- [From outside your home: HTTPS](#from-outside-your-home-https)

## Docker

```sh
docker run -d --name plexamp-web -p 8080:80 -v plexamp-web-data:/data \
  -e PLEX_SERVER_URL=http://192.168.1.10:32400 \
  --restart unless-stopped ghcr.io/kamakazedan/plexamp-web:latest
```

Open `http://<your-docker-host>:8080`, choose **Sign in with Plex**, then pick your server and music library. The settings are in [configuration.md](configuration.md).

The volume at `/data` keeps [shared playlists](features.md#shared-playlists) when the container is replaced (by an update, say). Without it everything else works, and the log says shared playlists would be lost.

The image is built, tested and published by GitHub Actions for amd64 and arm64 (a Raspberry Pi 4 or CM4 works well). `latest` is the newest version that passed every test; each version is also tagged with its number (such as `0.15.0`), to stay on one. If pulling fails because the package is private, make it public in the package settings on GitHub, or run `docker login ghcr.io` first.

## Compose and Portainer

[docker-compose.yml](../docker-compose.yml) in this repository is a complete setup, with every setting listed at the top. Fill in the ones you want, then:

```sh
docker compose up -d
```

In Portainer, add a stack and paste the file in (or point the stack at this repository). To build the image from a copy of this repository instead of pulling it, replace its `image:` line with `build: .`.

## Proxmox VE

On your Proxmox VE node's shell, as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
```

Like the [Proxmox VE community scripts](https://github.com/community-scripts/ProxmoxVE), it makes a small unprivileged Debian container (LXC) and installs the player in it, without Docker: nginx and Node.js from Debian, the app from this repository, and hls.js from npm, checked against the registry's checksum. Press Enter for its defaults (the next free ID, 1 core, 512 MB, 4 GB, DHCP on `vmbr0`), or `n` to choose each one, including your Plex and Ollama addresses. It shows what it's about to make and, when it's done, the address to open. It needs Proxmox VE 8 or later, and internet access for the container while it installs. As with any script from the internet that runs as root, [read it](../proxmox/plexamp-web.sh) first.

The script, and the app it installs, come from the repository's `stable` branch: the newest commit that passed every test, as the Docker image is. Settings can be given beforehand, and with `YES=1` it asks nothing:

```sh
CTID=120 PLEX_SERVER_URL=http://192.168.1.10:32400 YES=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
```

| Variable | Default | What it is |
| --- | --- | --- |
| `CTID` | the next free ID | The container's ID. |
| `CT_HOSTNAME` | `plexamp-web` | Its name. |
| `STORAGE` | `local-lvm`, or `local-zfs` | Where its disk goes. |
| `CORES`, `RAM_MB`, `DISK_GB` | `1`, `512`, `4` | Its size. |
| `BRIDGE` | `vmbr0` | Its network bridge. |
| `IP` and `GATEWAY` | `dhcp` | Or a fixed address, such as `IP=192.168.1.50/24 GATEWAY=192.168.1.1`. |
| `PLEX_SERVER_URL`, `OLLAMA_URL`, `OLLAMA_MODEL`, `MUSICBRAINZ_URL` | not set | As in [configuration.md](configuration.md). |
| `TEMPLATE_STORAGE` | `local` | Where the Debian template is kept. |

Then, on the node (or inside the container, without `pct exec <ID> --`):

- **Settings**: `pct exec <ID> -- plexamp-web-settings` opens them in an editor, with the same names as the Docker image's, and restarts the player with them. They're kept in `/etc/plexamp-web/plexamp-web.env`, readable by root only, and shared playlists in `/var/lib/plexamp-web`.
- **Updates**: `pct exec <ID> -- update-plexamp-web` installs the newest tested version, keeping your settings.
- **Logs**: `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f`. With `DEBUG=true`, nginx's requests are in `journalctl -t nginx -f`.

## Updating

- **Docker**: `docker pull ghcr.io/kamakazedan/plexamp-web:latest`, then recreate the container with the same settings and volume (`docker compose pull` then `docker compose up -d` does both). In Portainer: for a stack, **Update the stack** with **Re-pull image and redeploy** on; for a container, **Recreate** with **Re-pull image** on.
- **Proxmox VE**: `pct exec <ID> -- update-plexamp-web`.

What's new is in [CHANGELOG.md](../CHANGELOG.md), and in the app under **Settings › About**.

## From outside your home: HTTPS

The container serves plain HTTP, which on a home network is the same as Plex's own `http://` addresses. To use the player from outside, put it behind a reverse proxy with HTTPS (Nginx Proxy Manager, Caddy, Traefik, a Cloudflare tunnel and the like), so tokens never cross the internet unencrypted. Turn on the proxy's WebSockets support, if it has a switch for it: live updates use them when they can (see [configuration.md](configuration.md#live-updates)).

Behind HTTPS, the browser can't use a Plex server's plain `http://` addresses, so set `PLEX_SERVER_URL`: the player then reaches Plex through the container. Set it too if the player can be reached from the internet: it keeps the container's service (the shared AI model, MusicBrainz checks, Play Together, your devices and shared playlists) to people who can use your Plex server, and Play on to its owner (see [SECURITY.md](../SECURITY.md#remaining-risks)). Signing out also makes the browser forget the artwork it kept, which browsers only do over HTTPS.
