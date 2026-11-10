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

Open `http://<your-docker-host>:8080`, choose **Sign in with Plex**, then pick your server and music library. Settings: [configuration.md](configuration.md).

- **The `/data` volume** keeps shared playlists, account settings, Missing tracks and MusicBrainz answers when the container is replaced (by an update, say). Everything else works without it, and the log says what would be lost.
- **The image** is built for amd64 and arm64 (a Raspberry Pi 4 or CM4 works well). It's published only once it has passed every test.
- **Tags**: `latest` is the newest tested version. Each version has its own tag too (`0.39.0`), to stay on one.
- **"Denied" pulling the image**: make the package public in its settings on GitHub, or run `docker login ghcr.io` first.

## Compose and Portainer

[docker-compose.yml](../docker-compose.yml) is a complete setup, with every setting in it. Fill in the ones you want, then:

```sh
docker compose up -d
```

In Portainer, add a stack and paste the file in (or point the stack at this repository). To build from a copy of this repository instead, replace the `image:` line with `build: .`.

## Proxmox VE

In your Proxmox VE node's shell, as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
```

It makes a small unprivileged Debian container (LXC) and installs the player in it, without Docker, like the [Proxmox VE community scripts](https://github.com/community-scripts/ProxmoxVE).

- Press Enter for the defaults (the next free ID, 1 core, 512 MB, 4 GB, DHCP on `vmbr0`), or `n` to choose each one, your Plex and Ollama addresses included.
- When it's done, it shows the address to open.
- It needs Proxmox VE 8 or later, and internet access for the container while it installs.
- It installs from the `stable` branch: the newest commit that passed every test.
- As with any script from the internet that runs as root, [read it](../proxmox/plexamp-web.sh) first.

To set everything beforehand, without questions:

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
| `IP`, `GATEWAY` | `dhcp` | Or a fixed address: `IP=192.168.1.50/24 GATEWAY=192.168.1.1`. |
| `PLEX_SERVER_URL`, `OLLAMA_URL`, `OLLAMA_MODEL`, `MUSICBRAINZ_URL` | not set | As in [configuration.md](configuration.md). |
| `TEMPLATE_STORAGE` | `local` | Where the Debian template is kept. |
| `YES` | not set | `1`: ask nothing, use the defaults and what's set. |
| `PW_VERBOSE` | not set | `1`: show every step in detail. |

Then, on the node:

| To | Run |
| --- | --- |
| Change settings (opens an editor, then restarts the player) | `pct exec <ID> -- plexamp-web-settings` |
| Update | `pct exec <ID> -- update-plexamp-web` |
| Update, showing every step | `pct exec <ID> -- update-plexamp-web --verbose` |
| Follow the log | `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f` |
| Save today's log to a file | `pct exec <ID> -- journalctl -u plexamp-web --since today -o short-iso --no-pager > plexamp-web.log` |

- Settings are kept in `/etc/plexamp-web/plexamp-web.env` (root only), with the same names as the Docker image's. Data is in `/var/lib/plexamp-web`.
- An update keeps your settings, and upgrades the container's Debian packages for their security fixes. If the new version doesn't start, the old one is put back, and it says why.
- With `DEBUG=true`, nginx's requests are in `pct exec <ID> -- journalctl -t nginx -f`.

## Updating

- **Docker**: `docker pull ghcr.io/kamakazedan/plexamp-web:latest`, then recreate the container with the same settings and volume.
- **Compose**: `docker compose pull`, then `docker compose up -d`.
- **Portainer**: for a stack, **Update the stack** with **Re-pull image and redeploy** on; for a container, **Recreate** with **Re-pull image** on.
- **Proxmox VE**: `pct exec <ID> -- update-plexamp-web`.

What's new is in [CHANGELOG.md](../CHANGELOG.md), and in the app under **Settings › About**. If the container doesn't start after an update, its log says which setting to change, and how.

## From outside your home: HTTPS

The player serves plain HTTP, like Plex's own `http://` addresses on a home network. To use it from outside:

1. Put it behind a reverse proxy with HTTPS (Nginx Proxy Manager, Caddy, Traefik, a Cloudflare tunnel and the like), so sign-ins never cross the internet unencrypted.
2. Turn on the proxy's WebSockets support, if it has a switch for it (see [Live updates](configuration.md#live-updates)).
3. Set `PLEX_SERVER_URL`. Behind HTTPS, browsers can't use Plex's plain `http://` addresses, so they go through the player. It also keeps the player's shared features (the AI model, Play Together, shared playlists and the rest) to people who can use your Plex server.

Signing out also makes the browser forget the artwork it kept, which browsers only do over HTTPS.
