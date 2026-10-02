# Netrunner Trace

![Netrunner Trace demo](media/demo.gif)

[Watch the MP4](https://github.com/ccdwyer/claude-mods/raw/main/media/netrunner-trace.mp4) · [Screenshot](media/03-trace-after.png) · [Screenshot](media/01-trace-open.png)

A live node map of the hosts your agent's tool calls reach. Your machine sits in the centre of a radar; every remote host a call is aimed at (github.com, registry.npmjs.org, pypi.org, MCP servers, anything else) is a node on the ring. When a call goes out, a packet flies along the edge in braille sub-pixels at 30 fps and comes back green or red. A sweep turns, first-contact hosts pulse amber, and hosts you didn't expect are drawn red.

It is also a useful security view: a running log of what each tool call was aimed at, from which tool, to which host, and whether it worked. Observation only; it never blocks or changes a call.

It reads the tool calls, not the network: hosts are inferred from command lines, URLs and git config. That catches the destinations you'd want to know about (an unexpected registry, a proxy, a jump host, a `curl` to somewhere new), but it is best effort, not packet capture.

## Use

- `/trace` opens the map pane (it runs mid-turn too).
- `/trace hosts` prints a summary: every host, call counts, failures, and which were unexpected.
- `/trace allow <host>` marks a host as expected for the rest of the session.
- `/trace clear` resets the session's trace.
- A one-line ticker above the prompt shows the last few hosts (turn it off in the plugin settings).

## What counts as outbound

- **Bash**, for programs that actually dial out:
  - `curl`/`wget` (URL and bare-host operands, `-x`/`--proxy`)
  - `gh` (honours `GH_HOST`; `gh help`/`config`/`alias` don't count)
  - `git push/pull/fetch/clone/ls-remote/remote update`: remotes are resolved from the repository's config after the command runs, following `cd`, `git -C`, worktrees and submodules (`.git` files), `pushurl` for pushes, the branch's remote for a bare `git push`, and `--all`. `git -c http.proxy=…` is recorded too.
  - `npm/pnpm/yarn/bun/npx` (`--registry`, `NPM_CONFIG_REGISTRY`, `YARN_REGISTRY`, tarball URLs)
  - `pip/uv/poetry/pipx` (`--index-url`, `--extra-index-url`, `--find-links`, `PIP_INDEX_URL` and friends, wheel URLs)
  - `conda`, `brew`, `docker`/`podman` pull/push/login/run, `cargo` (`--git`), `go get/install` (`GOPROXY`, including direct fetches), `gem` (`--source`), `bundle`, `pod`
  - `ssh/scp/sftp/rsync/mosh` (including `-J` jump hosts, `ProxyJump`, and `-L`/`-R`/`-W` forward targets), `nc/ncat/socat/telnet`
  - `aws`, `gcloud`, `az`, `kubectl`/`helm` (`--server`), `terraform`
  - interpreters and URL-taking tools (`python`, `node`, `psql`, `mongosh`, `redis-cli`, `ffmpeg`, `yt-dlp`, …)
  - proxies set in the command (`ALL_PROXY`, `HTTPS_PROXY`, …)
- Commands inside `$( … )`, backticks, `bash -c "…"` and `env -S` are read too. Wrappers (`sudo -u x`, `env -u X`, `nice -n 10`, `timeout`, `xargs`) are seen through.
- Text that only mentions a URL is not traffic: `echo`, `grep`, `cat`, commit messages and heredoc bodies are ignored.
- **WebFetch** (the URL's host) and **WebSearch**.
- **MCP tools** appear as `mcp:<server>`, drawn purple, with destination unknown: the mod can't see where a server connects.

Colours:
- **Green:** expected host.
- **Red:** unexpected host.
- **Orange:** expected host whose last call failed.
- **Grey:** loopback (`localhost`, `127.0.0.1`, `::1`) and unresolved remotes. These never count as unexpected.

Expected hosts: GitHub, npm, Yarn, PyPI, Anaconda, crates.io, the Go proxy, RubyGems, Homebrew, Docker Hub, GHCR, CocoaPods and Anthropic, plus anything in the plugin's **Expected hosts** setting or added with `/trace allow`. Entries can be `corp.com`, `*.corp.com` or a URL; subdomains count.

Unexpected hosts are always pinned on the map, in the ticker and in a list above the map. When there are more than 16 hosts, the rest are counted as "+N more hosts".

Limits:
- A host hidden in a shell variable or a script file isn't seen.
- `kubectl` without `--server` shows as `kube-apiserver`.
- Network traffic a program starts on its own isn't seen, for example a test suite that downloads fixtures.

## Look

The map needs a terminal; on the desktop app the pane shows the same hosts and log as text. Wider terminals get a bigger radar.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install netrunner-trace@ccdwyer-mods
/reload-plugins
```

## What it hooks

- `session.start`, `session.end`
- `command.run{command=trace}`
- `tool.call` (observes; never refuses or rewrites a call)
- `ui.render{component=Pane, requestId=netrunner-trace}`
- `ui.render{component=AbovePrompt}` (composes with other mods' bands)

Engine calls it makes: `$.clock.every`, `$.clock.now`, `$.command.register`, `$.fs.read` and `$.fs.stat` (git metadata only: `.git`, `config`, `HEAD`, `commondir`), `$.session.cwd`, `$.state.get`, `$.state.set`, `$.ui.blit`, `$.ui.open`, `$.ui.resolve`.

## Privacy

Runs entirely on your machine and sends nothing over the network. It never stores command arguments, URL paths, query strings or headers. Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
