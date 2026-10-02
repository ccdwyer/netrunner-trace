# Privacy

Netrunner Trace only watches. It runs entirely on your machine and sends nothing over the network. It runs no programs. To name the host behind a remote such as `origin`, it reads git metadata only: the `.git` folder or file, and `config`, `HEAD` and `commondir` inside it.

What it records stays in the current session's memory: the time, the tool, the host and the outcome of each outbound call. It never stores command arguments, URL paths, query strings or headers, so tokens in a command line are not kept. Labels are built only from program and subcommand names.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/netrunner-trace/issues
