[日本語](SECURITY.md)

> This is a translation of [SECURITY.md](SECURITY.md) as of commit dfe60fe. If they differ, the Japanese version is authoritative.

# Reporting vulnerabilities

If you find an exploitable problem, such as account takeover, impersonation, or a way to move someone else's rating, do not write it in a public issue. Report it privately with "Report a vulnerability" on the repository's "Security" tab on GitHub.

Please include:

- The assumptions (what the attacker has and can do) and what happens
- Steps to reproduce. Working attack code is not required
- The related files or sections of [docs/spec.md](docs/spec.md)

What is written in ["Known limitations" in the README](README.en.md#known-limitations) is already known not to be prevented by the current system. Please report it if you can create a worse situation than described there.

Do not include your own or anyone else's recovery words, device requests (strings starting with `nr-device:`), or private keys in the report.
