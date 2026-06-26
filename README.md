<div align="center">

# Anvil

[![Source](https://img.shields.io/badge/Source-hyperronropes%2FAnvil-181717?logo=github)](https://github.com/hyperronropes/Anvil)
[![Discord](https://img.shields.io/discord/0?label=Discord&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/8WU56Drt7F)
[![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)

A desktop AI coding workspace. Streams responses, runs file/shell tools behind a
permission layer, multi-stage reasoning, and an UltraCode agent swarm — all in
an Electron + React GUI.

**Source code:** [github.com/hyperronropes/Anvil](https://github.com/hyperronropes/Anvil) — clone this repo to build from source.

**Community:** [DeepCode Discord](https://discord.gg/8WU56Drt7F) — Anvil has no separate server; ask there for help (fork makers hang out in the same place).

</div>

---

## Upstream

Anvil is a fork of **[DeepCode v3](https://github.com/Schnickenpick/DeepCodev3)** by Schnickenpick.
This repo contains the full modified source. If you distribute a build, link here so others can
verify and compile it themselves.

---

## DISCLAIMER

I am **NOT** responsible for what you do with this tool, or what this tool
does with you. Use at your own risk.

This is a coding agent, not a jailbreak tool — see [Heads up](#heads-up-please-read)
below before asking for one.

---

## Install (pre-built)

Download `Anvil.zip` from [Releases](https://github.com/hyperronropes/Anvil/releases),
extract it, and run `Anvil.exe`.

Share the whole extracted `Anvil` folder — not just the exe.

**Prefer to build yourself?** Clone [this repo](https://github.com/hyperronropes/Anvil) and see [Building](#building) below.

## Run (development)

```sh
cd app && npm install && npm run dev
```

The Python bridge in `server/` starts automatically when you launch the desktop app.

## Building (from source)

Clone the repo, then from the repo root:

```sh
python build_all.py
```

Produces:

- `dist/Anvil/Anvil.exe` — desktop app (bundles Python bridge + model proxy)
- `dist/Anvil.zip` — same folder, zipped for sharing

Requires PyInstaller and GUI deps (`cd app && npm install`).

## Heads up, please read

Anvil is a coding assistant. It is **not** designed to roleplay, bypass
any safety behavior, or act as a general-purpose "jailbreak" tool. If you've got
a feature request or you think the agent is behaving wrong on a *coding* task,
use [GitHub issues](https://github.com/hyperronropes/Anvil/issues) or the
[DeepCode Discord](https://discord.gg/8WU56Drt7F) (shared by DeepCode and forks).

## Notes

- Config and chats live in `~/.Anvil/` (custom instructions: `ANVIL.md`).
- App logs: `~/.Anvil/logs/latest.log` (Settings → Diagnostics → Open).
- Configured against a hosted model gateway (`anvil/src/anvil/api.py`).

## Distributing Anvil (Discord / elsewhere)

If you share a build, include **both** GitHub links so people can verify and compile from source:

- **Anvil source:** https://github.com/hyperronropes/Anvil  
- **Upstream:** https://github.com/Schnickenpick/DeepCodev3  
- **Help / community:** https://discord.gg/8WU56Drt7F (DeepCode Discord — shared by forks, no separate Anvil server)

Pre-built zips also ship `README.md`, `LICENSE`, and `SOURCE.txt` next to `Anvil.exe`.
In-app: **Settings → General → About & source code**.

## Support

- **GitHub issues (Anvil):** https://github.com/hyperronropes/Anvil/issues  
- **Discord (DeepCode community):** https://discord.gg/8WU56Drt7F — no Anvil-only server; fork makers and users share this one.
